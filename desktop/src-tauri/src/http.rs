//! The relay's HTTPS identity endpoints (PROTOCOL.md §2): redeeming a pairing
//! code, and minting one for another device. Blocking calls, run off the UI
//! thread; TLS validation and hostname verification are the platform's.

use serde::Serialize;

const TIMEOUT_SECS: u64 = 15;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResult {
    pub device_id: String,
    pub device_token: String,
    pub account_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    pub code: String,
    pub expires_at: i64,
    pub ttl_sec: i64,
}

/// `ws(s)://…` → `http(s)://…` without a trailing slash, so the identity
/// endpoints sit on the same host as the socket.
pub fn http_base(relay_url: &str) -> Result<String, String> {
    let raw = relay_url.trim().trim_end_matches('/');
    let (scheme, rest) = match raw.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => return Err("Relay URL must start with ws:// or wss://".into()),
    };
    let scheme = match scheme.as_str() {
        "ws" | "http" => "http",
        "wss" | "https" => "https",
        _ => return Err("Relay URL must start with ws:// or wss://".into()),
    };
    // Strip any query/fragment; the path (a reverse-proxy prefix) is kept.
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return Err("Relay URL needs a host".into());
    }
    Ok(format!("{scheme}://{}", rest.trim_end_matches('/')))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(TIMEOUT_SECS))
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .user_agent("RemoteTerminal-Desktop")
        .build()
}

/// Post JSON and return `(status, body)`. A non-2xx answer is a value, not an
/// error: the relay's `{error, message}` body is what the user needs to see.
fn post(
    url: &str,
    body: serde_json::Value,
    bearer: Option<&str>,
) -> Result<(u16, serde_json::Value), String> {
    let mut request = agent()
        .post(url)
        .set("Content-Type", "application/json; charset=utf-8")
        .set("Accept", "application/json");
    if let Some(token) = bearer {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    match request.send_json(body) {
        Ok(response) => {
            let status = response.status();
            let json = response
                .into_json::<serde_json::Value>()
                .unwrap_or_else(|_| serde_json::json!({}));
            Ok((status, json))
        }
        Err(ureq::Error::Status(status, response)) => {
            let json = response
                .into_json::<serde_json::Value>()
                .unwrap_or_else(|_| serde_json::json!({ "error": "bad_response" }));
            Ok((status, json))
        }
        Err(ureq::Error::Transport(t)) => Err(format!("{t}")),
    }
}

fn fail(status: u16, body: &serde_json::Value, fallback: &str) -> String {
    let message = body.get("message").and_then(|v| v.as_str()).unwrap_or("");
    if !message.is_empty() {
        return message.to_string();
    }
    let code = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
    if !code.is_empty() {
        return format!("{code} (HTTP {status})");
    }
    format!("{fallback} (HTTP {status})")
}

/// Redeem a pairing code for this device's long-lived token.
#[tauri::command]
pub async fn pair_redeem(
    relay_url: String,
    code: String,
    device_name: String,
    app_version: String,
) -> Result<PairResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = http_base(&relay_url)?;
        let (status, body) = post(
            &format!("{base}/v3/pair/redeem"),
            serde_json::json!({
                "code": code.trim(),
                "deviceName": device_name,
                "platform": "windows",
                "appVersion": app_version,
            }),
            None,
        )?;
        if status != 201 {
            return Err(fail(status, &body, "pairing failed"));
        }
        Ok(PairResult {
            device_id: string_at(&body, "deviceId")?,
            device_token: string_at(&body, "deviceToken")?,
            account_id: body
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string(),
        })
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// Mint a pairing code for another device ("Add device").
#[tauri::command]
pub async fn pair_code(relay_url: String, device_token: String) -> Result<PairCode, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = http_base(&relay_url)?;
        let (status, body) = post(
            &format!("{base}/v3/pair/code"),
            serde_json::json!({}),
            Some(&device_token),
        )?;
        if status != 201 {
            return Err(fail(status, &body, "could not create a pairing code"));
        }
        Ok(PairCode {
            code: string_at(&body, "code")?,
            expires_at: body.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0),
            ttl_sec: body.get("ttlSec").and_then(|v| v.as_i64()).unwrap_or(300),
        })
    })
    .await
    .map_err(|e| format!("{e}"))?
}

fn string_at(body: &serde_json::Value, key: &str) -> Result<String, String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("the relay's answer had no {key}"))
}
