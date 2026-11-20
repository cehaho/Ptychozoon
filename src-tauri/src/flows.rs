//! Backup flows: a logical overlay on the topology, from the machine that is
//! backed up to the one that stores the copy. They are not cables and play no
//! part in the parent / failover logic.
//!
//! Each flow can be checked: the check finds when the last good backup ran,
//! and the flow is `ok` while that is younger than `maxAgeHours`, `late`
//! after, `failed` when the check reports a failure, and `unknown` when it
//! cannot tell. Three kinds of check:
//!
//! - `folder`: newest modification time under a folder, over SSH. The app
//!   builds the command itself; the path is quoted and validated.
//! - `command`: a command of the user's, over SSH. It prints the date of the
//!   last good backup (Unix time or ISO date), or `FAILED ...`. It runs only
//!   once approved on this computer (see `approved_commands.json`), so a
//!   topology file from elsewhere cannot run commands with the stored
//!   passwords.
//! - `http`: a GET whose body (or one JSON field of it) is that date.
//!
//! Keep the model aligned with `renderer/js/flows.js`.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::{Map, Value, json};
use tauri::AppHandle;

const NAME_LIMIT: usize = 80;
const LABEL_LIMIT: usize = 40;
const PATH_LIMIT: usize = 512;
const COMMAND_LIMIT: usize = 1000;
const URL_LIMIT: usize = 2048;
const FIELD_LIMIT: usize = 120;
const DEFAULT_MAX_AGE_HOURS: u64 = 26;
const MAX_AGE_HOURS: u64 = 24 * 366;
const DEFAULT_DEPTH: u64 = 2;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_BODY_LIMIT: usize = 256 * 1024;
const CHECK_LIMIT: usize = 8;

// ---------------------------------------------------------------- model

/// The flows of a document, cleaned: flows whose ends are not nodes of
/// `node_ids` are dropped, unknown fields are dropped, values are clamped.
pub fn normalize_flows(value: Option<&Value>, node_ids: &HashSet<String>) -> Vec<Value> {
    let Some(Value::Array(raw)) = value else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut flows = Vec::new();
    for (index, item) in raw.iter().enumerate() {
        let Some(flow) = normalize_flow(item, index, node_ids) else {
            continue;
        };
        let id = flow["id"].as_str().unwrap_or("").to_string();
        if seen.insert(id) {
            flows.push(flow);
        }
    }
    flows
}

pub fn check_flows(value: Option<&Value>) -> Result<(), String> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(items)) if items.iter().all(Value::is_object) => Ok(()),
        Some(_) => Err("Configuration flows must be an array of objects".to_string()),
    }
}

fn normalize_flow(item: &Value, index: usize, node_ids: &HashSet<String>) -> Option<Value> {
    let object = item.as_object()?;
    let source = text(object.get("sourceNodeId"), 128)?;
    let target = text(object.get("targetNodeId"), 128)?;
    if source == target || !node_ids.contains(&source) || !node_ids.contains(&target) {
        return None;
    }
    let id = text(object.get("id"), 128).unwrap_or_else(|| format!("flow_migrated_{index}"));
    let max_age = object
        .get("maxAgeHours")
        .and_then(Value::as_f64)
        .filter(|hours| hours.is_finite() && *hours >= 1.0)
        .map_or(DEFAULT_MAX_AGE_HOURS, |hours| {
            (hours.round() as u64).min(MAX_AGE_HOURS)
        });
    let check = normalize_check(object.get("check"), &target, node_ids);
    Some(json!({
        "id": id,
        "name": text(object.get("name"), NAME_LIMIT).unwrap_or_default(),
        "sourceNodeId": source,
        "targetNodeId": target,
        "tool": text(object.get("tool"), LABEL_LIMIT).unwrap_or_default(),
        "schedule": text(object.get("schedule"), LABEL_LIMIT).unwrap_or_default(),
        "maxAgeHours": max_age,
        "check": check,
    }))
}

