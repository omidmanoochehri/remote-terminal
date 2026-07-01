# Remote Terminal

Use a **Windows terminal from an Android phone**, relayed through a server.

Three components, all in this repo:

```
 ┌────────────┐   ws (input/resize)   ┌────────────┐   ws (input/resize)   ┌────────────────────┐
 │  Android   │ ────────────────────▶ │   Server   │ ────────────────────▶ │   Windows agent    │
 │   app      │                       │  (relay)   │                       │  real PowerShell   │
 │ (Kotlin)   │ ◀──────────────────── │  Node ws   │ ◀──────────────────── │  PTY via node-pty  │
 └────────────┘   ws (output/exit)    └────────────┘   ws (output/exit)    └────────────────────┘
```

The phone and the agent both connect **out** to the server and are paired by a
shared `room` token, so it works across networks/NAT. The agent spawns a real
PowerShell terminal (ConPTY) and streams it to the phone.

> **Status: working vertical slice.** One shell session, minimal pairing (a shared
> room token), a lightweight terminal renderer. Verified end-to-end on an Android
> emulator: `whoami` typed in the app ran in a real PowerShell PTY on Windows and
> the output rendered back on the phone. See [Verification](#verification).

The wire protocol shared by all three parts is documented in
[`PROTOCOL.md`](./PROTOCOL.md).

---

## Layout

| Path       | What it is                                                              |
|------------|-------------------------------------------------------------------------|
| `server/`  | Node.js WebSocket relay. Pairs a `phone` and an `agent` by room token.   |
| `agent/`   | Node.js Windows agent. Real PTY (`node-pty`), streams the shell.         |
| `android/` | Android app (Kotlin). Framework-only, hand-rolled WebSocket client.     |
| `PROTOCOL.md` | The JSON-over-WebSocket message format.                              |

---

## Prerequisites

- **Node.js** 18+ (built/tested on Node 24).
- **Windows** for the agent (it launches PowerShell via ConPTY).
- **Android SDK + JDK 17** to build the app. A prebuilt debug APK comes out of
  `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## Run it

### 1. Server (relay)

```bash
cd server
npm install
PORT=8080 npm start          # listens on ws://0.0.0.0:8080
```

Health check: `curl http://localhost:8080/health` → `ok`.

Deploy this anywhere both the phone and the PC can reach. For the phone to reach
it over the internet, run it on a host with a public address (or a tunnel), and
prefer `wss://` + real auth before doing that for real (see
[Security](#security--limitations)).

### 2. Windows agent

```bash
cd agent
npm install                  # pulls a prebuilt node-pty (no compiler needed)
SERVER=ws://<server-host>:8080 ROOM=demo npm start
```

Environment variables:

| Var         | Default              | Meaning                          |
|-------------|----------------------|----------------------------------|
| `SERVER`    | `ws://127.0.0.1:8080`| Relay URL                        |
| `ROOM`      | `demo`               | Pairing token (match the phone)  |
| `SHELL_CMD` | `powershell.exe`     | Shell to launch                  |

The agent auto-reconnects if the relay drops. If the prebuilt PTY can't load, it
falls back to a piped child process (no true TTY, but still functional).

### 3. Android app

Install the prebuilt debug APK:

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

or build it yourself:

```bash
cd android
./gradlew assembleDebug
```

#### Release build (signed)

A signed release APK and a Play-ready AAB are produced by:

```bash
cd android
./gradlew assembleRelease   # -> app/build/outputs/apk/release/app-release.apk (~33 KB)
./gradlew bundleRelease     # -> app/build/outputs/bundle/release/app-release.aab
```

Release builds are minified/shrunk with R8 and signed using the key referenced
by `android/keystore.properties` (gitignored). To set up signing on a fresh
checkout:

```bash
cd android
keytool -genkeypair -v -keystore keystore/release.jks -alias remoteterminal \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Remote Terminal, O=Cactus Software Group, C=US"
# then create keystore.properties (see the committed example fields):
#   storeFile=keystore/release.jks
#   storePassword=...
#   keyAlias=remoteterminal
#   keyPassword=...
```

Keep `keystore/` and `keystore.properties` out of version control — losing the
key means you can't update an app already published under it. Verify a build's
signer with `apksigner verify --print-certs app-release.apk`. The release build
was smoke-tested on an emulator (connect + `whoami` round-trip) to confirm R8
didn't strip anything.

In the app:

1. **Server** — `ws://<server-host>:8080`
   (on the Android emulator, the host machine is `ws://10.0.2.2:8080` — the default).
2. **Room** — the same token the agent uses (`demo`).
3. Tap **Connect**. When it shows *agent online*, type a command and **Send**.
   The bottom row has `Esc / Tab / Ctrl+C / Up / Down / Enter / Clear`.

---

## Verification

Reproduced end-to-end with the relay + agent on Windows and the app on an
`android-31` x86_64 emulator:

1. `server` and `agent` started; agent logged `spawned PTY: powershell.exe`.
2. App connected (`ws://10.0.2.2:8080`, room `demo`); server logged
   `room demo: phone connected`; app showed **agent online**.
3. Typed `whoami` → **Send**. The terminal showed the command, its output, and
   the next `PS C:\Users\...>` prompt.

The server↔agent pipe is also independently checked with a Node phone-simulator
(an `echo` command round-tripped through the real PTY).

---

## Security & limitations

This is a slice meant to prove the pipeline, **not** production-ready:

- **Transport is plain `ws://`** — no TLS. Add `wss://` (terminate TLS at the
  relay or a reverse proxy) before using off-LAN.
- **Auth is just the room token.** Anyone with the server URL + token gets the
  shell. Add real authentication and per-session authorization.
- The Android side is a **lightweight terminal**, not a full ANSI emulator
  (see `TerminalBuffer.kt`): it strips escape sequences and handles CR/LF/BS/TAB.
  Full-screen TUIs (vim, htop) won't render correctly yet.
- One agent + one phone per room.

## Why the app has no third-party dependencies

The Android app is deliberately **framework-only** — no AndroidX, Material, or
OkHttp — with a hand-rolled RFC 6455 client in
[`MiniWebSocket.kt`](./android/app/src/main/java/com/cactus/remoteterminal/MiniWebSocket.kt).
The build environment here can only reach Maven via Aliyun mirrors, so keeping
the app dependency-free makes it build reliably and keeps the APK ~800 KB.

## Next steps

- `wss://` + token/device auth and a pairing-code UX.
- Full ANSI/VT rendering (or embed `xterm.js` in a WebView).
- Multiple concurrent sessions/tabs; reconnect with scrollback replay.
- Agent as a tray app / Windows service.
