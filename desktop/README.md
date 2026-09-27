# Remote Terminal — desktop

**Real terminals on your Windows and Linux machines, from a desktop window**,
through the same relay and the same protocol as the phone app.

Every feature the Android app has is here: Home, Machines, Terminals and
Settings; the machine details with live CPU / memory / disk / uptime; tabs with
unread counts; the VT/xterm emulator with search, selection, themes and
scrollback; presets; command history; the extra-keys bar; file and image
upload into a session; a file browser and a process manager for every machine;
clickable links, transcripts, broadcast input and output watches in the
terminal; pairing; paired devices; notifications; the app lock.

Version **0.12.0**, wire protocol **v3** — the same numbers the rest of the
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
    src/transfer.rs  local files for the file browser's transfers, opening links
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
presets, terminal naming, pairing payloads and OSC 7 working directories —
plus the 0.12 features: agent requests, the link finder, transcripts, the file
browser's ordering and transfer loops, the process manager's rules and output
watches. When
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

Three things the desktop does that the phone does not, because a desktop can:

- **The close button hides the window.** Terminals are things you leave
  running, and a window closed out of habit should not drop them, so the app
  goes to the notification area instead. Its icon opens the window again and
  its menu is the only way to actually quit. *Close to the notification area*
  in Settings turns that off.


- **Terminal query replies are answered.** DSR and DA requests from programs
  are sent back to the shell (muted while replayed output is being applied, as
  §6 of `PROTOCOL.md` requires). The phone's emulator parses them but never
  wires the reply.
- **Scrollback keys.** `Shift+PageUp` / `Shift+PageDown` / `Shift+Home` /
  `Shift+End` move through the scrollback, as on a real console.

A tab whose shell finishes cleanly closes itself, the way a terminal emulator's
does; one whose shell failed stays, because the message that explains the code
is on the screen behind it. *Close the tab when the shell exits* in Settings
turns that off.

A working directory is typed into the new shell as a `cd`, which on Windows is
not enough on its own: `cd E:\work` from the C: drive sets E:'s directory and
leaves the shell where it was. The drive letter goes first, so a directory on
another drive is reached rather than merely remembered, and a UNC path gets
`pushd`, which is the only thing that reaches one from Command Prompt.

Everything else — the wording, the confirmations, the defaults, the settings
keys, the colour schemes, the key rows — is the same, on purpose.

---

## Files, processes and the terminal extras

**Files.** The machine screen has a *Files* segment: the machine's files under
the folder its agent allows (the home folder of whoever the terminals belong
to), with breadcrumbs, *Up*, a filter, sorting by name, size or date, and
*Show hidden files*. Double-click or `Enter` opens a folder or views a file
(text up to 1 MiB, and images); `Backspace` or `Alt+↑` goes up, `Delete` and
`F2` delete and rename. *Download* asks where to save and writes the file slice
by slice; *Upload files* takes a file dialog or files dropped on the list, and
asks before replacing one. *Open terminal here* starts a terminal in that
folder. *Browse files here* in the terminal menu opens the browser where the
shell is, and adds *Insert path*, which types the quoted path at the cursor and
runs nothing.

**Processes.** The *Processes* segment lists what is running, busiest first,
refreshing every three seconds while it is on screen; click *CPU*, *Memory* or
*Name* to sort, filter by name, PID, user or command. Selecting one shows its
details and *End process* / *Force end*, each confirmed. Under the Windows
service only the signed-in user's processes can be ended, and the screen says
so rather than offering a button that will fail.

Both need a 0.12 relay and agent; with an older one the segment says to update
the agent.

**In the terminal:**

- **Links** — hold `Ctrl` to underline a link under the pointer, `Ctrl`+click
  to open it in the browser (web links only; a `file:` link is copied), or
  right-click it for *Open link* / *Copy link*. *Clickable links* in Settings
  turns it off.
- **Transcripts** — *Save transcript* (`Ctrl+Shift+S`) writes the scrollback
  and screen as plain text; *Copy transcript* puts it on the clipboard.
- **Broadcast input** — choose other open terminals, on any machine, and what
  you type in this one goes to them too, until you press *Stop* on the banner
  or they close.
- **Watches** — *Watch for text…* notifies when that text appears in live
  output (any case; once, unless you ask to keep watching); *Notify when
  output stops* notifies once the terminal has been silent for ten seconds.

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
| `Ctrl+Shift+S` | Save the terminal's transcript |
| `Ctrl`+click | Open the link under the pointer |
| `Ctrl+Shift+C`, `Ctrl+Shift+V` | Copy the selection, paste |
| `Ctrl+V` (Windows only) | Paste — what the keyboard says and what Windows Terminal does. Elsewhere `Ctrl+V` belongs to the shell, where readline reads it as "take the next key literally" |
| `Ctrl+C` with a selection | Copy (with no selection it goes to the shell, as it should) |
| `Ctrl` + wheel | Font size |
| `Shift` + wheel | Previous / next tab (when the setting is on) |

Everything else goes to the shell.