fn normalize_check(value: Option<&Value>, target: &str, node_ids: &HashSet<String>) -> Value {
    let Some(Value::Object(check)) = value else {
        return json!({ "type": "none" });
    };
    let node_id = text(check.get("nodeId"), 128)
        .filter(|id| node_ids.contains(id))
        .unwrap_or_else(|| target.to_string());
    match check.get("type").and_then(Value::as_str) {
        Some("folder") => {
            let depth = check
                .get("depth")
                .and_then(Value::as_u64)
                .map_or(DEFAULT_DEPTH, |depth| depth.clamp(1, 5));
            json!({
                "type": "folder",
                "nodeId": node_id,
                "path": text(check.get("path"), PATH_LIMIT).unwrap_or_default(),
                "depth": depth,
            })
        }
        Some("command") => json!({
            "type": "command",
            "nodeId": node_id,
            "command": raw_text(check.get("command"), COMMAND_LIMIT).unwrap_or_default(),
        }),
        Some("http") => json!({
            "type": "http",
            "url": text(check.get("url"), URL_LIMIT).unwrap_or_default(),
            "field": text(check.get("field"), FIELD_LIMIT).unwrap_or_default(),
        }),
        _ => json!({ "type": "none" }),
    }
}

/// Trimmed single-line text, without control characters, at most `limit`.
fn text(value: Option<&Value>, limit: usize) -> Option<String> {
    let clean: String = value?
        .as_str()?
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(limit).collect())
}

/// A command keeps its newlines and tabs; other control characters go.
fn raw_text(value: Option<&Value>, limit: usize) -> Option<String> {
    let clean: String = value?
        .as_str()?
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() || trimmed.chars().count() > limit {
        return None;
    }
    Some(trimmed.to_string())
}

// ---------------------------------------------------------------- folder check

/// A folder the check may name: absolute, no quote, no control character.
pub fn is_safe_folder(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= PATH_LIMIT
        && !path.contains('\'')
        && !path.chars().any(char::is_control)
}

/// POSIX shell command printing the newest modification time (Unix seconds)
/// of the folder and what lies under it, `depth` levels down. GNU find has
/// `-printf`; BusyBox and BSD fall back to `stat`.
pub fn folder_command(path: &str, depth: u64) -> Option<String> {
    if !is_safe_folder(path) {
        return None;
    }
    let depth = depth.clamp(1, 5);
    Some(format!(
        "p='{path}'; [ -d \"$p\" ] || {{ echo \"FAILED folder not found: $p\"; exit 0; }}; \
         {{ find \"$p\" -maxdepth {depth} -printf '%T@\\n' 2>/dev/null \
         || find \"$p\" -maxdepth {depth} -exec stat -c %Y {{}} + 2>/dev/null \
         || find \"$p\" -maxdepth {depth} -exec stat -f %m {{}} + 2>/dev/null; }} \
         | sort -n | tail -n 1"
    ))
}

// ---------------------------------------------------------------- verdict

#[derive(Debug, PartialEq)]
pub enum Reading {
    /// Time of the last good backup.
    At(DateTime<Utc>),
    /// The check says the backup failed; the text says why.
    Failed(String),
}

/// What a check printed: the last non-empty line is a Unix time (seconds,
/// or milliseconds), an ISO / RFC 3339 date (local time when it has no
/// offset), or `FAILED` / `ERROR` and a reason.
pub fn parse_reading(output: &str) -> Result<Reading, String> {
    let line = output
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .ok_or_else(|| "The check printed nothing".to_string())?;
    let upper = line.to_ascii_uppercase();
    for word in ["FAILED", "FAIL", "ERROR"] {
        if upper.starts_with(word) {
            let reason = line[word.len()..]
                .trim_start_matches([':', ' ', '-'])
                .trim();
            let reason = if reason.is_empty() {
                "The check reported a failure"
            } else {
                reason
            };
            return Ok(Reading::Failed(clip(reason, 200)));
        }
    }
    parse_time(line)
        .map(Reading::At)
        .ok_or_else(|| format!("Not a date: {}", clip(line, 80)))
}

