# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Remote Terminal: real PTY sessions on Windows/Linux machines, driven from an
Android phone, relayed through a self-hosted Node server.

| Path | What it is |
|---|---|
| `server/` | The relay (Node, `ws` only): enrolment, pairing, device tokens, session routing, presence, limits. |
| `agent/` | Cross-platform agent (Node): hosts PTY sessions, shell discovery, replay buffers. |
| `android/` | The app (Kotlin, Material 3): machines list, terminal tabs, VT/xterm emulator. |
| `tools/e2e-linux.js` | Real relay + real Linux agent + scripted phone, end to end. |

See `README.md` for the full tour and `PROTOCOL.md` for the wire protocol.

## Versioning

The project has **one version number**, shared by the server, the agent and the
Android app. It is currently **0.7.1**.

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
| `README.md` | the `Version **x.y.z**, wire protocol **vN**` line |
| `PROTOCOL.md` | the `"agentVersion": "x.y.z"` values in the example payloads |

Do **not** touch: `server/data/state.json`, `agent/state.json` (runtime state,
gitignored), or the `agentVersion` fixture strings in tests — those are just
fixtures and changing them adds churn without meaning.

The wire protocol version (`PROTOCOL_VERSION` in `android/.../protocol/Messages.kt`,
`buildConfigField "int", "PROTOCOL_VERSION"` in `build.gradle`, `protocol: 3` in
`agent/lib/config.js`, and the `/v3/...` server routes) is **independent** of the
product version — bump it only for an actual breaking wire change, and then
everywhere at once.

Verify a bump with:

```bash
grep -rn "0\.7\.0" --include="*.json" --include="*.gradle" --include="*.md" . \
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

## Tests

```bash
cd server && npm test              # relay: identity, pairing, auth, routing, limits
cd agent  && npm test              # agent: ring buffer, env, shells, sessions, real bash PTY
node tools/e2e-linux.js            # full end-to-end scenario
cd android && ./gradlew testDebugUnitTest
```

## Conventions

- The Android app avoids third-party networking and terminal libraries — the
  WebSocket client and the VT emulator are hand-written and unit tested. Do not
  add a dependency to solve something those already cover.
- The server and agent depend on `ws` and nothing else. Keep it that way.
- Android builds resolve dependencies through Aliyun mirrors (`dl.google.com`
  is unreachable here); leave the repository configuration alone.
