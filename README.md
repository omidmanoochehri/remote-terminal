# Remote Terminal

Use a **Windows terminal from an Android phone**, relayed through a server.

Three components, all in this repo:

```
 ┌────────────┐  wss (input/resize)   ┌────────────┐  wss (input/resize)   ┌────────────────────┐
 │  Android   │ ────────────────────▶ │   Server   │ ────────────────────▶ │   Windows agent    │
 │   app      │                       │  (relay)   │                       │  real PowerShell   │
 │ (Kotlin)   │ ◀──────────────────── │  Node ws   │ ◀──────────────────── │  PTY via node-pty  │
 └────────────┘  wss (output/replay)  └────────────┘  wss (output/replay)  └────────────────────┘
```

The phone and the agent both connect **out** to the server and are paired by a
`room` (session id), so it works across networks/NAT. The agent spawns a real
PowerShell terminal (ConPTY) and streams it to the phone, which renders it with
a full VT/ANSI emulator (colours, cursor addressing, alternate screen for
TUIs like `vim`/`htop`).

The wire protocol shared by all three parts is documented in
[`PROTOCOL.md`](./PROTOCOL.md) (**protocol v2**).

---

## What's here

| Path          | What it is                                                                    |
|---------------|-------------------------------------------------------------------------------|
| `server/`     | Node relay: pairs a phone and agent by room, with auth, pairing codes, rate limiting, heartbeat, `/stats`. |
| `agent/`      | Node Windows agent: real PTY (`node-pty`), restricted env, exponential-backoff reconnect, scrollback replay. |
| `android/`    | Android app (Kotlin, Material 3): VT/ANSI terminal view, connection profiles, sticky Ctrl/Alt keys, auto-reconnect, `wss://`. |
| `PROTOCOL.md` | The JSON-over-WebSocket message format (v2).                                  |

### Feature highlights

- **Full VT/ANSI rendering** on the phone — 16/256/true-colour, bold/underline/
  reverse, cursor moves, erase, scroll regions, and the alternate screen buffer.
- **Colours + TUIs** work (`vim`, `htop`, `less`), not just line output.
- **Scrollback replay**: reconnect mid-session and the recent output is restored.
- **Command history**, **copy** (long-press a line) / **paste** (Paste key), and
  **pinch-to-zoom** font sizing.
- **Connection profiles** (named server/room/token/pairing), saved on-device.
- **Security**: `wss://` TLS, per-connection auth token, short-lived pairing
  codes, rate limiting, connection caps, and structured/redacted logs.

---

## Prerequisites

- **Node.js** 18+ (built/tested on Node 24).
- **Windows** for the agent (it launches PowerShell via ConPTY).
- **Android SDK + JDK 17** to build the app.

---

## Run it

### 1. Server (relay)

```bash
cd server
npm install
PORT=8080 npm start           # listens on ws://0.0.0.0:8080
```

Health check: `curl http://localhost:8080/health` → `ok`.
Live stats: `curl http://localhost:8080/stats` → JSON (rooms, connections, uptime).

Configure via environment variables **or** a `server/config.json` (copy
`config.example.json`). Env wins over file wins over defaults:

| Var                 | Default   | Meaning                                             |
|---------------------|-----------|-----------------------------------------------------|
| `PORT` / `HOST`     | 8080 / 0.0.0.0 | Listen address                                 |
| `AUTH_TOKEN`        | (none)    | Shared secret every client must present             |
| `MAX_FRAME_BYTES`   | 1048576   | Oversized frames are refused                        |
| `MAX_CONNS`         | 1000      | Global connection cap                               |
| `MAX_CONNS_PER_IP`  | 20        | Per-IP connection cap                               |
| `MSG_PER_SEC`       | 200       | Per-connection message rate limit                   |
| `HEARTBEAT_MS`      | 30000     | ping/pong interval that reaps dead sockets          |
| `TLS_CERT`/`TLS_KEY`| (none)    | Enable `wss://` by terminating TLS in the relay     |
| `LOG_LEVEL`         | info      | error \| warn \| info \| debug (JSON-lines output)  |

Pairing codes are configured in `config.json` (`"pairing": {"enabled": true}`).

Run the tests: `npm test` (relay integration + auth/pairing unit tests).

#### TLS (`wss://`)

