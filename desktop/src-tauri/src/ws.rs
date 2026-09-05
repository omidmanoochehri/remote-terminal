//! The desktop app's relay socket.
//!
//! The frontend owns the protocol state machine (backoff, ping, request
//! correlation) exactly as the Android app does; this module owns only the
//! socket, because a browser `WebSocket` cannot send the `Authorization:
//! Bearer` header the protocol requires (PROTOCOL.md §3) and the token must
//! never travel in a URL.
//!
//! Every event carries the connection `id` it belongs to, so a late frame from
//! a socket the frontend has already given up on is ignored rather than
//! mistaken for the current connection.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// Largest frame we will accept, matching the relay's own `MAX_FRAME_BYTES`
/// default with headroom for a generous server configuration.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenEvent {
    id: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextEvent {
    id: u64,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseEvent {
    id: u64,
    code: u16,
    reason: String,
    /// True when the peer initiated the close (as opposed to a local error).
    remote: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    id: u64,
    message: String,
}

struct Connection {
    id: u64,
    /// `None` in the payload means "close the socket cleanly with 1000".
    tx: mpsc::UnboundedSender<Outbound>,
}

enum Outbound {
    Text(String),
    Close(u16, String),
}

#[derive(Default)]
pub struct WsState {
    current: Mutex<Option<Connection>>,
    next_id: AtomicU64,
}

impl WsState {
    fn take_current(&self) -> Option<Connection> {
        self.current.lock().ok().and_then(|mut g| g.take())
    }

    fn set_current(&self, conn: Connection) {
        if let Ok(mut g) = self.current.lock() {
            *g = Some(conn);
        }
    }

    /// Forget the connection only if it is still the live one; a stale socket
    /// finishing after a reconnect must not clear the new connection.
    fn clear_if(&self, id: u64) {
        if let Ok(mut g) = self.current.lock() {
            if g.as_ref().map(|c| c.id) == Some(id) {
                *g = None;
            }
        }
    }

    fn sender_for(&self, id: u64) -> Option<mpsc::UnboundedSender<Outbound>> {
        let g = self.current.lock().ok()?;
        let conn = g.as_ref()?;
        if conn.id == id {
            Some(conn.tx.clone())
        } else {
            None
        }
    }
}

/// Open a relay connection. Returns the id every later event carries.
#[tauri::command]
pub fn ws_connect(
    app: AppHandle,
    state: State<'_, WsState>,
    url: String,
    token: String,
) -> Result<u64, String> {
    // One socket at a time: a new connect supersedes whatever was live.
    if let Some(previous) = state.take_current() {
        let _ = previous.tx.send(Outbound::Close(1000, "replaced".into()));
    }

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::unbounded_channel::<Outbound>();
    state.set_current(Connection { id, tx });

    tauri::async_runtime::spawn(async move {
        run_connection(app, id, url, token, rx).await;
    });

    Ok(id)
}

#[tauri::command]
pub fn ws_send(state: State<'_, WsState>, id: u64, text: String) -> Result<(), String> {
    let tx = state.sender_for(id).ok_or("no such connection")?;
    tx.send(Outbound::Text(text)).map_err(|_| "socket closed".to_string())
}

#[tauri::command]
pub fn ws_close(state: State<'_, WsState>, id: u64, code: u16, reason: String) {
    if let Some(tx) = state.sender_for(id) {
        let _ = tx.send(Outbound::Close(code, reason));
    }
}

async fn run_connection(
    app: AppHandle,
    id: u64,
    url: String,
    token: String,
    mut rx: mpsc::UnboundedReceiver<Outbound>,
) {
    let request = match build_request(&url, &token) {
        Ok(r) => r,
        Err(message) => {
            emit_error(&app, id, &message);
            emit_close(&app, id, 1006, "bad relay URL", false);
            return;
        }
    };

    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(MAX_FRAME_BYTES),
        max_frame_size: Some(MAX_FRAME_BYTES),
        ..Default::default()
    };

    let connected = tokio_tungstenite::connect_async_tls_with_config(request, Some(config), false, None).await;
    let (mut socket, _response) = match connected {
        Ok(pair) => pair,
        Err(err) => {
            // A refused handshake carries the relay's HTTP status, which is how
            // an unauthorized or version-mismatched client learns why.
            let (code, message) = classify(&err);
            emit_error(&app, id, &message);
            emit_close(&app, id, code, &message, true);
            return;
        }
    };

    emit(&app, "ws:open", OpenEvent { id });

    loop {
        tokio::select! {
            outbound = rx.recv() => match outbound {
                Some(Outbound::Text(text)) => {
                    if socket.send(Message::Text(text)).await.is_err() {
                        emit_close(&app, id, 1006, "send failed", false);
                        break;
                    }
                }
                Some(Outbound::Close(code, reason)) => {
                    let frame = CloseFrame { code: CloseCode::from(code), reason: reason.clone().into() };
                    let _ = socket.send(Message::Close(Some(frame))).await;
                    let _ = socket.close(None).await;
                    emit_close(&app, id, code, &reason, false);
                    break;
                }
                // The handle was dropped: nothing can speak for this socket any more.
                None => {
                    let _ = socket.close(None).await;
                    emit_close(&app, id, 1000, "closed", false);
                    break;
                }
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => emit(&app, "ws:text", TextEvent { id, data: text }),
                // The relay speaks JSON text only; binary is not part of v3.
                Some(Ok(Message::Binary(bytes))) => match String::from_utf8(bytes) {
                    Ok(text) => emit(&app, "ws:text", TextEvent { id, data: text }),
                    Err(_) => emit_error(&app, id, "binary frame is not UTF-8"),
                },
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame {
                        Some(f) => (u16::from(f.code), f.reason.to_string()),
                        None => (1005, String::new()),
                    };
                    emit_close(&app, id, code, &reason, true);
                    break;
                }
                Some(Ok(_)) => {} // ping/pong/frame plumbing is tungstenite's job
                Some(Err(err)) => {
                    let (code, message) = classify(&err);
                    emit_error(&app, id, &message);
                    emit_close(&app, id, code, &message, true);
                    break;
                }
                // Every deliberate close breaks out of the loop above, so a
                // stream that simply ends is a connection we lost.
                None => {
                    emit_close(&app, id, 1006, "connection lost", true);
                    break;
                }
            },
        }
    }

    if let Some(state) = app_state(&app) {
        state.clear_if(id);
    }
}