pub fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    let text = text.trim().trim_matches('"');
    if let Ok(number) = text.parse::<f64>() {
        if !number.is_finite() || number <= 0.0 {
            return None;
        }
        let seconds = if number > 1e11 {
            number / 1000.0
        } else {
            number
        };
        return Utc.timestamp_opt(seconds.trunc() as i64, 0).single();
    }
    if let Ok(date) = DateTime::parse_from_rfc3339(text) {
        return Some(date.with_timezone(&Utc));
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|date| date.with_timezone(&Utc));
        }
    }
    if let Ok(day) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Local
            .from_local_datetime(&day.and_hms_opt(0, 0, 0)?)
            .earliest()
            .map(|date| date.with_timezone(&Utc));
    }
    None
}

/// `ok` while the last backup is younger than `max_age_hours`, else `late`.
pub fn verdict(reading: &Reading, max_age_hours: u64, now: DateTime<Utc>) -> &'static str {
    match reading {
        Reading::Failed(_) => "failed",
        Reading::At(at) => {
            let age = now.signed_duration_since(*at);
            if age.num_seconds() <= (max_age_hours as i64) * 3600 {
                "ok"
            } else {
                "late"
            }
        }
    }
}

/// The value at a dotted path (`data.0.last`) of a JSON document.
pub fn json_field<'a>(document: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .filter(|part| !part.is_empty())
        .try_fold(document, |value, part| match value {
            Value::Object(map) => map.get(part),
            Value::Array(items) => part.parse::<usize>().ok().and_then(|i| items.get(i)),
            _ => None,
        })
}

fn clip(text: &str, limit: usize) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    if clean.chars().count() <= limit {
        return clean;
    }
    let mut cut: String = clean.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

// ---------------------------------------------------------------- approvals

fn approvals_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::config::config_path(app)?.with_file_name("approved_commands.json"))
}

fn read_approvals(app: &AppHandle) -> Vec<Value> {
    approvals_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|value| value.get("commands").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

pub fn is_approved(approvals: &[Value], node_id: &str, command: &str) -> bool {
    approvals
        .iter()
        .any(|entry| entry["nodeId"] == node_id && entry["command"] == command)
}

#[tauri::command]
pub fn flows_approve(app: AppHandle, node_id: String, command: String) -> Value {
    let Some(command) = raw_text(Some(&json!(command)), COMMAND_LIMIT) else {
        return json!({ "success": false, "error": "The command is empty or too long" });
    };
    if node_id.is_empty() || node_id.len() > 128 {
        return json!({ "success": false, "error": "Invalid node id" });
    }
    let mut approvals = read_approvals(&app);
    if !is_approved(&approvals, &node_id, &command) {
        approvals.push(json!({ "nodeId": node_id, "command": command }));
    }
    let result = approvals_path(&app).and_then(|path| {
        let body = serde_json::to_string_pretty(&json!({ "commands": approvals }))
            .map_err(|error| error.to_string())?;
        crate::config::write_atomic(&path, &body)
    });
    match result {
        Ok(()) => json!({ "success": true }),
        Err(error) => json!({ "success": false, "error": error }),
    }
}

// ---------------------------------------------------------------- running checks

/// Checks the flows of the saved topology (all, or those of `ids`) and
/// returns one result per flow: `{ id, state, last, detail, checkedAt }`.
#[tauri::command]
pub async fn flows_check(app: AppHandle, ids: Option<Vec<String>>) -> Value {
    let document = crate::config::load(&app);
    let nodes: Vec<Value> = document["nodes"].as_array().cloned().unwrap_or_default();
    let flows: Vec<Value> = document["flows"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|flow| {
            ids.as_ref().is_none_or(|ids| {
                ids.iter()
                    .any(|id| Some(id.as_str()) == flow["id"].as_str())
            })
        })
        .collect();
    let approvals = read_approvals(&app);
    let jobs = flows.into_iter().map(|flow| {
        let app = app.clone();
        let nodes = nodes.clone();
        let approvals = approvals.clone();
        async move { check_one(&app, &flow, &nodes, &approvals).await }
    });
    let results = run_limited(jobs.collect(), CHECK_LIMIT).await;
    json!({ "success": true, "results": results })
}

async fn run_limited<F>(jobs: Vec<F>, limit: usize) -> Vec<Value>
where
    F: std::future::Future<Output = Value> + Send + 'static,
{
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(limit));
    let handles: Vec<_> = jobs
        .into_iter()
        .map(|job| {
            let semaphore = std::sync::Arc::clone(&semaphore);
            tokio::spawn(async move {
                let _permit = semaphore.acquire_owned().await;
                job.await
            })
        })
        .collect();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(result) = handle.await {
            results.push(result);
        }
    }
    results
}

