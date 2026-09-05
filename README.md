# Remote Terminal

**Real terminals on your Windows and Linux machines, from an Android phone**,
relayed through a small server you host yourself.

One phone, many machines, many terminals. Each terminal is a real PTY — ConPTY
on Windows, `forkpty` on Linux — that keeps running on the machine while your
phone sleeps, changes networks or loses signal, and picks up exactly where it
left off when you come back.

```
                         Remote Terminal Relay  (server/, Node)
                    ┌────────────────────────────────────────┐
                    │ Enrolment · Pairing · Device tokens     │
                    │ Agent registry · Presence               │
                    │ Session routing · Limits · Backpressure │
                    └───────────────────┬────────────────────┘
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
                    ┌───────────────────┴────────────────────┐
                    │               Android app              │
                    │ Home · Machines · Terminals · Settings │
                    │  VT/xterm emulator + terminal keyboard │
                    └────────────────────────────────────────┘
```

Version **0.7.1**, wire protocol **v3** — see [`PROTOCOL.md`](./PROTOCOL.md)
for the complete wire format.

---

## Table of contents

- [What it does](#what-it-does)
- [What's in this repository](#whats-in-this-repository)
- [Quick start](#quick-start)
- [Using the app](#using-the-app)
- [How terminals survive](#how-terminals-survive)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [TLS and reverse proxies](#tls-and-reverse-proxies)
- [Security](#security)
- [Operating the relay](#operating-the-relay)
- [Troubleshooting](#troubleshooting)
- [Building the Android app](#building-the-android-app)
- [Tests](#tests)
- [Versioning and releases](#versioning-and-releases)
- [Upgrading from 0.2 (protocol v2)](#upgrading-from-02-protocol-v2)
- [Limitations and roadmap](#limitations-and-roadmap)

---

## What it does

- **Real shells, not a remote-control gimmick.** Every terminal is a PTY owned
  by the machine: `vim`, `htop`, `less`, `git`, `npm`, colours, resizing,
  Ctrl+C, mouse reporting and bracketed paste all behave the way they do on a
  desktop terminal.
- **Sessions outlive the phone.** Detaching — sleep, lost Wi-Fi, closing a tab
  with *Keep running* — never touches the shell. Re-attaching replays exactly
  the output you missed, from a per-session ring buffer, using stream positions,
  so nothing is duplicated and gaps are detected rather than papered over.
- **Many machines, one account.** Enrol every machine once against your relay;
  pair each phone once. From then on the phone sees every machine of the
  account automatically — no rooms, no per-machine credentials, no port
  forwarding, no inbound firewall rules (agents dial *out* to the relay).
- **Windows is a first-class citizen**, not an afterthought: PowerShell 7,
  Windows PowerShell, Command Prompt and every WSL distribution are discovered
  and offered by name.
- **Self-hosted and small.** The relay and the agent depend on `ws` (plus a
  prebuilt PTY binding on the agent) and nothing else. The Android app brings
  its own WebSocket client and its own terminal emulator, both unit tested.
- **Built for a phone, not shrunk to fit one.** A terminal keyboard with sticky
  modifiers, symbol and F-key rows, saved presets, per-terminal themes, tabs
  with unread counts, selection with handles, scrollback search, pinch zoom, and
  live CPU / memory / disk / uptime for every machine.

---

## What's in this repository

| Path | What it is |
|---|---|
| `server/` | The relay: HTTPS identity endpoints (enrol, pair), WebSocket routing between phones and agents, presence, limits, backpressure, structured JSON logs, `/health` and `/stats`. Node; only dependency is `ws`. |
| `agent/` | The cross-platform agent (Windows 10/11, Ubuntu 22.04/24.04, other Linux, macOS): hosts many PTY sessions, discovers shells, keeps replay buffers, publishes system metrics, receives pasted files. Ships a systemd unit and installers for Linux and Windows. |
| `android/` | The app (Kotlin, Material 3): Home, Machines, Terminals and Settings, a full VT/xterm emulator, a hand-written RFC 6455 WebSocket client, and no third-party networking or terminal libraries. |
| `tools/e2e-linux.js` | End-to-end check: a real relay, a real Linux agent and a scripted phone, in one process. |
| `PROTOCOL.md` | The complete v3 protocol: identifiers, endpoints, messages, replay, lifecycle, errors, limits. |
| `CLAUDE.md` | Repository conventions: versioning, release builds, test commands. |

---

## Quick start

**Prerequisites** — Node.js 18+ on the relay host and on every machine you want
to reach; Android 7.0 (API 24) or newer for the app; JDK 17 and the Android SDK
if you build the app yourself.

### 1. Run the relay

```bash
cd server
npm install
ENROLL_TOKEN='a-long-random-secret' PORT=8080 npm start
```

`ENROLL_TOKEN` is the account's root secret: every agent presents it **once**,
at enrolment, and never again. Keep it private (see [Security](#security)).
Without it the relay runs in *open enrolment* mode, intended for local
development only, and says so loudly at start-up.

Check it:

```bash
curl http://localhost:8080/health   # → ok
curl http://localhost:8080/stats    # → {"uptimeSec":…,"agentsOnline":…,"phonesOnline":…,"sessions":…,"protocol":3}
```

Use TLS in production (`wss://`) — see [TLS and reverse proxies](#tls-and-reverse-proxies).

### 2. Install an agent on each machine

**Ubuntu / Linux (systemd)**

```bash
cd agent
sudo ./install-linux.sh \
  --server wss://relay.example.com \
  --enroll-token '<ENROLL_TOKEN>' \
  --name "Production Server"
```

The script creates a system user `remote-terminal` (choose another with
`--user someone` — that user is who every terminal runs as), installs the agent
under `/opt/remote-terminal-agent`, writes
`/etc/remote-terminal-agent/config.json`, enables the `remote-terminal-agent`
service, waits for enrolment and prints:

```
Remote Terminal Agent
  Agent ID:     a_k3x7m2q9p4w8n6b5v1c0
  Relay status: connected
  Pairing code: 483920   (valid 5 minutes)
```

Add `--allow-root` to run the agent — and therefore every terminal it opens —
as **root** instead of a dedicated user. That hands anyone who pairs a phone
full control of the machine, so use it only where that is precisely what you
want. Other flags: `--dir` (install location), `--no-start`, and `--purge`
(also delete config and identity when uninstalling).

Later:

```bash
sudo ./install-linux.sh --pair       # a fresh pairing code
sudo ./install-linux.sh --status     # identity + relay status
sudo ./install-linux.sh --uninstall  # remove service and program
journalctl -u remote-terminal-agent -f
```

**Windows 10/11**

```powershell
cd agent
npm install
powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Install `
  -Server wss://relay.example.com -EnrollToken <ENROLL_TOKEN> -Name "Office PC"
```

This registers a hidden per-user **logon task** — a Windows Service runs in
session 0 and cannot own an interactive ConPTY — starts it, waits for enrolment
and prints the pairing code. Later: `-Pair`, `-Status`, `-Name "…"`,
`-Uninstall`.

**Anywhere, by hand**

```bash
SERVER=wss://relay.example.com ENROLL_TOKEN=… AGENT_NAME="Laptop" node index.js
```

```
node index.js                 run the agent (enrols on first run)
node index.js --pair          print a pairing code for a phone
node index.js --status        local identity and relay-side status
node index.js --doctor        check PTY support, discovered shells, configuration
node index.js --name "Name"   rename this machine (relay + local)
node index.js --enroll        enrol explicitly (replaces the current identity)
node index.js --reset         delete the local identity file
--config <path>               use this config.json (default: $CONFIG or ./config.json)
--allow-root                  allow running as root on Linux (not recommended)
```

### 3. Pair the phone

Install the app, open it, and either **scan the QR code** or type the **relay
URL** and the **6-digit pairing code** printed by any agent. An already-paired
phone can issue a code for the next one: *Settings → Paired phones → Add phone*.

The phone receives a long-lived device token, encrypted with a non-exportable
Android Keystore key. From then on it sees every machine on the account — no
codes, no rooms, nothing per-machine to configure.

---

## Using the app

Four destinations sit behind a floating navigation bar; every other screen is
pushed over them.

### Home

The machines you actually use — favourites first, then the ones with running
terminals — the terminals you left behind, and four counts that lead into the
rest of the app. Everything on it is live account state; there is no separate
cache to go stale.

### Machines

Every enrolled machine, with search, presence filter chips (All / Online /
Offline) and a sort you choose (status, name, or most recently seen). Each card
carries what decides whether you can work on it right now: presence (● online /
○ offline with *last seen*), hostname and OS, running terminals, agent version,
latency — and one primary action. Machines stay listed while offline.

### One machine

A segmented screen:

- **Terminals** — what is running, its state and age, and whether it is open on
  this phone. *New terminal* opens a form with a shell chooser (PowerShell 7 /
  Windows PowerShell / Command Prompt / each WSL distribution on Windows;
  bash / zsh / sh … on Linux — the last choice is remembered per machine), a
  working directory (recent ones offered) and an optional start-up command.
  Saved presets appear as one-tap chips.
- **Details** — hostname, OS, architecture, agent version, and live **CPU /
  memory / disk / uptime** reported by the agent on Windows and Linux alike. A
  figure a platform cannot answer reads *not reported* rather than zero.
- **Settings** — rename the machine on the relay, plus this phone's policy for
  it: auto-reconnect, keep-alive, connection alerts. Also *remove machine*,
  which revokes the agent's token.

### Terminals

Every terminal on the account, grouped by machine, with search and filters
(All / Active / Detached / Pinned). Sessions live on the agents, so this list is
what the relay reports plus the tabs this phone happens to have open — nothing
is invented locally. Each row's menu offers Open, Duplicate, Rename, Pin,
Disconnect (keep running) and Terminate, with the same wording and the same
confirmations wherever you tap it.

### A terminal

- **Tabs** — one per terminal, scrollable, with an unread-rows badge. Closing a
  tab asks *Keep running* or *Terminate*. Swipe left/right to switch tabs
  (optional).
- **Typing** — type straight into the terminal. The extra-keys bar carries
  Esc · Ctrl · Alt · Tab · arrows · Home/End · PgUp/PgDn · Ins/Del, a symbol row
  (long-press for the alternate, e.g. `-` → `_`) and an F-key row (swap with ⇄).
  Ctrl/Alt: tap = next key only, double-tap = locked, tap again = off. All three
  rows are editable in Settings.
- **Shortcuts** — a sheet with Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L … and your own
  command shortcuts. Everything needs a deliberate tap; nothing is sent by
  accident. An optional command bar sends whole lines and keeps a local history
  of the last 500.
- **Reading** — scroll up through the scrollback; new output shows *↓ N new
  lines*, tap to jump back. Search the scrollback and step between matches.
  Pinch to zoom. Long-press selects a word, handles adjust the selection, and
  the action bar offers Copy / Select all / Paste. Multi-line pastes ask first
  unless the program enabled bracketed paste.
- **Programs that take over the screen** — in `less`/`vim`, swipes send arrow
  keys; programs that enable mouse reporting get real mouse events instead.
- **Menu** — new terminal, duplicate (same machine, same directory), start a
  preset, rename, pin, shortcuts, paste, paste image, attach file, per-terminal
  colour scheme, select all, clear, toggle the command bar or the key rows,
  close.

### Presets

A saved way to start a terminal: a name, a machine (or *any machine*, which
asks when it runs), a shell, a working directory and a start-up command typed
into the new shell as its first line. Save one from the New terminal form, or
manage them under *Settings → Terminal presets*. Presets live on the phone;
launching one produces exactly the traffic that filling in the form by hand
would, so nothing about the protocol changes.

### Sending a file into a terminal

Copy a screenshot or photo on the phone and choose *Paste image*, or pick any
file with *Attach file*. The file is uploaded to the machine's upload directory
(`<home>/RemoteTerminal`, directory 0700, files 0600) and its path is typed at
the cursor. Nothing is executed. Files larger than 16 MiB are refused.

### Settings

- **Appearance** — app theme; terminal font (bundled mono or the system font)
  and size, line spacing, cursor style and blink, with a live preview.
- **Terminal** — presets, swipe between tabs, show the key rows, command
  notifications, command history, command bar, scrollback size (500–50 000
  lines), keep screen on, OSC 52 clipboard, paste-confirmation threshold, bell
  (off / vibrate / sound), haptics. Colour schemes: Remote, Default Dark,
  AMOLED, Light, Solarized Dark, Gruvbox — set app-wide, or per terminal from
  the terminal menu.
- **Keyboard** — edit the three key rows, and your own command shortcuts.
- **Notifications** — machine went offline, terminal exited, terminal rang the
  bell. Quiet by design: raised only while the app is in the background, and
  never for ordinary output.
- **Security & connection** — app lock (the device credential prompt:
  fingerprint, face or PIN — whatever the phone is set up for, with no biometric
  library pulled in), the relay URL, paired phones, this device's id, and
  *unpair*, which wipes the Keystore-wrapped token.

### Layout and connectivity

The app draws edge to edge and pads its own chrome out of the status bar,
navigation bar, display cutout and keyboard. Landscape uses a compact one-row
key bar and hides the command bar; tablets (≥ 600 dp) keep the machine list
beside the terminal.

Reconnects are automatic — exponential backoff, and an immediate retry when the
network comes back. Terminals are re-attached at their last stream position, so
nothing is duplicated or lost; a machine that comes back online re-attaches its
tabs by itself.

---

## How terminals survive

The **network connection** and the **terminal process** have separate lives:

```
session.create ──▶ running ──(process exits)──▶ exited ──(retention)──▶ closed
                      └──── close / terminate ────┴────────────────────▶ closed
```

- Detaching never touches the shell. Re-attaching replays the missed output
  from the agent's per-session ring buffer using sequence numbers (`seq`), so
  nothing is shown twice and a gap is detected rather than silently swallowed.
- A **detached** terminal with **no output** for `SESSION_IDLE_TIMEOUT`
  (default 6 h) is closed. Long-running jobs keep producing output and are safe.
- An **exited** terminal (its shell ended) keeps its last screen for
  `EXITED_RETENTION_SEC` (default 5 min) so you can read the result.
- Limits: `MAX_SESSIONS_PER_AGENT` (default 16, enforced by both agent and
  relay), `MAX_SESSIONS_PER_ACCOUNT` (64), `SESSION_CREATE_PER_MIN` per phone
  (30), `REPLAY_BYTES_PER_SESSION` (256 KiB of history per terminal).
- Restarting the agent process ends its terminals — they are its child
  processes. The app then shows the terminal as gone rather than attaching to
  something else.

---

## How it works

1. **Enrolment.** An agent POSTs the enrolment token once to `/v3/enroll` and
   receives an `agentId` and a random 256-bit **agent token**, which it stores
   with mode 0600. The relay keeps only a SHA-256 hash.
2. **Pairing.** An agent (or a paired phone) asks the relay for a 6-digit code
   via `/v3/pair/code`. A phone redeems it at `/v3/pair/redeem` and receives a
   `deviceId` and its own **device token**. Codes are single-use, expire in five
   minutes, and are rate-limited per IP and relay-wide.
3. **Connection.** Both sides open one WebSocket to the relay with their token
   in an `Authorization: Bearer` header — never in a URL — and declare `v: 3`.
   The relay tracks presence and broadcasts the machine list to the account.
4. **Sessions.** A phone asks a specific agent to create a session (shell, size,
   title). The agent spawns a PTY, streams output back in coalesced chunks with
   monotonically increasing `seq` numbers, and keeps the last
   `REPLAY_BYTES_PER_SESSION` bytes in a ring buffer.
5. **Attach and replay.** A phone attaches with `since: <lastSeq>`; the agent
   replays from there and then goes live. The phone drops anything at or before
   `lastSeq` as a duplicate, and re-attaches if a chunk arrives non-contiguously.
6. **Backpressure.** If a phone falls behind (`BACKPRESSURE_HIGH_BYTES`), the
   relay drops output for that phone rather than buffering without bound; the
   phone recovers it on the next attach.

Every routed message is authorized: the target agent must belong to the
caller's account, input and resize require an attached session, and an agent can
only speak for its own sessions. Accounts are fully isolated from each other.

`PROTOCOL.md` documents all of this message by message.

---

## Configuration

### Relay (`server/`)

Environment variables win over `server/config.json` (copy
`config.example.json`), which wins over the defaults.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | 8080 / 0.0.0.0 | Listen address |
| `ENROLL_TOKEN` (alias `AUTH_TOKEN`) | — | Secret agents present once to enrol. **Set it.** |
| `PUBLIC_URL` | — | The `wss://…` URL printed alongside pairing codes |
| `STATE_FILE` | `server/data/state.json` | Persisted accounts / agents / devices (mode 0600, token hashes only) |
| `TRUST_PROXY` | 0 | Honour `X-Forwarded-For` (last hop) for per-IP limits — only behind your own proxy |
| `TLS_CERT` / `TLS_KEY` | — | Terminate TLS in the relay (`wss://`) |
| `LEGACY_V2` | 0 | Also serve protocol-v2 room clients (isolated, deprecated) |
| `MAX_FRAME_BYTES` | 1 MiB | Largest WebSocket message |
| `MAX_CONNS` / `MAX_CONNS_PER_IP` | 1000 / 20 | Connection caps |
| `MSG_PER_SEC` / `AGENT_MSG_PER_SEC` | 200 / 2000 | Per-connection message budgets |
| `HEARTBEAT_MS` | 30000 | WebSocket ping interval |
| `BACKPRESSURE_HIGH_BYTES` / `_LOW_BYTES` | 4 MiB / 512 KiB | Slow-phone handling (output is dropped, then replayed on re-attach) |
| `MAX_SESSIONS_PER_AGENT` / `MAX_SESSIONS_PER_ACCOUNT` | 16 / 64 | Terminal caps |
| `MAX_AGENTS_PER_ACCOUNT` / `MAX_DEVICES_PER_ACCOUNT` | 50 / 20 | Identity caps |
| `SESSION_CREATE_PER_MIN` | 30 | Per phone |
| `MAX_INPUT_BYTES` | 1 MiB | Largest single input message |
| `PAIRING_TTL_SEC` | 300 | Pairing-code lifetime |
| `PAIRING_DIGITS` | 6 | Pairing-code length |
| `PAIR_PER_IP_PER_MIN` / `PAIR_LOCKOUT_SEC` | 5 / 900 | Redeem attempts per IP, and the lockout after exceeding them |
| `PAIR_GLOBAL_PER_MIN` / `PAIR_GLOBAL_LOCKOUT_SEC` | 100 / 60 | Relay-wide failed-redeem budget |
| `PAIRING_MAX_WRONG_GUESSES` | 25 | Wrong guesses before a code is burned |
| `ENROLL_PER_IP_PER_MIN` | 10 | Enrolment attempts per IP |
| `LOG_LEVEL` | info | `error` \| `warn` \| `info` \| `debug` (JSON lines) |

**Multiple accounts.** Add `"accounts": [{"id": "team-b", "enrollToken": "…"}]`
to `config.json`; each enrolment token maps to its own isolated account, and
machines and phones never cross between them.

### Agent (`agent/`)

Environment variables win over `config.json` (`CONFIG=/path/to/config.json`,
default next to `index.js`; the installers use
`/etc/remote-terminal-agent/config.json`).

| Variable | Default | Meaning |
|---|---|---|
| `SERVER` | `ws://127.0.0.1:8080` | Relay URL |
| `ENROLL_TOKEN` (alias `TOKEN`) | — | The relay's enrolment secret (needed once) |
| `AGENT_NAME` | hostname | Display name (rename later from the app or `--name`) |
| `AGENT_STATE` | `agent/state.json` | Identity file: `agentId` + token, mode 0600 |
| `DATA_DIR` | agent directory | Where the identity file lives by default |
| `DEFAULT_SHELL` | pwsh / bash | Shell id offered first |
| `shells` (config file only) | discovered | Allowlist `[{"id","label","cmd","args"}]` that replaces discovery |
| `SHELL_CWD` | home directory | Working directory for new terminals |
| `MAX_SESSIONS_PER_AGENT` | 16 | Terminal cap |
| `SESSION_IDLE_TIMEOUT` | 21600 s | Close detached terminals silent this long |
| `EXITED_RETENTION_SEC` | 300 | Keep exited terminals this long |
| `REPLAY_BYTES_PER_SESSION` | 262144 | History kept per terminal |
| `MAX_INPUT_BYTES` | 1 MiB | Largest accepted input message |
| `INHERIT_ENV` | 0 | Pass the agent's **entire** environment to shells (not recommended) |
| `UPLOADS_DIR` | `<home>/RemoteTerminal` | Where files sent from a phone are written (dir 0700, files 0600) |
| `MAX_UPLOAD_BYTES` / `MAX_UPLOADS` | 16 MiB / 3 | Largest file, and transfers in flight per phone |
| `UPLOAD_TIMEOUT_SEC` | 120 | A stalled transfer is discarded after this |
| `METRICS_INTERVAL_MS` | 20000 | How often CPU / memory / disk / uptime are published (0 turns reporting off; anything below 2000 is clamped up) |
| `ALLOW_ROOT` | 0 | Permit running as root on Linux |
| `COALESCE_MS` / `MAX_CHUNK` | 16 / 32 KiB | Output coalescing window and chunk size |
| `BASE_BACKOFF_MS` / `MAX_BACKOFF_MS` | 1000 / 30000 | Reconnect backoff |
| `LOG_LEVEL` | info | As above |

**Shell discovery is deliberate, not arbitrary.** Windows offers PowerShell 7
(`pwsh`), Windows PowerShell, Command Prompt and each installed WSL
distribution; Linux offers the shells listed in `/etc/shells` that actually
exist, plus `$SHELL`. The phone only ever sends a shell **id** — command lines
come from the agent's own config or discovery, never from the network.

**Shells get a minimal environment** by default: an allowlist (`PATH`, `HOME`,
`USER`, locale, `TERM=xterm-256color`, … on Linux; `SystemRoot`, `USERPROFILE`,
`PSModulePath`, … on Windows). The agent's tokens and other secrets are never
passed through.

---

## TLS and reverse proxies

Terminate TLS in the relay:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=relay.example.com"
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=8443 ENROLL_TOKEN=… npm start
# → wss://relay.example.com:8443
```

Or run plain `ws://` on localhost behind nginx or Caddy. The proxy must forward
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
address. The relay uses the **last** `X-Forwarded-For` hop — the one your proxy
appended — so a client cannot spoof it.

---

## Security

Remote shell access deserves a careful setup.

- **Transport.** Use `wss://` everywhere in production. The app warns before
  pairing over `ws://` to a non-private address. Tokens travel in a bearer
  header, never in a URL. The app's WebSocket client performs TLS hostname
  verification itself and checks the handshake accept key.
- **Identity.** Nothing is authenticated by names, ids, rooms or codes. Agents
  and phones hold random 256-bit tokens; the relay stores only SHA-256 hashes
  and compares them in constant time. Pairing codes are 6 digits, single-use,
  valid five minutes, one per issuer, rate-limited per IP and relay-wide, and
  burned after repeated wrong guesses.
- **Authorization.** Every routed message is checked: the target agent must be
  in the caller's account, input and resize require an attached session, and an
  agent can only speak for its own sessions. Accounts are fully isolated.
- **Revocation is immediate.** Removing a machine or a phone closes its live
  socket with `4401`; the agent stops, marks its identity invalid and refuses to
  re-enrol automatically (`--enroll` is explicit). Unpairing a phone wipes the
  Keystore-wrapped token.
- **Blast radius.** By default the agent runs as an unprivileged user — the
  installer creates one and refuses root unless `--allow-root` / `ALLOW_ROOT=1`,
  which makes every terminal a root shell. Shells get a minimal environment.
  `install-linux.sh` puts the program under root-owned `/opt` and the identity
  under the service user alone. Optional systemd hardening lines
  (`NoNewPrivileges`, `ProtectSystem`) are in the unit file — they also forbid
  `sudo` inside terminals, so enable them consciously.
- **Abuse controls.** Connection caps, per-connection message budgets, frame
  size limits, session and identity caps, pairing and enrolment limiters, and
  backpressure for slow phones.
- **Logs.** JSON lines with `connId` / `agentId` / `sessionId` / `role` / `v`.
  Tokens, pairing codes and authorization headers are redacted; terminal input
  and output are never logged, only their lengths.
- **On the phone.** The device token is AES-256-GCM encrypted with a
  non-exportable Android Keystore key, so the preferences file holds only
  ciphertext; backups are disabled (`allowBackup=false`); an optional app lock
  covers the content until the device credential prompt succeeds. QR frames are
  decoded on-device and never stored or sent anywhere.
- **Never commit** (all gitignored): `server/config.json`, `agent/config.json`,
  `server/data/`, `agent/state.json`, `android/keystore.properties`,
  `android/keystore/`.

---

## Operating the relay

- **Health and counters.** `GET /health` → `ok`; `GET /stats` → uptime, agents
  online, phones online, live sessions, protocol version. Both are
  unauthenticated and safe to point monitoring at; neither reveals identities.
- **State.** `server/data/state.json` (mode 0600) holds accounts, enrolled
  agents and paired devices — token **hashes** only. Back it up: losing it means
  every machine must enrol again and every phone must pair again.
- **Restarts.** Restarting the relay does not kill terminals. Agents and phones
  reconnect with backoff, and the phones re-attach at their last stream
  position. Restarting an *agent*, on the other hand, ends that machine's
  terminals.
- **Logs.** `LOG_LEVEL=info` by default, JSON lines to stdout; run it under
  systemd (or your process manager of choice) and let the journal collect them.
- **Capacity.** The defaults are sized for a personal or small-team relay: 1000
  connections, 20 per IP, 50 machines and 20 phones per account, 64 live
  terminals per account. Raise them deliberately — every live terminal is a real
  process on a real machine.

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Agent will not enrol | `node index.js --status`. Wrong or missing `ENROLL_TOKEN`, or the relay is unreachable. Enrolment is per-IP rate-limited (10/min). |
| Agent connects, then stops with "unauthorized" | Its token was revoked (the machine was removed in the app). Re-enrol explicitly: `node index.js --enroll`. |
| Agent keeps getting closed with `4409` | Another instance of the same agent is running — the newest connection wins. Stop the duplicate. |
| No shells offered, or terminals fail to start | `node index.js --doctor`: it checks the PTY backend, lists discovered shells and reports configuration problems. |
| Pairing code rejected | Codes last five minutes and are single-use. Too many wrong attempts from one IP triggers a 15-minute lockout. |
| Phone connects but sees no machines | The phone and the agents must share an account, i.e. the same enrolment token. Check `/stats` for `agentsOnline`. |
| Terminal shows "gone" after a while | The agent process restarted (its children died), or a detached terminal was idle past `SESSION_IDLE_TIMEOUT`. |
| Machine details say *not reported* | The platform could not answer that metric, or `METRICS_INTERVAL_MS=0`. Nothing is invented to fill the gap. |
| Reverse proxy: pairing works, terminals do not | The proxy forwards `/v3/*` but not the WebSocket upgrade. Check the `Upgrade`/`Connection` headers and `proxy_read_timeout`. |
| Output garbled in one program | The emulator covers what real programs use; a sequence it mishandles is a bug worth a test in `TerminalEmulator`. |

---

## Building the Android app

```bash
cd android
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # JVM unit tests
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Release builds are minified and shrunk with R8, which is exactly why they are
the build that matters — they catch reflection and ProGuard breakage a debug
build hides:

```bash
./gradlew assembleRelease        # → app/build/outputs/apk/release/app-release.apk
```

They are signed automatically when `android/keystore.properties` exists;
without it the build still succeeds and produces an unsigned APK. First-time
key setup:

```bash
keytool -genkeypair -v -keystore keystore/release.jks -alias remoteterminal \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Remote Terminal, O=Cactus Software Group, C=US"
# keystore.properties: storeFile=keystore/release.jks, storePassword=…,
#                      keyAlias=remoteterminal, keyPassword=…
```

APKs and AABs are gitignored — never commit build output. Confirm a build with
`app/build/outputs/apk/release/output-metadata.json`, which should show the
expected `versionCode` and `versionName`.

### Dependencies

Deliberately few, and all small and mature: AndroidX
core / appcompat / activity / fragment / lifecycle / recyclerview /
constraintlayout / preference, Material Components, Kotlin coroutines, CameraX
with ZXing core (QR pairing only — a pure-Java decoder, no UI and no services),
and JUnit 4 with `org.json` for JVM tests.

Networking (an RFC 6455 WebSocket client with TLS hostname verification, and the
HTTP pairing calls) and the terminal emulator stay hand-written,
dependency-free and unit tested. Do not add a library to solve something they
already cover. The server and agent depend on `ws` — plus the agent's prebuilt
PTY binding — and nothing else. Keep it that way.

---

## Tests

```bash
cd server && npm test              # relay: identity, pairing, auth, routing, isolation, revocation, limits, legacy mode
cd agent  && npm test              # agent: ring buffer, env, shells (Windows + Linux), sessions, metrics, uploads, relay client, a real bash PTY
node tools/e2e-linux.js            # real relay + real Linux agent + scripted phone
cd android && ./gradlew testDebugUnitTest   # emulator, key encoder, framing, protocol, presets
```

`tools/e2e-linux.js` is the honest one: it enrols an agent, pairs a phone,
opens two bash terminals, and checks routing, ANSI colours, Ctrl+C, resize,
phone reconnect with `since` (same shell process, no duplicates), full replay,
closing one terminal, exit codes, agent restart (new instance id) and
revocation.

---

## Versioning and releases

The project has **one version number**, shared by the server, the agent and the
Android app — currently **0.7.1** — bumped by semver according to what the work
did. The Android `versionCode` is a plain integer that must strictly increase on
every release. The wire protocol version (`v3`) is independent and changes only
for an actual breaking wire change.

`CLAUDE.md` lists every file a bump must touch, and how to verify one.

---

## Upgrading from 0.2 (protocol v2)

0.3 was a new architecture: accounts, enrolled agents with tokens, paired
devices, many sessions per agent. Rooms and the shared `AUTH_TOKEN` gate are
gone.

1. Deploy the new relay and set `ENROLL_TOKEN` (your old `AUTH_TOKEN` value is a
   reasonable choice). Reverse proxies must also forward `/v3/*`.
2. Reinstall each agent with the current installer — it enrols itself. Old
   `ROOM` settings are ignored; `TOKEN` is still accepted as the enrolment token.
3. Install the current app and pair it with a code from any agent. Old
   connection profiles are not migrated; they carried no reusable identity.
4. For a staged rollout, start the relay with `LEGACY_V2=1` to keep serving 0.2
   clients in an isolated room table while you upgrade machines. Legacy clients
   never see v3 machines and vice versa. Turn it off when you are done.

A 0.2 client against a v3-only relay is refused with close code `4426`.

---

## Limitations and roadmap

- Restarting the agent process ends its terminals — there is no tmux-style
  survival across an agent restart yet.
- Two phones attached to one terminal share its size; the last resize wins.
- Rotating the phone recreates the screen: tabs and shells persist, the scroll
  position does not.
- Roadmap: optional binary framing, a per-user audit log, mutual TLS or device
  attestation, and session survival across agent restarts via `tmux`/`screen`.

---

© Cactus Software Group. *Secure. Fast. Everywhere.*