Either point `TLS_CERT`/`TLS_KEY` at a cert/key pair to terminate TLS in the
relay, **or** run plain `ws://` behind a TLS-terminating reverse proxy
(nginx/Caddy). For a quick local test cert:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=8443 npm start   # wss://host:8443
```

### 2. Windows agent

```bash
cd agent
npm install                   # pulls a prebuilt node-pty (no compiler needed)
SERVER=wss://<server-host>:8443 ROOM=my-pc TOKEN=<secret> npm start
```

Config via env or `agent/config.json` (copy `config.example.json`): `SERVER`,
`ROOM`, `TOKEN`, `SHELL_CMD`, `REPLAY_BYTES`, `MAX_INPUT_BYTES`, `INHERIT_ENV`,
`LOG_LEVEL`, and backoff tuning. By default the shell gets only a **minimal env
allowlist** (not the agent's full environment) — set `INHERIT_ENV=1` to opt out.

Run it **automatically at logon** (survives logout/reboot, keeps the interactive
session a PTY needs):

```powershell
powershell -ExecutionPolicy Bypass -File agent\install-task.ps1 -Install
# remove with: -Uninstall
```

### 3. Android app

Install the prebuilt debug APK, or build it:

```bash
cd android
./gradlew assembleDebug       # -> app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

In the app:

1. Tap the profile label (or **⋮ → Profiles**) to add a connection: a name, the
   server URL (`ws://` or `wss://`), the room, and optionally an auth token and
   pairing code.
2. Tap **Connect**. The status chip turns green at *agent online*.
3. Type in the input box and **Send**, or tap the terminal to raise the keyboard
   and type directly (works with TUIs). The key bar has **Ctrl/Alt** sticky
   modifiers plus Esc/Tab/arrows/Ctrl+C/Paste. Long-press a line to copy;
   pinch to zoom.

#### Release build (signed)

```bash
cd android
./gradlew assembleRelease     # -> app/build/outputs/apk/release/app-release.apk
./gradlew bundleRelease       # -> app/build/outputs/bundle/release/app-release.aab
```

Release builds are minified with R8 and signed using the key referenced by
`android/keystore.properties` (gitignored). See the signing block below for
first-time key setup.

<details>
<summary>Signing setup on a fresh checkout</summary>

```bash
cd android
keytool -genkeypair -v -keystore keystore/release.jks -alias remoteterminal \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Remote Terminal, O=Cactus Software Group, C=US"
# then create keystore.properties:
#   storeFile=keystore/release.jks
#   storePassword=...
#   keyAlias=remoteterminal
#   keyPassword=...
```

Keep `keystore/` and `keystore.properties` out of version control. Verify a
build's signer with `apksigner verify --print-certs app-release.apk`.
</details>

---

## Security

This is no longer just a slice — the core hardening is in place, but review
before exposing to the internet:

- **Transport:** use `wss://` (TLS in the relay or a reverse proxy). `ws://`
  remains for local/dev.
- **Auth:** set `AUTH_TOKEN` so every client must present a shared secret, and/or
  enable **pairing codes** (the agent prints a short-lived code the phone
  enters). The `room` is a session id, not the secret.
- **Blast radius on the agent:** the shell runs as the agent's user with a
  minimal env by default; anyone who authenticates gets that shell — run the
  agent as a least-privileged user.
- **Abuse controls:** per-IP/global connection caps, per-connection message rate
  limiting, and a max frame size are enforced by the relay.
- **Logs:** structured JSON with tokens/codes redacted.

Still worth adding for a hardened deployment: per-user identities/audit logging,
mutual TLS or device attestation, and origin/allowlist policies.

## Why the app still has a hand-rolled WebSocket

The networking path is a dependency-free RFC 6455 client in
[`MiniWebSocket.kt`](./android/app/src/main/java/com/cactus/remoteterminal/MiniWebSocket.kt)
(now with `wss://` TLS + a keepalive ping). The UI uses Material 3 /
ConstraintLayout, resolved through the Aliyun Maven mirrors this build
environment can reach.

## Roadmap

- Multiple concurrent sessions/tabs (protocol already reserves a `session` id).
- Per-user auth + audit logging; mutual TLS / device attestation.
- Optional binary framing for high-throughput output.