fn app_state(app: &AppHandle) -> Option<State<'_, WsState>> {
    use tauri::Manager;
    app.try_state::<WsState>()
}

/// `wss://host/?v=3&role=phone` plus the bearer header the relay authenticates on.
fn build_request(
    url: &str,
    token: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("invalid relay URL: {e}"))?;
    let value = format!("Bearer {token}")
        .parse()
        .map_err(|_| "invalid device token".to_string())?;
    request.headers_mut().insert("Authorization", value);
    Ok(request)
}

/// Map a transport failure onto the close code the frontend reasons about.
/// The relay's own 44xx codes arrive as close frames; only handshake failures
/// need translating, and an HTTP status is the one thing worth preserving.
fn classify(err: &tokio_tungstenite::tungstenite::Error) -> (u16, String) {
    use tokio_tungstenite::tungstenite::Error;
    match err {
        Error::Http(response) => {
            let status = response.status().as_u16();
            let code = match status {
                401 | 403 => 4401,
                426 => 4426,
                429 => 4429,
                503 => 4503,
                _ => 1006,
            };
            (code, format!("relay refused the connection (HTTP {status})"))
        }
        Error::Tls(e) => (1015, format!("TLS failed: {e}")),
        Error::Io(e) => (1006, format!("{e}")),
        other => (1006, format!("{other}")),
    }
}

fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    let _ = app.emit(event, payload);
}

fn emit_error(app: &AppHandle, id: u64, message: &str) {
    emit(app, "ws:error", ErrorEvent { id, message: message.to_string() });
}

fn emit_close(app: &AppHandle, id: u64, code: u16, reason: &str, remote: bool) {
    emit(
        app,
        "ws:close",
        CloseEvent { id, code, reason: reason.to_string(), remote },
    );
}
