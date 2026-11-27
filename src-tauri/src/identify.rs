//! Discovery fingerprinting: the web interface a device answers with.
//!
//! `network_identify` runs after the scan, on the hosts the discovery dialog
//! selects (a Ubiquiti or Proxmox vendor, or a matching host name). For each
//! address it tries HTTPS 443 and 8443, then HTTP 8080 and 80, and reads the
//! `Server` header and the first bytes of the page. A page that names UniFi
//! OS, UniFi Network, UniFi Protect, UniFi Talk, AirOS or EdgeOS gives the
//! device a label; anything else is left alone.
//!
//! Redirects are not followed, the certificate is not verified (these devices
//! ship a self-signed one), and nothing is sent but a `GET /`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

use crate::hosts::{format_host_port, normalize_host};

const MAX_HOSTS: usize = 64;
const MAX_CONCURRENT: usize = 6;
const MAX_BODY_BYTES: usize = 32 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_millis(2000);

/// `(port, https)`, tried in this order.
const ENDPOINTS: [(u16, bool); 4] = [(443, true), (8443, true), (8080, false), (80, false)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    /// Short kind for the renderer: `unifi`, `airmax` or `edge`.
    pub device: &'static str,
    pub label: &'static str,
}

/// Names the device a page belongs to. `None` for anything unrecognised, so
/// an ordinary web server is not given a UniFi label.
pub fn classify(server: &str, body: &str) -> Option<Fingerprint> {
    let text = body.to_ascii_lowercase();
    let header = server.to_ascii_lowercase();
    let found = |device, label| Some(Fingerprint { device, label });
    // The products name themselves in the page title, most specific first.
    if text.contains("unifi os") {
        return found("unifi", "UniFi OS");
    }
    if text.contains("unifi protect") {
        return found("unifi", "UniFi Protect");
    }
    if text.contains("unifi network") || text.contains("unifi controller") {
        return found("unifi", "UniFi Network");
    }
    if text.contains("unifi talk") {
        return found("unifi", "UniFi Talk");
    }
    if text.contains("unifi") || header.contains("unifi") {
        return found("unifi", "UniFi");
    }
    if text.contains("airos") || text.contains("airmax") || header.contains("airos") {
        return found("airmax", "AirOS");
    }
    if text.contains("edgeos") || text.contains("edge router") || header.contains("edgeos") {
        return found("edge", "EdgeOS");
    }
    None
}

/// Addresses to fingerprint: `"192.168.1.10"` or `{ "ip": "..." }`, validated
/// and deduplicated.
pub fn parse_targets(hosts: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in hosts.iter().take(MAX_HOSTS) {
        let address = match entry {
            Value::String(address) => address.as_str(),
            Value::Object(object) => object.get("ip").and_then(Value::as_str).unwrap_or(""),
            _ => continue,
        };
        let Some(host) = normalize_host(address) else {
            continue;
        };
        if !out.contains(&host) {
            out.push(host);
        }
    }
    out
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .user_agent("ptychozoon-probe")
        .tls_danger_accept_invalid_certs(true)
        .build()
        .ok()
}

async fn fetch(
    client: &reqwest::Client,
    host: &str,
    port: u16,
    https: bool,
) -> Option<(String, String)> {
    let scheme = if https { "https" } else { "http" };
    let url = format!("{scheme}://{}/", format_host_port(host, port));
    let response = client.get(url).send().await.ok()?;
    let server = response
        .headers()
        .get(reqwest::header::SERVER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = response.bytes().await.ok()?;
    let body = String::from_utf8_lossy(&body[..body.len().min(MAX_BODY_BYTES)]).to_string();
    Some((server, body))
}

/// `{ "<ip>": { "device": "unifi", "label": "UniFi OS", "url": "https://…:443/" } }`
/// for the addresses that answered with a known interface. Each one is also
/// emitted as `network-identify-result` as soon as it is known.
pub async fn identify(app: &AppHandle, hosts: &[Value]) -> Value {
    let mut results = Map::new();
    let Some(client) = client() else {
        return Value::Object(results);
    };
    let client = Arc::new(client);
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut tasks = tokio::task::JoinSet::new();
    for host in parse_targets(hosts) {
        let client = Arc::clone(&client);
        let semaphore = Arc::clone(&semaphore);
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok()?;
            for (port, https) in ENDPOINTS {
                let Some((server, body)) = fetch(&client, &host, port, https).await else {
                    continue;
                };
                if let Some(fingerprint) = classify(&server, &body) {
                    return Some((host, fingerprint, port, https));
                }
            }
            None
        });
    }
    while let Some(joined) = tasks.join_next().await {
        let Ok(Some((host, fingerprint, port, https))) = joined else {
            continue;
        };
        let scheme = if https { "https" } else { "http" };
        let url = format!("{scheme}://{}/", format_host_port(&host, port));
        let _ = app.emit(
            "network-identify-result",
            json!({
                "ip": host,
                "device": fingerprint.device,
                "label": fingerprint.label,
                "url": url,
            }),
        );
        results.insert(
            host,
            json!({
                "device": fingerprint.device,
                "label": fingerprint.label,
                "url": url,
            }),
        );
    }
    Value::Object(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_unifi_products() {
        assert_eq!(
            classify("", "<title>UniFi OS</title>"),
            Some(Fingerprint {
                device: "unifi",
                label: "UniFi OS"
            })
        );
        assert_eq!(
            classify("", "<title>UniFi Network</title>"),
            Some(Fingerprint {
                device: "unifi",
                label: "UniFi Network"
            })
        );
        assert_eq!(
            classify("", "<title>UniFi Protect</title>"),
            Some(Fingerprint {
                device: "unifi",
                label: "UniFi Protect"
            })
        );
        assert_eq!(
            classify("", "unifi talk"),
            Some(Fingerprint {
                device: "unifi",
                label: "UniFi Talk"
            })
        );
    }

    #[test]
    fn the_wireless_and_edge_products_are_apart() {
        assert_eq!(
            classify("", "<title>AirOS</title>").map(|found| found.label),
            Some("AirOS")
        );
        assert_eq!(
            classify("", "airmax station").map(|found| found.device),
            Some("airmax")
        );
        assert_eq!(
            classify("", "<title>EdgeOS</title>").map(|found| found.device),
            Some("edge")
        );
    }

    #[test]
    fn the_server_header_counts_too() {
        assert_eq!(
            classify("UniFi", "").map(|found| found.label),
            Some("UniFi")
        );
        assert_eq!(classify("nginx", ""), None);
    }

    #[test]
    fn an_ordinary_web_page_is_left_alone() {
        assert_eq!(classify("", "<title>Welcome to nginx!</title>"), None);
        assert_eq!(
            classify("", "<title>Proxmox Virtual Environment</title>"),
            None
        );
        assert_eq!(classify("", ""), None);
    }

    #[test]
    fn targets_are_validated_and_deduplicated() {
        let hosts = vec![
            json!("192.168.1.10"),
            json!({ "ip": "192.168.1.10" }),
            json!({ "ip": "[2001:db8::1]" }),
            json!("nas.lan"),
            json!("$(id)"),
            json!({ "ip": 5 }),
            json!(42),
        ];
        assert_eq!(
            parse_targets(&hosts),
            vec!["192.168.1.10", "2001:db8::1", "nas.lan"]
        );
    }
}
