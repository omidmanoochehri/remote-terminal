# Remote Terminal — Wire Protocol

All three components speak this protocol. Transport is a single **WebSocket**
connection per client. Every application message is a **UTF-8 JSON object** with
a `type` field. Terminal payloads are carried as UTF-8 strings inside JSON
(base64 is *not* used, to keep the wire debuggable).

**Protocol version: `2`.** Version 2 is a backward-compatible superset of the
original slice (v1): every message below is either unchanged or *additive*, and
any component ignores message types and fields it does not understand. A v1 peer
and a v2 peer still interoperate for the core input/output path.

## Roles & rooms

A client declares its role and room via the WebSocket URL query string:

```
wss://<host>:<port>/?role=agent&room=<ROOM>&token=<TOKEN>
wss://<host>:<port>/?role=phone&room=<ROOM>&token=<TOKEN>&pair=<CODE>
```

- `role` — either `agent` (the Windows machine) or `phone` (the Android app).
- `room` — a session identifier that pairs one agent with one phone. In v2 the
  room is **not** the secret (see `token`/`pair`); in v1 it doubled as the only
  auth.
- `token` — *(v2, optional but recommended)* a shared secret / API token the
  server validates before the client may join a room. May also be supplied as an
  `Authorization: Bearer <TOKEN>` header. If the server is configured with no
  token, this is not required (compatible with v1).
- `pair` — *(v2, optional)* a short-lived pairing **code** a phone presents to
  join the room an agent has registered. See [Pairing](#pairing-v2).

The server keeps a table of rooms. Each room holds at most one `agent` and one
`phone`. A second client of the same role replaces the previous one.

Transport should be **`wss://`** (TLS) in production. `ws://` is still accepted
for local/dev use.

## Handshake & capability negotiation (v2)

On connect the server sends `welcome` with its protocol version and the set of
optional features it supports. Clients likewise advertise their capabilities in
the query string (`caps=color,replay`, comma-separated) or simply by using the
optional messages. Each side treats absent capabilities as "peer can't do this"
and degrades gracefully.

Known capability tokens:

| Capability | Meaning                                                        |
|------------|----------------------------------------------------------------|
| `color`    | Phone renders full ANSI/SGR (colors, attributes, cursor moves) |
| `replay`   | Agent can send a scrollback snapshot on (re)connect            |
| `sessions` | Multiple multiplexed shell sessions per room                   |
| `auth`     | Token authentication is enforced                               |
| `ping`     | App-level keepalive (`ping`/`pong`) is supported               |

## Messages

### Server → client (control)

```jsonc
{ "type": "welcome", "role": "agent", "room": "abc", "v": 2,
  "caps": ["replay", "auth", "ping"] }     // server hello + capabilities
{ "type": "status",  "peer": "connected"    }   // the other side joined
{ "type": "status",  "peer": "disconnected" }   // the other side left
{ "type": "error",   "message": "unauthorized" }
{ "type": "pong" }                                // reply to a client ping
{ "type": "paired",  "code": "483920", "expires": 1234567890 }  // agent pairing code
```

### phone → agent (relayed through server)

```jsonc
{ "type": "input",   "data": "ls -la\r" }         // raw keystrokes, incl. \r
{ "type": "resize",  "cols": 120, "rows": 30 }    // terminal geometry
{ "type": "input",   "session": "s1", "data": "…" }  // (v2 sessions) targeted input
```

### agent → phone (relayed through server)

```jsonc
{ "type": "output",  "data": "PS C:\\> ls\r\n..." }   // raw PTY bytes as UTF-8
{ "type": "replay",  "data": "…recent scrollback…" }   // (v2) snapshot on connect
{ "type": "exit",    "code": 0 }                        // shell terminated
{ "type": "output",  "session": "s1", "data": "…" }     // (v2 sessions) tagged output
```

### client ↔ server (keepalive, v2)

```jsonc
{ "type": "ping" }     // either side may send; server answers with pong
{ "type": "pong" }
```

App-level `ping`/`pong` complements WebSocket-level ping frames and keeps idle
NAT paths open. It is a no-op for peers that don't support it.

## Pairing (v2)

1. The **agent** connects and registers its `room` (authenticated by `token`).
   The server mints a short-lived numeric **pairing code** and returns it in a
   `paired` message; the agent displays/logs it.
2. The **phone** connects with `room` + `pair=<CODE>`. The server validates the
   code (unexpired, matches the room) and joins the phone to the room.
3. Codes are single-room, time-limited (default 5 min), and invalidated once the
   phone pairs. The room id itself carries no authority.

If pairing is not configured, the phone joins by `room` (+ `token`) directly, as
in v1.

## Relay behaviour

- The server never inspects `input`/`output`/`resize`/`exit`/`replay` payloads —
  it forwards them to the room peer verbatim.
- `welcome`, `status`, `error`, `pong`, and `paired` are generated by the server.
- Frames larger than the configured **max frame size** (default 1 MiB) are
  dropped and the sender may be closed.
- If a message arrives with no peer present, it is dropped (the sender learns the
  peer state from `status`).

## Notes / non-goals

- v2 remains a text-JSON protocol for debuggability. Binary framing is a possible
  future optimization for high-throughput output.
