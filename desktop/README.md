# Remote Terminal — desktop

**Real terminals on your Windows and Linux machines, from a desktop window**,
through the same relay and the same protocol as the phone app.

Every feature the Android app has is here: Home, Machines, Terminals and
Settings; the machine details with live CPU / memory / disk / uptime; tabs with
unread counts; the VT/xterm emulator with search, selection, themes and
scrollback; presets; command history; the extra-keys bar; file and image
upload into a session; pairing; paired devices; notifications; the app lock.

Version **0.8.1**, wire protocol **v3** — the same numbers the rest of the
project carries.

---

## What it is made of

```
desktop/
  ui/                the whole frontend: plain ES modules, no build step,
                     no framework, no dependencies
    index.html       the shell
    app.css          the design system (tokens ported from the Android resources)
    assets/          the bundled mono font
    js/
      terminal/      the VT emulator, the canvas renderer, keys, themes
      protocol/      v3 messages, the incoming parser, the attach/replay stream
      core/          settings, credentials, the relay client, repositories
      ui/            the design components and every screen
  src-tauri/         the Rust shell
    src/ws.rs        the relay socket
    src/http.rs      the HTTPS pairing endpoints
    src/store.rs     settings, the machine cache, the DPAPI-sealed token
    src/sys.rs       clipboard, file loading, keep-awake, the app lock
  test/              a port of the Android unit tests
```

The Rust side owns exactly what a web view cannot do for itself, and nothing
else. Everything above the socket — the protocol state machine, the emulator,
the screens — is a port of the Android app, so the two clients stay in step and
the same test suite proves it.

---

## Build and run

**Prerequisites** — Rust (MSVC toolchain), the Visual Studio Build Tools with
the Windows SDK, and the Microsoft Edge WebView2 runtime (present on Windows 11;
Windows 10 may need the evergreen installer). Node is used only to run the
tests.

```bash
cd desktop/src-tauri
cargo build --release      # -> target/release/remote-terminal-desktop.exe
cargo run                  # a debug run, with the web inspector available
```

Installers (`.msi`, `.exe`) need the Tauri CLI:

```bash
cargo install tauri-cli --version "^2"
cd desktop && cargo tauri build
```

Because the frontend is plain files with no build step, `cargo build` picks up
whatever is in `ui/` — editing a screen and re-running is the whole loop.

## Tests

```bash
cd desktop && npm test
```

No `npm install`: `package.json` has no dependencies. The suite is the Android
one carried over — the emulator (including its fuzz and throughput cases), the
key encoder, the attach/replay stream, the protocol parsers and builders,
presets, terminal naming, pairing payloads and OSC 7 working directories. When
the emulator changes on either side, both suites have to stay green.

---

## Pairing

The same three steps as the phone: relay URL, six-digit pairing code, done.

```
node index.js --pair        # on the machine, prints a code
```

A desktop has no camera, so where the phone scans a QR code this app reads the
clipboard: **Paste link** accepts either a bare six-digit code or a
`remoteterminal://pair?relay=…&code=…` link, parsed by exactly the same rules
the phone's scanner uses. *Settings → Paired devices → Add device* mints a code
and offers that link, so pairing a second machine is a copy and a paste.

The device token is sealed with **DPAPI** under your Windows account and written
to `%APPDATA%\com.cactus.remoteterminal.desktop\credentials.json`; the file
holds only ciphertext, and another account on the same machine cannot read it.
That directory also holds `settings.json` and the machine-list cache — *Settings
→ Settings folder* copies its path.

---

## How the desktop differs from the phone

The feature set is the same; the input devices are not. Where the phone uses a
finger, this app uses a keyboard and a mouse:

| Phone | Desktop |
|---|---|
| Floating bottom navigation | A navigation rail down the left edge (same four destinations, same icons) |
| Scan a pairing QR code | **Paste link** — the same payloads, read from the clipboard |
| Swipe sideways to change tab | `Ctrl+Tab` / `Ctrl+PageUp` / `Ctrl+PageDown`, or Shift + wheel over the grid |
| Pinch to zoom | `Ctrl` + wheel |
| Long-press to select, handles to adjust | Drag to select, double-click a word, triple-click a logical line |
| Action bar: Copy / Select all / Paste | Right-click the grid, or `Ctrl+Shift+C` / `Ctrl+Shift+V` / `Ctrl+Shift+A` |
| Bell: vibrate | Bell: a short tone (or silent) |
| Keep screen on | Keep the display awake (`SetThreadExecutionState`) |
| App lock: the device credential prompt | App lock: Windows Hello, and the setting disables itself where Hello is not set up |
| Foreground / background | Window focus, with the same 90-second grace period before the socket is dropped |

Two things the desktop does that the phone does not, because a desktop can:

- **Terminal query replies are answered.** DSR and DA requests from programs
  are sent back to the shell (muted while replayed output is being applied, as
  §6 of `PROTOCOL.md` requires). The phone's emulator parses them but never
  wires the reply.
- **Scrollback keys.** `Shift+PageUp` / `Shift+PageDown` / `Shift+Home` /
  `Shift+End` move through the scrollback, as on a real console.

Everything else — the wording, the confirmations, the defaults, the settings
keys, the colour schemes, the key rows — is the same, on purpose.

---

## Keyboard shortcuts

These are taken by the window before a focused terminal sees them, so they work
inside a session too — which is why they are chords a shell has no use for. The
unshifted `Ctrl+1` … `Ctrl+4` still go to the shell while the grid has focus,
because `Ctrl+4` is a real control code.

| Keys | What it does |
|---|---|
| `Ctrl+Shift+1` … `Ctrl+Shift+4` | Home / Machines / Terminals / Settings |
| `Ctrl+1` … `Ctrl+4` | The same, when a terminal does not have focus |
| `Alt+←` | Back |
| `Esc` | Back (outside a terminal); closes find, then clears the selection, inside one |
| `Ctrl+Tab`, `Ctrl+Shift+Tab` | Next / previous terminal tab |
| `Ctrl+Shift+F` | Find in the scrollback |
| `Ctrl+Shift+C`, `Ctrl+Shift+V` | Copy the selection, paste |
| `Ctrl+C` with a selection | Copy (with no selection it goes to the shell, as it should) |
| `Ctrl` + wheel | Font size |
| `Shift` + wheel | Previous / next tab (when the setting is on) |

Everything else goes to the shell.
