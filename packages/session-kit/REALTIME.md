# Shared authenticated realtime — `iva-live@1`

This foundation is owned by `feat/iva-realtime-foundation`, introduced from
`357f60049e83b298bb5bbc2f760654fbd02384e3` for the Test Bench release. Reuse it for
other realtime games. It owns transport and account/room authorization only;
game packages own rules, simulation, payloads, views, clocks and persistence.

## Entry and authority

Connect to `wss://<portal-origin>/api/platform/v1/rooms/<roomId>/live` after the
HTTP room has a `matchId`. No URL query, credentials, tokens, fragments, or
client-supplied seat are accepted. The ordinary HTTP-only session cookie is
required. The origin must exactly match the configured public origin, even if
the separate development HTTP endpoint allows additional origins. Host,
unexpired session, room membership and current match/runtime are checked.

The first server frame is a complete personalized `snapshot`. All server frames
include `protocol`, `wireVersion`, `roomId`, `matchId`, `epoch`, `gameId`,
`rulesVersion` and `contentVersion`. The last three fields describe the pinned
room, not the current catalogue default. Never broadcast one player's view to
another seat. Authorization is rechecked on input and command acceptance,
before snapshot/receipt delivery, and on periodic updates. Revoking a session
closes its existing connection too.

Each new connection takes control of the same match/player with a fresh random
epoch. The previous socket closes with code `4001`. Its eventual disconnect
cannot clear the new epoch. Slow connect/disconnect hooks are serialized by
seat; a response timeout does not pretend an underlying hook was cancelled.

## Optional runtime contract

`RealtimeGameRuntime` extends existing `GameRuntime`. Existing HTTP runtimes are
unchanged and reject an attempted realtime connection with `LIVE_UNAVAILABLE`.

```ts
interface RealtimeSnapshot {
  tick: number;
  serverTime: number;
  lastAcceptedSeq: number;
  view: unknown;
}
interface RealtimeInput { epoch: string; seq: number; payload: unknown }
interface RealtimeGameRuntime extends GameRuntime {
  readonly wireVersion: string;
  liveConnect(matchId: string, playerId: string, epoch: string): Promise<RealtimeSnapshot>;
  liveInput(matchId: string, playerId: string, input: RealtimeInput): void | Promise<void>;
  liveSnapshot(matchId: string, playerId: string, epoch: string): Promise<RealtimeSnapshot>;
  liveDisconnect(matchId: string, playerId: string, epoch: string): void | Promise<void>;
}
```

The game rechecks epoch and resets accepted sequence/control on connection.
The game must neutralize old controls after its own input timeout (Test Bench:
300 ms), independently of TCP disconnect. `lastAcceptedSeq` is the game's
acknowledgement, not the gateway's received counter. A fresh epoch may start at
`-1` until an input is accepted. The gateway does not generate physics ticks.

## Frames

Client frames contain exactly the five shared scope fields below plus their
type-specific fields. Copy the scope from the received full snapshot.

```json
{
  "protocol": "iva-live@1",
  "wireVersion": "<game-wire-version>",
  "roomId": "<room-id>",
  "matchId": "<match-id>",
  "epoch": "<current-epoch>",
  "type": "input",
  "seq": 1,
  "payload": { "<game-owned-input>": 0 }
}
```

| Type | Additional fields and behavior |
| --- | --- |
| Client `input` | `seq`, `payload`. Nonnegative safe integer sequence; stale/duplicate sequences are dropped. Payload ranges/phase IDs are validated by the game. |
| Client `command` | `actionId`, `expectedRevision`, `payload`. Uses the same `runtime.applyAction` as HTTP. The game atomically saves state and action-ID receipt before returning. |
| Server `snapshot` | `tick`, `serverTime`, `lastAcceptedSeq`, `view`. Full personalized view; target 15/s (67 ms timer) while the socket can receive. |
| Server `receipt` | `actionId`, `result`, `tick`. `result` is the runtime's actual return value. `tick` is the latest delivered snapshot tick; game result carries any exact commit tick it requires. |
| Server `error` | `code`, short `message`, optional `actionId`. Clients translate stable codes to their locale. Unexpected internal errors are not exposed. |

Commands are serialized and bounded per connection. They are not silently
retried or assigned new IDs by the gateway. If a receipt is lost, reconnect and
retry the identical action ID/payload. The runtime must return its durable
receipt without repeating the effect. Old phase commands must be rejected or
answered with their existing receipt by the game, not interpreted in a new
phase.

## Bounds and slow clients

- Input: at most 30 accepted frames per seat in a rolling second, including
  across reconnects. Unprocessed inputs
  coalesce to the freshest sequence. Excess inputs are dropped without
  pretending acceptance in `lastAcceptedSeq`.
- All incoming frames: at most 90/s; command admission at most 12/s and eight
  pending commands. Rejected commands receive `RATE_LIMITED`, so the client can
  retry its existing ID later.
- Incoming text frames: 16 KiB; binary frames rejected. Compression disabled.
- Snapshot/receipt size: 512 KiB maximum; send-buffer threshold 128 KiB.
- While congested, snapshots are skipped and regenerated after recovery; no
  unbounded history of obsolete views is queued. Reliable frames are limited
  to 32 entries and 512 KiB total. Exceeding that bound closes `1013`; committed
  actions remain retrievable by their IDs.
- New connections are bounded by source-address and account rate limits, plus
  512 active sockets per process. Ping/pong detects dead sockets. No raw token
  is recorded in a log or frame.

## Shutdown and recovery

`server.shutdown()` closes the HTTP listener, stops realtime scheduling, sends
`1012` to sockets, invokes disconnect hooks, and awaits accepted operations
before the caller closes game/platform databases. Slow sockets are terminated
after a short close grace. The existing process watchdog remains the final
limit on a genuinely stuck runtime operation.

The game owns checkpoints, saved outcomes, physics restart, paused clock and
recovery countdown. The transport cannot claim a saved phase or resume a
simulation. Account cookies and memberships use the existing SQLite platform.

## Verification boundary

`src/realtime.test.ts` checks exact scope parsing and the rolling rate window.
`apps/platform/tests/realtime.test.ts` uses real HTTP, `ws` sockets, platform
accounts/rooms and a separate SQLite fixture runtime. It checks independent
personalized snapshots, session revocation, cross-origin/host/cookie denial,
sequence/epoch ownership, same-ID HTTP/WS replay, bounded input/commands,
oversize/binary rejection, slow-connect ordering, graceful draining and reopening
both real SQLite stores/listener with the same session, membership and receipt.

The backpressure case deterministically substitutes the socket buffer reading
while using real sockets; it is an automated queue test, not a measured WAN
outage. These checks do not claim Test Bench gameplay, browser acceptance,
physical-device behavior, actual audio listening, production deployment or a
game checkpoint implementation.
