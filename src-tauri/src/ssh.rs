//! One interactive shell per node, and one-shot commands for automatic checks.
//!
//! Host keys are pinned per `host:port` in `known_hosts.json` (see
//! `known_hosts`). An unknown key is refused until the user confirms its
//! fingerprint; the retry carries that fingerprint in `acceptHostKey`. A key
//! that differs from the pinned one is always refused.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use russh::client::{Handle, Handler, Msg};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::hosts::{is_reasonable_username, is_safe_port, normalize_host};
use crate::known_hosts::{self, HostKey, Verdict};

const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_KEY_BYTES: u64 = 1024 * 1024;

type ShellWriter = ChannelWriteHalf<Msg>;

enum SessionCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct LiveSession {
    tx: UnboundedSender<SessionCmd>,
    generation: u64,
}

pub struct Hub {
    sessions: HashMap<String, LiveSession>,
    next_generation: u64,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_generation: 1,
        }
    }
}

/// Why the server key was refused, kept for the reply to the renderer.
enum HostKeyRefusal {
    Unknown(HostKey),
    Mismatch {
        presented: Box<HostKey>,
        stored: Box<HostKey>,
    },
    Store(String),
}

struct HostKeyCheck {
    known_hosts: PathBuf,
    host: String,
    port: u16,
    /// Fingerprint the user confirmed for an unknown host, if any.
    accept: Option<String>,
    refusal: Arc<StdMutex<Option<HostKeyRefusal>>>,
}

impl HostKeyCheck {
    fn verify(&self, presented: HostKey) -> Result<(), HostKeyRefusal> {
        match known_hosts::check(&self.known_hosts, &self.host, self.port, &presented) {
            Ok(Verdict::Match) => Ok(()),
            Ok(Verdict::Mismatch { stored }) => Err(HostKeyRefusal::Mismatch {
                presented: Box::new(presented),
                stored: Box::new(stored),
            }),
            Ok(Verdict::Unknown)
                if self.accept.as_deref() == Some(presented.fingerprint.as_str()) =>
            {
                known_hosts::remember(&self.known_hosts, &self.host, self.port, &presented)
                    .map_err(HostKeyRefusal::Store)
            }
            Ok(Verdict::Unknown) => Err(HostKeyRefusal::Unknown(presented)),
            Err(error) => Err(HostKeyRefusal::Store(error)),
        }
    }
}

impl Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let outcome = match describe_host_key(server_public_key) {
            Ok(presented) => self.verify(presented),
            Err(error) => Err(HostKeyRefusal::Store(error)),
        };
        match outcome {
            Ok(()) => Ok(true),
            Err(refusal) => {
                *self
                    .refusal
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(refusal);
                Ok(false)
            }
        }
    }
}

fn describe_host_key(presented: &PublicKeyOrCertificate) -> Result<HostKey, String> {
    // For a certificate, pin the certified host key itself.
    let key_data = match presented {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
        PublicKeyOrCertificate::Certificate(certificate) => certificate.public_key().clone(),
    };
    let fingerprint = key_data.fingerprint(HashAlg::Sha256).to_string();
    let public = PublicKey::from(key_data);
    let key = public
        .to_openssh()
        .map_err(|_| "Failed to encode the server host key".to_string())?;
    Ok(HostKey {
        algorithm: public.algorithm().to_string(),
        fingerprint,
        key: key.trim().to_string(),
    })
}

fn host_key_failure(host: &str, port: u16, refusal: HostKeyRefusal) -> Value {
    let name = known_hosts::entry_name(host, port);
    match refusal {
        HostKeyRefusal::Unknown(presented) => json!({
            "success": false,
            "error": format!("The host key of {name} is not known yet. Check its fingerprint before trusting it."),
            "hostKey": {
                "status": "unknown",
                "host": host,
                "port": port,
                "algorithm": presented.algorithm,
                "fingerprint": presented.fingerprint,
            }
        }),
        HostKeyRefusal::Mismatch { presented, stored } => json!({
            "success": false,
            "error": format!(
                "Host key mismatch for {name}. The server presented a different key than the one stored. \
                 Someone may be intercepting the connection, or the server was reinstalled. Connection refused."
            ),
            "hostKey": {
                "status": "mismatch",
                "host": host,
                "port": port,
                "algorithm": presented.algorithm,
                "fingerprint": presented.fingerprint,
                "storedAlgorithm": stored.algorithm,
                "storedFingerprint": stored.fingerprint,
            }
        }),
        HostKeyRefusal::Store(error) => failure(&format!("Host key check failed: {error}")),
    }
}