async fn check_one(app: &AppHandle, flow: &Value, nodes: &[Value], approvals: &[Value]) -> Value {
    let id = flow["id"].as_str().unwrap_or("").to_string();
    let max_age = flow["maxAgeHours"]
        .as_u64()
        .unwrap_or(DEFAULT_MAX_AGE_HOURS);
    let outcome = read_check(app, &flow["check"], nodes, approvals).await;
    let now = Utc::now();
    let checked_at = now.to_rfc3339();
    match outcome {
        Ok(None) => {
            json!({ "id": id, "state": "unknown", "last": null, "detail": "", "checkedAt": checked_at })
        }
        Ok(Some(reading)) => {
            let state = verdict(&reading, max_age, now);
            let (last, detail) = match &reading {
                Reading::At(at) => (json!(at.to_rfc3339()), String::new()),
                Reading::Failed(reason) => (Value::Null, reason.clone()),
            };
            json!({ "id": id, "state": state, "last": last, "detail": detail, "checkedAt": checked_at })
        }
        Err(error) => json!({
            "id": id,
            "state": "unknown",
            "last": null,
            "detail": clip(&error, 300),
            "checkedAt": checked_at,
        }),
    }
}

/// `Ok(None)`: the flow has no check.
async fn read_check(
    app: &AppHandle,
    check: &Value,
    nodes: &[Value],
    approvals: &[Value],
) -> Result<Option<Reading>, String> {
    match check["type"].as_str() {
        Some("folder") => {
            let path = check["path"].as_str().unwrap_or("");
            if path.is_empty() {
                return Err("No folder is set".to_string());
            }
            let command = folder_command(path, check["depth"].as_u64().unwrap_or(DEFAULT_DEPTH))
                .ok_or_else(|| "The folder must be an absolute path without quotes".to_string())?;
            run_ssh(app, check, nodes, &command).await.map(Some)
        }
        Some("command") => {
            let command = check["command"].as_str().unwrap_or("");
            if command.is_empty() {
                return Err("No command is set".to_string());
            }
            let node_id = check["nodeId"].as_str().unwrap_or("");
            if !is_approved(approvals, node_id, command) {
                return Err(
                    "Command not approved on this computer. Open the flow and save it to approve it."
                        .to_string(),
                );
            }
            run_ssh(app, check, nodes, command).await.map(Some)
        }
        Some("http") => read_http(check).await.map(Some),
        _ => Ok(None),
    }
}

async fn run_ssh(
    app: &AppHandle,
    check: &Value,
    nodes: &[Value],
    command: &str,
) -> Result<Reading, String> {
    let node_id = check["nodeId"].as_str().unwrap_or("");
    let node = nodes
        .iter()
        .find(|node| node["id"].as_str() == Some(node_id))
        .ok_or_else(|| "The node of this check no longer exists".to_string())?;
    let request = ssh_request(node)
        .ok_or_else(|| "The node has no address or SSH user. Set them in Edit Node.".to_string())?;
    let output = crate::ssh::exec(app, &request, command, CHECK_TIMEOUT).await?;
    if output.exit_status.is_some_and(|status| status != 0) {
        let message = output
            .stderr
            .lines()
            .chain(output.stdout.lines())
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .unwrap_or("no output");
        return Err(format!(
            "The command exited with status {}: {}",
            output.exit_status.unwrap_or(0),
            clip(message, 200)
        ));
    }
    parse_reading(&output.stdout)
}

