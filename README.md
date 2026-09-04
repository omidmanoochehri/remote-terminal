# Remote Terminal

Real terminals on your **Windows and Linux machines, from an Android phone**,
relayed through a small self-hosted server.

One phone, many machines, many terminals — each terminal is a real PTY
(ConPTY on Windows, forkpty on Linux) that keeps running on the machine while
your phone sleeps, changes networks or loses signal, and picks up exactly where
it left off when you come back.

```
                         Remote Terminal Relay  (server/, Node)
                    ┌───────────────────────────────────────┐
                    │ Enrolment · Pairing · Device tokens   │
                    │ Agent registry · Presence             │
                    │ Session routing · Limits · Backpressure│
                    └───────────────────┬───────────────────┘
                                        │ wss (bearer agent token)
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
      Windows agent               Ubuntu agent               Windows agent
      "Office PC"                 "prod-01"                  "Home PC"
       ├─ PowerShell 7             ├─ bash: API logs          └─ PowerShell
       ├─ Command Prompt           ├─ bash: deploy
       └─ Ubuntu (WSL)             └─ zsh
                                        ▲
                                        │ wss (bearer device token)
                    ┌───────────────────┴───────────────────┐
                    │              Android app              │
                    │  Machines → Machine → Terminal tabs   │
                    │  VT/xterm emulator + terminal keyboard │
                    └───────────────────────────────────────┘
```

Version **0.5.0**, wire protocol **v3** — see [`PROTOCOL.md`](./PROTOCOL.md).

---

## What's here

| Path | What it is |
|---|---|
| `server/` | The relay: HTTPS identity endpoints (enrol, pair), WebSocket routing between phones and agents, presence, limits, structured logs, `/stats`. Node, only depends on `ws`. |
| `agent/` | Cross-platform agent (Windows 10/11, Ubuntu 22.04/24.04, other Linux/macOS): hosts many PTY sessions, shell discovery, replay buffers, restricted environment, systemd unit and installers. |
| `android/` | The app (Kotlin, Material 3, no third-party networking/terminal libraries): machines list, machine screen, terminal tabs, full VT/xterm emulator, rich terminal keyboard, selection, search, themes, landscape/tablet layouts. |
| `tools/e2e-linux.js` | End-to-end check: real relay + real Linux agent + scripted phone. |
| `PROTOCOL.md` | The complete v3 protocol: messages, lifecycle, replay, errors, limits. |

---

## Quick start

Prerequisites: **Node.js 18+** on the relay host and on every machine you want to
reach; **Android 7.0+** for the app; JDK 17 + Android SDK to build the app.

### 1. Run the relay

```bash
cd server
npm install
ENROLL_TOKEN='a-long-random-secret' PORT=8080 npm start
```