/// Removes the pinned key for `host:port` so the next connection asks again.
pub fn forget_host_key(app: &AppHandle, host: &str, port: u64) -> Value {
    let Some(host) = normalize_host(host) else {
        return failure("Invalid SSH host or port");
    };
    if port > u64::from(u16::MAX) || !is_safe_port(port as i64) {
        return failure("Invalid SSH host or port");
    }
    let path = match crate::config::known_hosts_path(app) {
        Ok(path) => path,
        Err(error) => return failure(&error),
    };
    match known_hosts::forget(&path, &host, port as u16) {
        Ok(removed) => json!({ "success": true, "removed": removed }),
        Err(error) => failure(&error),
    }
}

pub async fn connect(app: AppHandle, hub: Arc<Mutex<Hub>>, request: Value) -> Value {
    let login = match resolve_login(&request) {
        Ok(login) => login,
        Err(error) => return failure(&error),
    };
    let accept = non_empty_text(request.get("acceptHostKey"));
    let session = match open_session(&app, &login, accept).await {
        Ok(session) => session,
        Err(refusal) => return refusal,
    };
    let (session, mut reader, writer) = match open_shell(session).await {
        Ok(shell) => shell,
        Err(error) => return failure(&error),
    };
    let node_id = login.node_id;

    let (tx, mut rx) = unbounded_channel();
    let generation = {
        let mut guard = hub.lock().await;
        if let Some(previous) = guard.sessions.remove(&node_id) {
            let _ = previous.tx.send(SessionCmd::Close);
        }
        let generation = guard.next_generation;
        guard.next_generation = guard.next_generation.wrapping_add(1);
        guard
            .sessions
            .insert(node_id.clone(), LiveSession { tx, generation });
        generation
    };

    let node_for_task = node_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                message = reader.wait() => {
                    match message {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let text = String::from_utf8_lossy(&data).into_owned();
                            let _ = app.emit("ssh-data", json!({ "nodeId": &node_for_task, "data": text }));
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
                command = rx.recv() => {
                    match command {
                        Some(SessionCmd::Data(bytes)) => {
                            if writer.data_bytes(bytes).await.is_err() {
                                break;
                            }
                        }
                        Some(SessionCmd::Resize { cols, rows }) => {
                            let _ = writer.window_change(cols, rows, 0, 0).await;
                        }
                        Some(SessionCmd::Close) | None => break,
                    }
                }
            }
        }
        let _ = writer.close().await;
        let _ = session.disconnect(Disconnect::ByApplication, "", "").await;
        let mut guard = hub.lock().await;
        if guard
            .sessions
            .get(&node_for_task)
            .is_some_and(|live| live.generation == generation)
        {
            guard.sessions.remove(&node_for_task);
            drop(guard);
            let _ = app.emit("ssh-closed", json!({ "nodeId": node_for_task }));
        }
    });

    json!({ "success": true })
}

pub async fn write(hub: &Mutex<Hub>, node_id: &str, data: &str) -> Value {
    if data.len() > MAX_WRITE_BYTES {
        return failure("Write is too large");
    }
    send(hub, node_id, SessionCmd::Data(data.as_bytes().to_vec())).await
}

pub async fn resize(hub: &Mutex<Hub>, node_id: &str, cols: u32, rows: u32) -> Value {
    if !(1..=500).contains(&cols) || !(1..=500).contains(&rows) {
        return failure("Invalid terminal size");
    }
    send(hub, node_id, SessionCmd::Resize { cols, rows }).await
}

pub async fn disconnect(hub: &Mutex<Hub>, node_id: &str) -> Value {
    let mut guard = hub.lock().await;
    let Some(live) = guard.sessions.remove(node_id) else {
        return failure("Connection not found");
    };
    let _ = live.tx.send(SessionCmd::Close);
    json!({ "success": true })
}

