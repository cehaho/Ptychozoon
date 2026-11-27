//! Proxmox VE guests through the local API (`:8006`).
//!
//! The API token is used for these requests only: it is never written to the
//! topology file nor to the keyring, and no error message repeats it. The
//! token id (`user@realm!name`) comes from the dialog; the secret is the one
//! Proxmox shows once when the token is created.
//!
//! Requests are `GET /version`, `GET /nodes`, then `/nodes/{node}/qemu` and
//! `/nodes/{node}/lxc` per node. A node name is checked before it goes into a
//! URL. Redirects are not followed.

use std::time::Duration;

use serde_json::{Value, json};

use crate::hosts::{format_host_port, is_safe_port, normalize_host};

const DEFAULT_PORT: u16 = 8006;
const MAX_NODES: usize = 8;
const MAX_GUESTS: usize = 512;
const MAX_TOKEN_ID: usize = 128;
const MAX_TOKEN_SECRET: usize = 512;
const MAX_GUEST_NAME: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub insecure_tls: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiToken {
    pub id: String,
    pub secret: String,
}

/// Accepts `pve.lan`, `10.0.0.5`, `10.0.0.5:8006`,
/// `https://pve.lan:8006/` and an IPv6 literal. The port of the text wins
/// over the default; `port` is used when the text has none.
pub fn parse_endpoint(
    address: &str,
    port: Option<u16>,
    insecure_tls: bool,
) -> Result<Endpoint, String> {
    let text = address.trim();
    let text = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))
        .unwrap_or(text);
    let text = text.trim_end_matches('/');
    if text.is_empty() {
        return Err("Invalid address".to_string());
    }
    let mut host = text.to_string();
    let mut found_port = port;
    // A bracketed or bare IPv6 literal has several colons: only a trailing
    // `:digits` on one colon is a port.
    if text.matches(':').count() == 1
        && let Some((before, after)) = text.rsplit_once(':')
        && !after.is_empty()
        && after.bytes().all(|byte| byte.is_ascii_digit())
    {
        host = before.to_string();
        let value = after.parse::<u16>().map_err(|_| "Invalid port")?;
        if !is_safe_port(i64::from(value)) {
            return Err("Invalid port".to_string());
        }
        found_port = Some(value);
    }
    let host = normalize_host(&host).ok_or_else(|| "Invalid address".to_string())?;
    let port = found_port.unwrap_or(DEFAULT_PORT);
    if !is_safe_port(i64::from(port)) {
        return Err("Invalid port".to_string());
    }
    Ok(Endpoint {
        host,
        port,
        insecure_tls,
    })
}

/// `https://host:port/api2/json`
pub fn api_base(endpoint: &Endpoint) -> String {
    format!(
        "https://{}/api2/json",
        format_host_port(&endpoint.host, endpoint.port)
    )
}

pub fn parse_token(id: &str, secret: &str) -> Result<ApiToken, String> {
    let id = id.trim();
    if id.is_empty()
        || id.len() > MAX_TOKEN_ID
        || !id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'@' | b'!' | b'-')
        })
        || !id.contains('@')
        || !id.contains('!')
    {
        return Err("The token id must look like user@realm!name".to_string());
    }
    if secret.is_empty() || secret.len() > MAX_TOKEN_SECRET || secret.chars().any(char::is_control)
    {
        return Err("The token secret is required".to_string());
    }
    Ok(ApiToken {
        id: id.to_string(),
        secret: secret.to_string(),
    })
}

/// The value of the `Authorization` header.
pub fn authorization(token: &ApiToken) -> String {
    format!("PVEAPIToken={}={}", token.id, token.secret)
}

/// A node name safe to put in a URL path.
pub fn is_safe_node_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `{ "vmid": 100, "name": "web", "type": "qemu", "status": "running",
/// "cpus": 2, "memoryMB": 2048, "uptimeSecs": 1234, "template": false }`.
/// `kind` is `qemu` or `lxc`.
pub fn parse_guests(value: &Value, kind: &str) -> Vec<Value> {
    let Some(list) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut guests = Vec::new();
    for entry in list.iter().take(MAX_GUESTS) {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let Some(vmid) = object.get("vmid").and_then(Value::as_u64) else {
            continue;
        };
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .map(clean_name)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("{kind} {vmid}"));
        guests.push(json!({
            "vmid": vmid,
            "name": name,
            "type": kind,
            "status": object.get("status").and_then(Value::as_str).unwrap_or("unknown"),
            "cpus": object.get("cpus").and_then(Value::as_u64),
            "memoryMB": object
                .get("maxmem")
                .and_then(Value::as_u64)
                .map(|bytes| bytes / (1024 * 1024)),
            "uptimeSecs": object.get("uptime").and_then(Value::as_u64),
            "template": object.get("template").and_then(Value::as_u64) == Some(1)
                || object.get("template").and_then(Value::as_bool) == Some(true),
        }));
    }
    guests
}

