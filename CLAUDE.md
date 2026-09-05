# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Remote Terminal: real PTY sessions on Windows/Linux machines, driven from an
Android phone, relayed through a self-hosted Node server.

| Path | What it is |
|---|---|
| `server/` | The relay (Node, `ws` only): enrolment, pairing, device tokens, session routing, presence, limits. |
| `agent/` | Cross-platform agent (Node): hosts PTY sessions, shell discovery, replay buffers. |
| `android/` | The phone app (Kotlin, Material 3): machines list, terminal tabs, VT/xterm emulator. |
| `desktop/` | The desktop app (Tauri: Rust shell + a dependency-free web frontend). The same screens and the same emulator, ported. |
| `tools/e2e-linux.js` | Real relay + real Linux agent + scripted phone, end to end. |

See `README.md` for the full tour and `PROTOCOL.md` for the wire protocol.

## Versioning

The project has **one version number**, shared by the server, the agent, the
Android app and the desktop app. It is currently **0.8.1**.

**Bump it automatically — do not wait to be asked.** Any piece of work that
changes shipped behaviour ends with a version bump, in the same commit as the
change and before the release APK is built, so the APK carries the new version.
Decide the size from what the work did, using semver:

- **patch** (0.7.0 → 0.7.1) — bug fixes, wording, docs, refactors, test-only work.
- **minor** (0.7.0 → 0.8.0) — anything a user would notice as new: a feature, a
  new screen or field, a new protocol message, a new agent capability.
- **major** — a breaking change to the wire protocol or to stored state.

Bump once per piece of work, not once per file touched: several changes
delivered together share one bump, and the largest of them decides its size. A
question, an investigation or an abandoned experiment is not a bump. An explicit
version from the user wins over this rule.

The Android `versionCode` is a plain integer that must strictly increase on
every release. It has so far tracked the minor version (0.3.0 → 3, 0.7.0 → 7);
keep that going, and if two builds ever share a `versionName`, increment
`versionCode` anyway — including for a patch bump.

A bump means editing **all** of these, in one commit:

| File | What to change |
|---|---|
| `server/package.json` | `"version"` |
| `server/package-lock.json` | `"version"` — both occurrences at the top (root and `packages.""`) |
| `agent/package.json` | `"version"` |
| `agent/package-lock.json` | `"version"` — both occurrences at the top |
| `android/app/build.gradle` | `versionCode` **and** `versionName` |
| `desktop/package.json` | `"version"` |
| `desktop/src-tauri/Cargo.toml` | `version` (the `[package]` one) |
| `desktop/src-tauri/tauri.conf.json` | `"version"` |
| `desktop/ui/js/version.js` | `APP_VERSION` |
| `README.md` | the `Version **x.y.z**, wire protocol **vN**` line |
| `PROTOCOL.md` | the `"agentVersion": "x.y.z"` values in the example payloads |

Do **not** touch: `server/data/state.json`, `agent/state.json` (runtime state,
gitignored), or the `agentVersion` fixture strings in tests — those are just
fixtures and changing them adds churn without meaning.

The wire protocol version (`PROTOCOL_VERSION` in `android/.../protocol/Messages.kt`
and `desktop/ui/js/protocol/messages.js`, `buildConfigField "int",
"PROTOCOL_VERSION"` in `build.gradle`, `protocol: 3` in `agent/lib/config.js`, and
the `/v3/...` server routes) is **independent** of the product version — bump it only for an actual breaking wire change, and then
everywhere at once.

Verify a bump with:

```bash
grep -rn "0\.8\.0" --include="*.json" --include="*.gradle" --include="*.md" . \
  | grep -v node_modules | grep -v /build/
```

Two hits in `agent/package-lock.json` are dependency versions that happen to
read `0.6.0` (`deep-extend`, `tunnel-agent`) — leave those alone.

## Release APK

**Whenever Android app code changes (anything under `android/app/src/`, its
resources, `build.gradle`, or the ProGuard rules), build a release APK before
reporting the work done.**

```bash
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

Notes:

- The release build is minified and shrunk with R8, so it catches ProGuard/
  reflection breakage that a debug build hides. That is a large part of why it
  is the required check.
- It is signed automatically when `android/keystore.properties` exists (it does
  locally; both it and `android/keystore/` are gitignored). Without it the build
  still succeeds and produces an unsigned APK.
- APKs and AABs are gitignored — never commit the build output.
- Confirm the result: `android/app/build/outputs/apk/release/output-metadata.json`
  should show the expected `versionCode` / `versionName`.
- Run `./gradlew testDebugUnitTest` alongside it when the change touches the
  emulator, key encoder, framing or protocol code.

## Desktop app

**Whenever the desktop app changes (anything under `desktop/`), run its tests and
build it before reporting the work done.**

```bash
cd desktop && npm test                              # emulator, protocol, key encoder, presets…
cd desktop/src-tauri && cargo build --release       # -> target/release/remote-terminal-desktop.exe
```

Notes:

- The frontend (`desktop/ui/`) is plain ES modules with **no build step and no
  runtime dependencies** — `cargo build` copies it in as-is. Do not add a
  bundler or a framework.
- `desktop/package.json` has no dependencies either; it exists for `npm test`
  and the version number. `npm install` is never needed.
- The Rust side owns only what a web view cannot do: the relay socket (the
  protocol needs an `Authorization` header), the HTTPS pairing calls, the
  DPAPI-sealed credential store, the clipboard and the app lock.
- The terminal emulator, the protocol and the key encoder are **ports of the
  Kotlin ones**, and `desktop/test/` is a port of the Kotlin test suite. When
  you change one side's emulator, change the other and keep both suites green.
- Installers (`.msi` / `.nsis`) need `cargo install tauri-cli --version "^2"`
  and then `cargo tauri build`; a plain `cargo build --release` is enough for
  the executable. Build output is gitignored — never commit it.

## Tests

```bash
cd server  && npm test             # relay: identity, pairing, auth, routing, limits
cd agent   && npm test             # agent: ring buffer, env, shells, sessions, real bash PTY
cd desktop && npm test             # desktop: emulator, protocol, keys, presets, pairing
node tools/e2e-linux.js            # full end-to-end scenario
cd android && ./gradlew testDebugUnitTest
```

## Conventions

- The Android app avoids third-party networking and terminal libraries — the
  WebSocket client and the VT emulator are hand-written and unit tested. Do not
  add a dependency to solve something those already cover.
- The desktop frontend has no dependencies at all: no framework, no bundler, no
  terminal library. Its emulator and protocol are ports of the Kotlin ones.
- The server and agent depend on `ws` and nothing else. Keep it that way.
- Android builds resolve dependencies through Aliyun mirrors (`dl.google.com`
  is unreachable here); leave the repository configuration alone.