async fn send(hub: &Mutex<Hub>, node_id: &str, command: SessionCmd) -> Value {
    let guard = hub.lock().await;
    let Some(live) = guard.sessions.get(node_id) else {
        return failure("Connection not found");
    };
    if live.tx.send(command).is_err() {
        return failure("Connection not found");
    }
    json!({ "success": true })
}

/// Who to log in as, and with what: the request fields, completed with the
/// password or key passphrase stored in the system keyring for the node.
struct Login {
    node_id: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
}

fn resolve_login(request: &Value) -> Result<Login, String> {
    let Some(request) = request.as_object() else {
        return Err("Invalid SSH host, port, or username".to_string());
    };
    let node_id = match request.get("nodeId").and_then(Value::as_str) {
        Some(node_id) if !node_id.is_empty() && node_id.len() <= 128 => node_id.to_string(),
        _ => return Err("Invalid node id".to_string()),
    };
    // An IPv6 literal may arrive bracketed (`[::1]`); keep the bare form.
    let Some(host) = normalize_host(request.get("host").and_then(Value::as_str).unwrap_or(""))
    else {
        return Err("Invalid SSH host, port, or username".to_string());
    };
    let port = request.get("port").and_then(Value::as_u64).unwrap_or(22);
    let username = request
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("");
    if port > u64::from(u16::MAX) || !is_safe_port(port as i64) || !is_reasonable_username(username)
    {
        return Err("Invalid SSH host, port, or username".to_string());
    }
    let mut password = non_empty_text(request.get("password"));
    let mut passphrase = non_empty_text(request.get("passphrase"));
    let key_path = request
        .get("privateKeyPath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    if key_path.is_none() && password.is_none() {
        match crate::secrets::lookup(&node_id, crate::secrets::SecretKind::Password) {
            Ok(Some(stored)) => password = Some(stored),
            Ok(None) => {
                return Err("No password is stored for this node. Enter it again.".to_string());
            }
            Err(error) => return Err(error),
        }
    } else if let Some(path) = &key_path
        && passphrase.is_none()
    {
        match crate::secrets::lookup(&node_id, crate::secrets::SecretKind::Passphrase) {
            Ok(found) => passphrase = found,
            Err(error) => match load_private_key(path, None) {
                Ok(_) => {}
                Err(read_error) if read_error == "Passphrase required" => return Err(error),
                Err(read_error) => return Err(read_error),
            },
        }
    }
    Ok(Login {
        node_id,
        host,
        port: port as u16,
        username: username.to_string(),
        password,
        key_path,
        passphrase,
    })
}

/// Connects, checks the host key and authenticates, within ten seconds. The
/// error is the reply for the renderer (a host key refusal carries the key).
async fn open_session(
    app: &AppHandle,
    login: &Login,
    accept: Option<String>,
) -> Result<Handle<HostKeyCheck>, Value> {
    let known_hosts = crate::config::known_hosts_path(app)
        .map_err(|error| failure(&format!("Host key check failed: {error}")))?;
    let refusal = Arc::new(StdMutex::new(None));
    let checker = HostKeyCheck {
        known_hosts,
        host: login.host.clone(),
        port: login.port,
        accept,
        refusal: Arc::clone(&refusal),
    };
    let outcome = tokio::time::timeout(Duration::from_secs(10), authenticate(login, checker)).await;
    let refused = refusal
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    match (outcome, refused) {
        (Ok(Ok(session)), _) => Ok(session),
        (_, Some(refusal)) => Err(host_key_failure(&login.host, login.port, refusal)),
        (Ok(Err(error)), None) => Err(failure(&error)),
        (Err(_), None) => Err(failure("Connection timed out")),
    }
}