/// The SSH login of a node, as the terminal builds it.
pub fn ssh_request(node: &Value) -> Option<Value> {
    let object: &Map<String, Value> = node.as_object()?;
    let host = object.get("address")?.as_str()?.trim();
    let user = object.get("sshUser")?.as_str()?.trim();
    if host.is_empty() || user.is_empty() {
        return None;
    }
    let port = object
        .get("sshPort")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or(22);
    let uses_key = object.get("sshAuth").and_then(Value::as_str) == Some("key")
        || node.pointer("/sshSecret/type").and_then(Value::as_str) == Some("passphrase");
    let mut request = json!({
        "nodeId": object.get("id")?.as_str()?,
        "host": host,
        "port": port,
        "username": user,
    });
    if uses_key
        && let Some(path) = object
            .get("sshKeyPath")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
    {
        request["privateKeyPath"] = json!(path);
    }
    Some(request)
}

async fn read_http(check: &Value) -> Result<Reading, String> {
    let url = check["url"].as_str().unwrap_or("");
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The URL must start with http:// or https://".to_string());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .timeout(CHECK_TIMEOUT)
        .user_agent("ptychozoon-probe")
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("Request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Request failed: {error}"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > HTTP_BODY_LIMIT {
            return Err("The response is too large".to_string());
        }
    }
    let text = String::from_utf8_lossy(&body);
    reading_from_body(&text, check["field"].as_str().unwrap_or(""))
}