`ENROLL_TOKEN` is the account's root secret: every agent presents it **once**
to enrol. Keep it private (see [Security](#security)). Without it the relay
runs in *open enrolment* mode for local development and says so loudly.

Health: `curl http://localhost:8080/health` → `ok`. Counters:
`curl http://localhost:8080/stats` → `{"uptimeSec":…, "agentsOnline":…, "phonesOnline":…, "sessions":…, "protocol":3}`.

Use TLS in production (`wss://`): see [TLS and reverse proxies](#tls-and-reverse-proxies).

### 2. Install an agent on each machine

**Ubuntu / Linux (systemd)**

```bash
cd agent
sudo ./install-linux.sh --server wss://relay.example.com --enroll-token '<ENROLL_TOKEN>' --name "Production Server"
```

Add `--allow-root` to run the agent — and therefore every terminal it opens —
as **root** instead of a dedicated user. That gives anyone who pairs a phone
full control of the machine, so use it only where that is what you want.

The script creates a system user `remote-terminal` (choose another with
`--user someone`; that user is who every terminal runs as), installs the agent
under `/opt/remote-terminal-agent`, writes `/etc/remote-terminal-agent/config.json`,
enables the `remote-terminal-agent` service, waits for enrolment and prints:

```
Remote Terminal Agent
  Agent ID:     a_k3x7m2q9p4w8n6b5v1c0
  Relay status: connected
  Pairing code: 483920   (valid 5 minutes)
```

Later: `sudo ./install-linux.sh --pair` (new code), `--status`, `--uninstall`.
Logs: `journalctl -u remote-terminal-agent -f`.

**Windows 10/11**

```powershell
cd agent
npm install
powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Install -Server wss://relay.example.com -EnrollToken <ENROLL_TOKEN> -Name "Office PC"
```

This registers a hidden per-user **logon task** (a Windows Service runs in
session 0 and cannot own an interactive ConPTY), starts it, waits for enrolment
and prints the pairing code. Later: `-Pair`, `-Status`, `-Name "…"`, `-Uninstall`.

**Anywhere, by hand**

```bash
SERVER=wss://relay.example.com ENROLL_TOKEN=… AGENT_NAME="Laptop" node index.js      # runs the agent (enrols on first run)
node index.js --pair      # pairing code for a phone
node index.js --status    # identity + relay status
node index.js --doctor    # PTY backend, discovered shells, config problems
```

### 3. Pair the phone

Build or install the app (`android/`), open it, and enter the **relay URL**
and the **6-digit pairing code** printed by any agent (or by *Paired phones →
Add phone* on an already-paired phone). The phone receives a long-lived device
token, stored encrypted with an Android Keystore key. From now on it sees every
machine of the account automatically — no codes, no rooms.

---

## Using the app

- **Machines** — every enrolled agent with presence (● online / ○ offline + last
  seen), hostname · OS, and how many terminals are running. Machines stay listed
  while offline. Menu: Paired phones, Settings, install help.
- **Machine** — facts, the running terminals (state, age, whether open on this
  phone), *New terminal* with a shell chooser (PowerShell 7 / Windows PowerShell /
  Command Prompt / WSL distributions on Windows; bash / zsh / sh … on Linux; the
  last choice is remembered per machine), rename, copy hostname, remove
  (revokes the agent's token).
- **Terminal** — scrollable tabs (one per terminal, unread-rows badge, close
  offers *Keep running* or *Terminate*), a slim bar with presence, search,
  keyboard and more. Type directly into the terminal; the extra-keys bar has
  Esc · Ctrl · Alt · Tab · arrows · Home/End · PgUp/PgDn · Ins/Del, a symbol row
  (long-press for alternates, e.g. `-`→`_`), and an F-key row (swap with ⇄).
  Ctrl/Alt: tap = next key, double-tap = locked, tap again = off. *Shortcuts*
  (Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L …) and your own command shortcuts need a
  deliberate tap. Long-press selects a word; drag the handles; Copy / Select all
  / Paste (multi-line paste asks first unless the program enabled bracketed
  paste). Pinch to zoom. Scroll up to read history — new output shows
  *↓ N new lines*; tap to jump back. Search the scrollback. In `less`/`vim`
  swipes send arrow keys; programs that enable mouse reporting get real mouse events.
- **Paste an image** — copy a screenshot or photo on the phone, then *Paste*
  (or *Paste image*) in the terminal menu. The file is uploaded to the machine's
  upload directory (`<home>/RemoteTerminal`, mode 0600) and its path is typed at
  the cursor; nothing is executed. Images larger than 16 MiB are refused.
- **Settings** — font size, line spacing, cursor style/blink, colour scheme
  (Default Dark, AMOLED, Light, Solarized Dark, Gruvbox), app theme, keep screen
  on, haptics, bell, OSC 52 clipboard, paste confirmation, command bar, the three
  key rows, command shortcuts, notifications, paired phones, unpair.
- **Landscape** uses a compact one-row key bar and hides the command bar;
  tablets (≥ 600 dp) keep the machine list beside the terminal.

Reconnects are automatic (exponential backoff, immediate on network change).
Terminals are re-attached with their last stream position, so nothing is
duplicated or lost; a machine that comes back online re-attaches its tabs.

---

## How terminals survive (lifecycle)

The **network connection** and the **terminal process** have separate lives:

```
session.create ──▶ running ──(process exits)──▶ exited ──(retention)──▶ closed
                      └──── close / terminate ────┴────────────────────▶ closed
```

- Detaching (phone sleeps, loses Wi-Fi, closes the tab with *Keep running*)
  never touches the shell. Re-attaching replays the missed output from the
  agent's per-session ring buffer using stream positions (`seq`), so nothing is
  shown twice and gaps are detected.
- A **detached** terminal with **no output** for `SESSION_IDLE_TIMEOUT` (default
  6 h) is closed. Long-running jobs keep producing output and are safe.
- An **exited** terminal (the shell ended) keeps its last screen for
  `EXITED_RETENTION_SEC` (default 5 min) so you can read the result.
- Limits: `MAX_SESSIONS_PER_AGENT` (default 16, both agent- and relay-enforced),
  `MAX_SESSIONS_PER_ACCOUNT` (64), `SESSION_CREATE_PER_MIN` per phone (30),
  `REPLAY_BYTES_PER_SESSION` (256 KiB of history per terminal).
- Restarting the agent process ends its terminals (they are child processes);
  the app shows that the terminal is gone rather than attaching to something else.

---

## Configuration

### Relay (`server/`)

Environment variables win over `server/config.json` (copy `config.example.json`),
which wins over defaults.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | 8080 / 0.0.0.0 | Listen address |
| `ENROLL_TOKEN` (alias `AUTH_TOKEN`) | — | Secret agents present once to enrol. **Set it.** |
| `PUBLIC_URL` | — | The `wss://…` URL printed with pairing codes |
| `STATE_FILE` | `server/data/state.json` | Persisted accounts/agents/devices (mode 0600, token hashes only) |
| `TRUST_PROXY` | 0 | Honour `X-Forwarded-For` (last hop) for per-IP limits — only behind your own proxy |
| `TLS_CERT` / `TLS_KEY` | — | Terminate TLS in the relay (`wss://`) |
| `LEGACY_V2` | 0 | Also serve protocol-v2 room clients (isolated, deprecated) |
| `MAX_FRAME_BYTES` | 1 MiB | Max WebSocket message |
| `MAX_CONNS` / `MAX_CONNS_PER_IP` | 1000 / 20 | Connection caps |
| `MSG_PER_SEC` / `AGENT_MSG_PER_SEC` | 200 / 2000 | Per-connection message budgets |
| `HEARTBEAT_MS` | 30000 | WebSocket ping interval |
| `BACKPRESSURE_HIGH_BYTES` / `_LOW_BYTES` | 4 MiB / 512 KiB | Slow-phone handling (output is dropped and replayed on re-attach) |
| `MAX_SESSIONS_PER_AGENT` / `MAX_SESSIONS_PER_ACCOUNT` | 16 / 64 | Terminal caps |
| `MAX_AGENTS_PER_ACCOUNT` / `MAX_DEVICES_PER_ACCOUNT` | 50 / 20 | Identity caps |
| `SESSION_CREATE_PER_MIN` | 30 | Per phone |
| `MAX_INPUT_BYTES` | 1 MiB | Largest single input message |
| `PAIRING_TTL_SEC` | 300 | Pairing-code lifetime |
| `PAIR_PER_IP_PER_MIN` / `PAIR_LOCKOUT_SEC` | 5 / 900 | Redeem attempts per IP, lockout after exceeding |
| `PAIR_GLOBAL_PER_MIN` / `PAIR_GLOBAL_LOCKOUT_SEC` | 100 / 60 | Relay-wide failed-redeem budget |
| `ENROLL_PER_IP_PER_MIN` | 10 | Enrolment attempts per IP |
| `LOG_LEVEL` | info | `error` \| `warn` \| `info` \| `debug` (JSON lines) |

Multiple accounts: add `"accounts": [{"id": "team-b", "enrollToken": "…"}]` to
`config.json`; each enrolment token maps to its own isolated account.

### Agent (`agent/`)

Environment variables win over `config.json` (`CONFIG=/path/to/config.json`,
default next to `index.js`; the installers use `/etc/remote-terminal-agent/config.json`).

| Variable | Default | Meaning |
|---|---|---|
| `SERVER` | `ws://127.0.0.1:8080` | Relay URL |
| `ENROLL_TOKEN` (alias `TOKEN`) | — | The relay's enrolment secret (needed once) |
| `AGENT_NAME` | hostname | Display name (rename later from the app or `--name`) |
| `AGENT_STATE` | `agent/state.json` | Identity file (agentId + token, mode 0600) |
| `DEFAULT_SHELL` | pwsh/bash | Shell id offered first |
| `shells` (config file only) | discovered | Allowlist `[{"id","label","cmd","args"}]` replacing discovery |
| `SHELL_CWD` | home directory | Working directory for new terminals |
| `MAX_SESSIONS_PER_AGENT` | 16 | Terminal cap |
| `SESSION_IDLE_TIMEOUT` | 21600 s | Close detached terminals silent this long |
| `EXITED_RETENTION_SEC` | 300 | Keep exited terminals this long |
| `REPLAY_BYTES_PER_SESSION` | 262144 | History kept per terminal |
| `MAX_INPUT_BYTES` | 1 MiB | Largest accepted input message |
| `INHERIT_ENV` | 0 | Pass the agent's **entire** environment to shells (not recommended) |
| `UPLOADS_DIR` | `<home>/RemoteTerminal` | Where files pasted from a phone are written (0700, files 0600) |
| `MAX_UPLOAD_BYTES` / `MAX_UPLOADS` | 16 MiB / 3 | Largest pasted file, and transfers in flight per phone |
| `UPLOAD_TIMEOUT_SEC` | 120 | A stalled transfer is discarded after this |
| `ALLOW_ROOT` | 0 | Permit running as root on Linux |
| `LOG_LEVEL` | info | |
| `BASE_BACKOFF_MS` / `MAX_BACKOFF_MS` | 1000 / 30000 | Reconnect backoff |

Shell discovery is deliberate, not arbitrary: Windows offers PowerShell 7
(`pwsh`), Windows PowerShell, Command Prompt and each WSL distribution; Linux
offers the shells in `/etc/shells` that exist (and `$SHELL`). The phone only
ever sends a shell **id**; command lines come from the agent's config or
discovery. By default shells receive a minimal environment allowlist
(`PATH`, `HOME`, `USER`, locale, `TERM=xterm-256color`, … on Linux;
`SystemRoot`, `USERPROFILE`, `PSModulePath`, … on Windows) — never the agent's
tokens or other secrets.

---

## TLS and reverse proxies

Terminate TLS in the relay:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=relay.example.com"
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=8443 ENROLL_TOKEN=… npm start   # wss://relay.example.com:8443
```

Or run plain `ws://` on localhost behind nginx/Caddy. The proxy must forward
**both** the WebSocket upgrade and the plain HTTPS identity endpoints
(`/v3/enroll`, `/v3/pair/code`, `/v3/pair/redeem`, `/v3/agents/me`):

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.com;
    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;   # long-lived terminal connections
        client_max_body_size 64k;
    }
}
```

Start the relay with `TRUST_PROXY=1` so per-IP limits see the real client
address (the relay uses the **last** `X-Forwarded-For` hop, i.e. the one your
proxy appended).

---

## Security

Remote shell access deserves a careful setup:

- **Transport**: `wss://` everywhere in production. The app warns before pairing
  over `ws://` to a non-private address; the agent never sends its token in a URL
  (bearer header).
- **Identity**: nothing is authenticated by names, ids, rooms or codes. Agents
  and phones hold random 256-bit tokens; the relay stores only SHA-256 hashes
  and compares in constant time. Pairing codes are 6 digits, single-use,
  5-minute, one per issuer, rate-limited per IP and relay-wide, and burned after
  repeated wrong guesses.
- **Authorization**: every routed message is checked — the target agent must be
  in the caller's account, input/resize require an attached session, and agents
  can only speak for their own sessions. Accounts are fully isolated.
- **Revocation is immediate**: removing a machine or a phone closes its live
  socket with `4401`; the agent stops, marks its identity invalid and refuses
  to re-enrol automatically (`--enroll` is explicit). Unpairing the phone wipes
  the Keystore-wrapped token.
- **Blast radius**: by default the agent runs as an unprivileged user (the
  installer creates one and refuses root unless `--allow-root` / `ALLOW_ROOT=1`,
  which makes every terminal a root shell); shells get a minimal env;
  `install-linux.sh` puts the program under root-owned `/opt` and the identity
  under the service user only. Optional systemd hardening lines
  (`NoNewPrivileges`, `ProtectSystem`) are in the unit file — they also forbid
  `sudo` inside terminals, so enable them consciously.
- **Abuse controls**: connection caps, message budgets, frame size, session and
  identity caps, pairing/enrolment limiters, backpressure for slow phones.
- **Logs**: JSON with `connId`/`agentId`/`sessionId`/`role`/`v`; tokens, codes
  and authorization headers are redacted; terminal input/output is never logged
  (only lengths).
- **App storage**: the device token is AES-GCM encrypted with a non-exportable
  Android Keystore key; backups are disabled (`allowBackup=false`).

---

## Upgrading from 0.2 (protocol v2)

0.3 is a new architecture: accounts, enrolled agents with tokens, paired
devices, many sessions per agent. Rooms and the shared `AUTH_TOKEN` gate are gone.

1. Deploy the 0.3 relay. Set `ENROLL_TOKEN` (your old `AUTH_TOKEN` value is a
   reasonable choice). Reverse proxies must also forward `/v3/*`.
2. Reinstall each agent with the 0.3 installer (it enrols itself). Old
   `ROOM`/`TOKEN` settings are ignored (`TOKEN` is accepted as the enrolment token).
3. Install the 0.3 app and pair it with a code from any agent. Old connection
   profiles are not migrated (they carried no reusable identity).
4. Staged rollout: start the relay with `LEGACY_V2=1` to keep serving 0.2
   agents/apps in an isolated room table while you upgrade machines. Legacy
   clients never see v3 machines and vice versa. Turn it off when done.

A 0.2 client on a v3-only relay is refused with close code `4426`.

---

## Building the Android app

```bash
cd android
./gradlew assembleDebug            # → app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest        # JVM unit tests (emulator, key encoder, framing, protocol)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Release builds (`assembleRelease` / `bundleRelease`) are minified with R8 and
signed with the key referenced by `android/keystore.properties` (gitignored).
First-time key setup:

```bash
keytool -genkeypair -v -keystore keystore/release.jks -alias remoteterminal \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Remote Terminal, O=Cactus Software Group, C=US"
# keystore.properties: storeFile=keystore/release.jks, storePassword=…, keyAlias=remoteterminal, keyPassword=…
```

### Dependencies

The app deliberately keeps its dependency list small and boring: AndroidX
core/appcompat/activity/fragment/lifecycle/recyclerview/constraintlayout/
preference, Material Components, Kotlin coroutines, and JUnit 4 (+ org.json)
for JVM tests. Networking (RFC 6455 WebSocket with TLS hostname verification,
HTTP pairing calls) and the terminal emulator are dependency-free and unit
tested; `preference` was added because a settings screen is a lot of fragile
code to hand-write, `coroutines`/`lifecycle` because a multi-machine client
needs structured lifecycle-aware state.

---

## Tests

```bash
cd server && npm test        # relay: identity, pairing, auth, routing, isolation, revocation, limits, legacy mode
cd agent  && npm test        # agent: ring buffer, env, shells (Windows + Linux), session manager, relay client, real bash PTY
node tools/e2e-linux.js      # real relay + real Linux agent + scripted phone: the end-to-end scenario
cd android && ./gradlew testDebugUnitTest
```

`tools/e2e-linux.js` enrols an agent, pairs a phone, opens two bash terminals,
checks routing, ANSI colours, Ctrl+C, resize, phone reconnect with `since`
(same shell process, no duplicates), full replay, closing one terminal, exit
codes, agent restart (new instance id) and revocation.

---

## Limitations and roadmap

- Restarting the agent process ends its terminals (no tmux-style survival yet).
- Two phones attached to one terminal share its size (last writer wins).
- The app's rotation recreates the screen; tabs and shells persist, the scroll
  position does not.
- Roadmap: optional binary framing, per-user audit log, mutual TLS or device
  attestation, session survival across agent restarts via `tmux`/`screen`.