/// A guest name that is safe to show and to copy into a node name.
fn clean_name(name: &str) -> String {
    let text: String = name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    text.chars().take(MAX_GUEST_NAME).collect()
}

/// Node names (`{ "data": [ { "node": "pve1", "status": "online" } ] }`),
/// capped and deduplicated. A name that is not safe for a URL is dropped.
pub fn parse_nodes(value: &Value) -> Vec<(String, String)> {
    let Some(list) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut nodes: Vec<(String, String)> = Vec::new();
    for entry in list {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let Some(name) = object.get("node").and_then(Value::as_str) else {
            continue;
        };
        if !is_safe_node_name(name) || nodes.iter().any(|seen| seen.0 == name) {
            continue;
        }
        let status = object
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        nodes.push((name.to_string(), status.to_string()));
        if nodes.len() == MAX_NODES {
            break;
        }
    }
    nodes
}

fn client(insecure_tls: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .user_agent("ptychozoon-proxmox")
        .tls_danger_accept_invalid_certs(insecure_tls)
        .build()
        .map_err(|_| "The API client could not be built".to_string())
}

/// A reply that carries `data`, or the message shown to the user.
async fn get(client: &reqwest::Client, url: &str, token: &ApiToken) -> Result<Value, &'static str> {
    let response = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, authorization(token))
        .send()
        .await
        .map_err(request_failure)?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err("Authentication failed: check the token id, the secret and its permissions");
    }
    if !response.status().is_success() {
        return Err("The Proxmox API refused the request");
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "The Proxmox API returned an unexpected answer")?;
    serde_json::from_slice::<Value>(&body)
        .map_err(|_| "The Proxmox API returned an unexpected answer")
}

fn request_failure(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        return "The Proxmox API did not answer in time";
    }
    let text = error.to_string().to_ascii_lowercase();
    if text.contains("certificate") || text.contains("tls") {
        return "The certificate was rejected: accept the self-signed certificate to continue";
    }
    "The Proxmox host could not be reached"
}

/// `{ "success": true, "version": "8.2.4", "release": "8.2",
///   "nodes": [ { "name": "pve1", "status": "online",
///                "guests": [ … ] } ] }`, or `{ "success": false,
/// "error": "…" }`. The token is never part of the answer.
pub async fn discover(
    address: String,
    port: Option<u16>,
    token_id: String,
    token_secret: String,
    insecure_tls: Option<bool>,
) -> Value {
    let endpoint = match parse_endpoint(&address, port, insecure_tls.unwrap_or(true)) {
        Ok(endpoint) => endpoint,
        Err(error) => return failed(error),
    };
    let token = match parse_token(&token_id, &token_secret) {
        Ok(token) => token,
        Err(error) => return failed(error),
    };
    let client = match client(endpoint.insecure_tls) {
        Ok(client) => client,
        Err(error) => return failed(error),
    };
    let base = api_base(&endpoint);
    let version = match get(&client, &format!("{base}/version"), &token).await {
        Ok(value) => value,
        Err(error) => return failed(error.to_string()),
    };
    let nodes = match get(&client, &format!("{base}/nodes"), &token).await {
        Ok(value) => value,
        Err(error) => return failed(error.to_string()),
    };
    let mut found = Vec::new();
    for (name, status) in parse_nodes(&nodes) {
        let qemu = get(&client, &format!("{base}/nodes/{name}/qemu"), &token)
            .await
            .map(|value| parse_guests(&value, "qemu"))
            .unwrap_or_default();
        let lxc = get(&client, &format!("{base}/nodes/{name}/lxc"), &token)
            .await
            .map(|value| parse_guests(&value, "lxc"))
            .unwrap_or_default();
        let mut guests = qemu;
        guests.extend(lxc);
        found.push(json!({ "name": name, "status": status, "guests": guests }));
    }
    json!({
        "success": true,
        "version": version.get("data").and_then(|data| data.get("version")).and_then(Value::as_str),
        "release": version.get("data").and_then(|data| data.get("release")).and_then(Value::as_str),
        "nodes": found,
    })
}