async fn authenticate(
    login: &Login,
    checker: HostKeyCheck,
) -> Result<Handle<HostKeyCheck>, String> {
    let config = russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(10)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    };
    let mut session =
        russh::client::connect(Arc::new(config), (login.host.as_str(), login.port), checker)
            .await
            .map_err(|error| error.to_string())?;

    let username = login.username.clone();
    let authenticated = if let Some(path) = &login.key_path {
        let key = load_private_key(path, login.passphrase.as_deref())?;
        let hash_alg = if key.algorithm().is_rsa() {
            session
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten()
        } else {
            None
        };
        session
            .authenticate_publickey(
                username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await
            .map_err(|error| error.to_string())?
    } else if let Some(password) = login
        .password
        .clone()
        .filter(|password| !password.is_empty())
    {
        session
            .authenticate_password(username, password)
            .await
            .map_err(|error| error.to_string())?
    } else {
        return Err("Missing credentials".to_string());
    };
    if !authenticated.success() {
        return Err("Authentication failed".to_string());
    }
    Ok(session)
}

async fn open_shell(
    session: Handle<HostKeyCheck>,
) -> Result<(Handle<HostKeyCheck>, ChannelReadHalf, ShellWriter), String> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    let modes: &[(russh::Pty, u32)] = &[];
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, modes)
        .await
        .map_err(|error| error.to_string())?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| error.to_string())?;
    let (reader, writer) = channel.split();
    Ok((session, reader, writer))
}

/// Output of a command run without a terminal.
pub struct ExecOutput {
    pub exit_status: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

const MAX_EXEC_OUTPUT: usize = 64 * 1024;

/// Runs one command on the node, without a terminal, for an automatic check.
/// The host key must already be trusted (from the SSH terminal): an unknown
/// key is refused, never accepted here.
pub async fn exec(
    app: &AppHandle,
    request: &Value,
    command: &str,
    limit: Duration,
) -> Result<ExecOutput, String> {
    let login = resolve_login(request)?;
    let session = open_session(app, &login, None)
        .await
        .map_err(|reply| exec_refusal(&login, &reply))?;
    let run = async {
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|error| error.to_string())?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| error.to_string())?;
        let mut output = ExecOutput {
            exit_status: None,
            stdout: String::new(),
            stderr: String::new(),
        };
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => append_capped(&mut stdout, &data),
                ChannelMsg::ExtendedData { data, .. } => append_capped(&mut stderr, &data),
                ChannelMsg::ExitStatus { exit_status } => output.exit_status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        output.stdout = String::from_utf8_lossy(&stdout).into_owned();
        output.stderr = String::from_utf8_lossy(&stderr).into_owned();
        Ok::<ExecOutput, String>(output)
    };
    let result = tokio::time::timeout(limit, run).await;
    let _ = session.disconnect(Disconnect::ByApplication, "", "").await;
    result.map_err(|_| "The command timed out".to_string())?
}

fn append_capped(buffer: &mut Vec<u8>, data: &[u8]) {
    let room = MAX_EXEC_OUTPUT.saturating_sub(buffer.len());
    buffer.extend_from_slice(&data[..data.len().min(room)]);
}

fn exec_refusal(login: &Login, reply: &Value) -> String {
    let name = known_hosts::entry_name(&login.host, login.port);
    match reply.pointer("/hostKey/status").and_then(Value::as_str) {
        Some("unknown") => format!(
            "The host key of {name} is not trusted yet. Open an SSH terminal to this node once to check and trust it."
        ),
        _ => reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("SSH connection failed")
            .to_string(),
    }
}

fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    if path.contains('\0') {
        return Err("Invalid private key path".to_string());
    }
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("Failed to read private key: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_KEY_BYTES {
        return Err("Failed to read private key: file is missing or larger than 1 MB".to_string());
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("Failed to read private key: {error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "Failed to read private key".to_string())?;
    if text.starts_with("PuTTY-User-Key-File-") {
        return PrivateKey::from_ppk(&text, passphrase.map(str::to_string))
            .map_err(|_| "Failed to read private key".to_string());
    }
    let key = PrivateKey::from_openssh(text.as_bytes())
        .map_err(|_| "Failed to read private key".to_string())?;
    if !key.is_encrypted() {
        return Ok(key);
    }
    let Some(passphrase) = passphrase.filter(|passphrase| !passphrase.is_empty()) else {
        return Err("Passphrase required".to_string());
    };
    key.decrypt(passphrase.as_bytes())
        .map_err(|_| "Failed to decrypt private key".to_string())
}

fn non_empty_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn failure(error: &str) -> Value {
    json!({ "success": false, "error": error })
}