pub fn reading_from_body(body: &str, field: &str) -> Result<Reading, String> {
    if field.is_empty() {
        return parse_reading(body);
    }
    let document: Value =
        serde_json::from_str(body).map_err(|_| "The response is not JSON".to_string())?;
    match json_field(&document, field) {
        Some(Value::Number(number)) => parse_reading(&number.to_string()),
        Some(Value::String(text)) => parse_reading(text),
        Some(_) => Err(format!("The field {field} is not a date")),
        None => Err(format!("The response has no field {field}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn flows_keep_known_fields_and_drop_broken_ones() {
        let raw = json!([
            {
                "id": "f1", "name": " Nightly ", "sourceNodeId": "a", "targetNodeId": "b",
                "tool": "restic", "maxAgeHours": 0.2, "status": "ok", "extra": 1,
                "check": { "type": "folder", "path": "/srv/backup", "depth": 9 }
            },
            { "id": "f2", "sourceNodeId": "a", "targetNodeId": "gone" },
            { "id": "f3", "sourceNodeId": "a", "targetNodeId": "a" },
            { "id": "f1", "sourceNodeId": "b", "targetNodeId": "a" },
            { "sourceNodeId": "b", "targetNodeId": "a", "maxAgeHours": 1e9,
              "check": { "type": "command", "nodeId": "gone", "command": "  date +%s \u{7}" } }
        ]);
        let flows = normalize_flows(Some(&raw), &ids(&["a", "b"]));
        assert_eq!(flows.len(), 2);
        assert_eq!(flows[0]["name"], "Nightly");
        assert_eq!(flows[0]["maxAgeHours"], DEFAULT_MAX_AGE_HOURS);
        assert!(flows[0].get("status").is_none() && flows[0].get("extra").is_none());
        assert_eq!(
            flows[0]["check"],
            json!({ "type": "folder", "nodeId": "b", "path": "/srv/backup", "depth": 5 })
        );
        assert_eq!(flows[1]["id"], "flow_migrated_4");
        assert_eq!(flows[1]["maxAgeHours"], MAX_AGE_HOURS);
        assert_eq!(flows[1]["check"]["nodeId"], "a");
        assert_eq!(flows[1]["check"]["command"], "date +%s");
        assert_eq!(normalize_flows(None, &ids(&["a"])), Vec::<Value>::new());
    }

    #[test]
    fn folder_command_quotes_the_path_and_refuses_unsafe_ones() {
        let command = folder_command("/srv/backup dir", 2).unwrap();
        assert!(command.starts_with("p='/srv/backup dir';"));
        assert!(command.contains("-maxdepth 2"));
        assert!(folder_command("relative/path", 2).is_none());
        assert!(folder_command("/x'; rm -rf /; '", 2).is_none());
        assert!(folder_command("/x\n/y", 2).is_none());
    }

    #[test]
    fn readings_accept_unix_times_iso_dates_and_failures() {
        let at = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        assert_eq!(parse_reading("1700000000\n").unwrap(), Reading::At(at));
        assert_eq!(
            parse_reading("noise\n1700000000.123456\n\n").unwrap(),
            Reading::At(at)
        );
        assert_eq!(parse_reading("1700000000000").unwrap(), Reading::At(at));
        assert_eq!(
            parse_reading("2023-11-14T22:13:20Z").unwrap(),
            Reading::At(at)
        );
        assert!(matches!(
            parse_reading("2023-11-14 22:13:20"),
            Ok(Reading::At(_))
        ));
        assert_eq!(
            parse_reading("FAILED: disk full").unwrap(),
            Reading::Failed("disk full".to_string())
        );
        assert_eq!(
            parse_reading("error").unwrap(),
            Reading::Failed("The check reported a failure".to_string())
        );
        assert!(parse_reading("").is_err());
        assert!(parse_reading("hello").is_err());
        assert!(parse_reading("-5").is_err());
    }

    #[test]
    fn verdict_compares_the_age_with_the_limit() {
        let now = Utc.timestamp_opt(1_700_100_000, 0).unwrap();
        let recent = Reading::At(now - chrono::Duration::hours(25));
        let old = Reading::At(now - chrono::Duration::hours(27));
        assert_eq!(verdict(&recent, 26, now), "ok");
        assert_eq!(verdict(&old, 26, now), "late");
        assert_eq!(verdict(&Reading::Failed("x".into()), 26, now), "failed");
    }

    #[test]
    fn http_bodies_are_text_or_a_json_field() {
        let at = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        assert_eq!(
            reading_from_body("1700000000", "").unwrap(),
            Reading::At(at)
        );
        let body = r#"{"data":[{"last":"2023-11-14T22:13:20Z"}],"n":1700000000}"#;
        assert_eq!(
            reading_from_body(body, "data.0.last").unwrap(),
            Reading::At(at)
        );
        assert_eq!(reading_from_body(body, "n").unwrap(), Reading::At(at));
        assert!(reading_from_body(body, "missing").is_err());
        assert!(reading_from_body("not json", "a").is_err());
    }

    #[test]
    fn commands_run_only_when_approved_for_that_node() {
        let approvals = vec![json!({ "nodeId": "nas", "command": "date +%s" })];
        assert!(is_approved(&approvals, "nas", "date +%s"));
        assert!(!is_approved(&approvals, "pbs", "date +%s"));
        assert!(!is_approved(&approvals, "nas", "date +%s; id"));
    }

    #[test]
    fn ssh_request_follows_the_node_login() {
        let node = json!({
            "id": "nas", "address": "10.0.0.5", "sshUser": "backup", "sshPort": "2222",
            "sshAuth": "key", "sshKeyPath": "/home/me/.ssh/id_ed25519"
        });
        assert_eq!(
            ssh_request(&node).unwrap(),
            json!({
                "nodeId": "nas", "host": "10.0.0.5", "port": 2222, "username": "backup",
                "privateKeyPath": "/home/me/.ssh/id_ed25519"
            })
        );
        assert!(ssh_request(&json!({ "id": "x", "address": "10.0.0.5" })).is_none());
    }
}