fn failed(message: String) -> Value {
    json!({ "success": false, "error": message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_address_and_the_port() {
        assert_eq!(
            parse_endpoint("pve.lan", None, true),
            Ok(Endpoint {
                host: "pve.lan".to_string(),
                port: 8006,
                insecure_tls: true
            })
        );
        assert_eq!(
            parse_endpoint("https://10.0.0.5:8006/", None, false),
            Ok(Endpoint {
                host: "10.0.0.5".to_string(),
                port: 8006,
                insecure_tls: false
            })
        );
        assert_eq!(
            parse_endpoint("10.0.0.5:9006", Some(8006), true),
            Ok(Endpoint {
                host: "10.0.0.5".to_string(),
                port: 9006,
                insecure_tls: true
            })
        );
        assert_eq!(
            parse_endpoint("2001:db8::1", Some(8006), true),
            Ok(Endpoint {
                host: "2001:db8::1".to_string(),
                port: 8006,
                insecure_tls: true
            })
        );
        assert!(parse_endpoint("", None, true).is_err());
        assert!(parse_endpoint("10.0.0.5:0", None, true).is_err());
        assert!(parse_endpoint("10.0.0.5:70000", None, true).is_err());
        assert!(parse_endpoint("$(id)", None, true).is_err());
    }

    #[test]
    fn the_api_base_is_https_on_the_chosen_port() {
        let endpoint = parse_endpoint("10.0.0.5:8007", None, true).unwrap();
        assert_eq!(api_base(&endpoint), "https://10.0.0.5:8007/api2/json");
        let v6 = parse_endpoint("2001:db8::1", None, true).unwrap();
        assert_eq!(api_base(&v6), "https://[2001:db8::1]:8006/api2/json");
    }

    #[test]
    fn the_token_must_look_like_a_token() {
        let token = parse_token(" root@pam!ptychozoon ", " s3cret ").unwrap();
        assert_eq!(token.id, "root@pam!ptychozoon");
        assert_eq!(token.secret, " s3cret ");
        assert_eq!(
            authorization(&token),
            "PVEAPIToken=root@pam!ptychozoon= s3cret "
        );
        assert!(parse_token("root@pam", "x").is_err());
        assert!(parse_token("root@pam!x y", "x").is_err());
        assert!(parse_token("root@pam!x", "").is_err());
        assert!(parse_token("root@pam!x", "a\nb").is_err());
    }

    #[test]
    fn node_names_cannot_escape_the_url() {
        assert!(is_safe_node_name("pve1"));
        assert!(is_safe_node_name("pve-01.lan"));
        assert!(!is_safe_node_name("pve/../etc"));
        assert!(!is_safe_node_name("pve 1"));
        assert!(!is_safe_node_name(""));

        let nodes = json!({ "data": [
            { "node": "pve1", "status": "online" },
            { "node": "pve1", "status": "online" },
            { "node": "../bad", "status": "online" },
            { "node": "pve2", "status": "offline" }
        ] });
        assert_eq!(
            parse_nodes(&nodes),
            vec![
                ("pve1".to_string(), "online".to_string()),
                ("pve2".to_string(), "offline".to_string())
            ]
        );
    }

    #[test]
    fn guests_carry_status_and_size() {
        let value = json!({ "data": [
            { "vmid": 100, "name": "web", "status": "running", "cpus": 2,
              "maxmem": 2147483648u64, "uptime": 3600, "template": 0 },
            { "vmid": 101, "status": "stopped", "template": 1 },
            { "vmid": "bad" },
            "nope"
        ] });
        let guests = parse_guests(&value, "qemu");
        assert_eq!(guests.len(), 2);
        assert_eq!(guests[0]["name"], "web");
        assert_eq!(guests[0]["type"], "qemu");
        assert_eq!(guests[0]["memoryMB"], 2048);
        assert_eq!(guests[0]["uptimeSecs"], 3600);
        assert_eq!(guests[0]["template"], false);
        assert_eq!(guests[1]["name"], "qemu 101");
        assert_eq!(guests[1]["status"], "stopped");
        assert_eq!(guests[1]["template"], true);
        assert!(parse_guests(&json!({ "data": "x" }), "lxc").is_empty());
    }

    #[test]
    fn a_guest_name_cannot_carry_control_characters() {
        let value = json!({ "data": [ { "vmid": 7, "name": " bad\u{7}name " } ] });
        let guests = parse_guests(&value, "lxc");
        assert_eq!(guests[0]["name"], "badname");
    }
}
