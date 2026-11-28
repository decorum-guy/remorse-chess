# Shift runtime and live protocol

The platform's existing authenticated room is the authority for admission. The
runtime independently resolves a human account against the frozen roster. Bots
have participant IDs and no account/session. The client and bot only receive
`viewForSeat` from the rules core.

## Lobby

`settings` contains `arena` (`foundry`, `calibration`, `depot`), `teamSize` (2 or
3), `rotateRoles` (default true), and `difficulty` (`easy`, `normal`, `hard`).
Optional `teams` maps participant IDs to `teal` or `amber`;
`initialNavigators` maps those two team IDs to a participant ID. Without a map,
the first `teamSize` occupied places form teal, the rest amber; the first place
in each team starts as navigator. Each team must have exactly one navigator.

Capacity must be exactly `2 * teamSize`. A start requires every place occupied,
at least two human accounts, ready flags, and valid equal teams. Existing
platform mutations invalidate human readiness after any settings or roster
change. Practice and lessons run the same rules locally without creating
synthetic platform accounts.

After a finished match, the host can call the normal authenticated, CSRF-guarded
`POST /api/platform/v1/rooms/:id/rematch` with `expectedRevision`. It reopens
that room with the same participants, resets human readiness, and preserves
the completed match and receipts in the runtime. The final live view may precede
platform reconciliation: clients enable rematch only after the room DTO says
`finished`, and retain the server's revision and state checks. A fresh start command creates
a new match ID. Old sockets no longer belong to the room's current match.

## Live channel

Connect to `/api/platform/v1/rooms/:id/live` on the portal's origin, with the
ordinary HTTP-only platform session cookie. The URL has no query. Shift implements
the published `RealtimeGameRuntime` capability from `@iva-games/session-kit` and
uses the single platform gateway described in
[`packages/session-kit/REALTIME.md`](../../../../packages/session-kit/REALTIME.md).
The shared protocol is `iva-live@1`; the game's payload version is `shift-wire@1`.

The first personalized snapshot supplies the five scope fields shown below.
Copy them exactly into every outgoing frame. The gateway checks Host, Origin,
session, membership and current match; it rechecks authorization before accepting
input or commands and delivering snapshots or receipts. A takeover closes the old
socket with 4001. Session revocation, a changed room/match or a scope mismatch
closes with 4003; shutdown uses 1012. Session activity is renewed by the shared
15-second heartbeat, without per-frame session writes.

The shared `epoch` is a random string identifying the current transport owner.
The game additionally supplies a numeric `view.self.controllerEpoch`. A new
transport owner increments that game epoch, clears queued pilot input and resets
the accepted sequence to -1. Repeating `liveConnect` for the same epoch does not
reset it again. A delayed disconnect for an old string epoch cannot neutralize
the replacement. The numeric core epoch and `roundId` remain in game payloads.

Client frames:

```json
{"protocol":"iva-live@1","wireVersion":"shift-wire@1","roomId":"<platform-room-id>","matchId":"<match-id>","epoch":"<transport-epoch>","type":"input","seq":1,"payload":{"type":"input","roundId":1,"controllerEpoch":2,"seq":1,"moveX":0,"moveZ":1,"aim":1.57,"fireHeld":false}}
{"protocol":"iva-live@1","wireVersion":"shift-wire@1","roomId":"<platform-room-id>","matchId":"<match-id>","epoch":"<transport-epoch>","type":"command","actionId":"example-shift-1","expectedRevision":1,"payload":{"type":"shift","roundId":1,"controllerEpoch":2,"roomId":"O","expectedBoardRevision":1}}
```

Other discrete payload types are `interact` and `ping` from the core types.
`actionId` may also be present inside the payload, but must match the envelope.
For a shift, outer `expectedRevision` must equal payload `expectedBoardRevision`.
For interact/ping it is the board revision when the command was created; their
existing core preconditions do not acquire an additional board-revision lock.
HTTP and WS commands both call the same `applyAction` method.

Outer input `seq` must equal payload `seq`. The runtime validates ranges and the
current core epoch, ignores stale/duplicate sequences, and drops continuous input
from preparation, recovery, another round or a navigator. Only the freshest input
per seat reaches the next authoritative tick. `lastAcceptedSeq` acknowledges
input consumed by the core, not merely received by the socket. The core resets
silent input after eight simulation ticks (about 267 ms at 30 Hz), independently
of TCP closure; a current disconnect also clears held movement/fire immediately.

The shared gateway limits input to 30 accepted frames per seat in a rolling
second, including across reconnects, and silently drops excess input. Commands
are limited to 12/second and eight pending per connection. The core additionally
enforces gameplay cooldowns and the stricter ping limit. Shared transport bounds,
including 16 KiB incoming text frames, binary rejection and bounded reliable
queues, are defined in the foundation document.

Every server frame has the five scope fields plus pinned `gameId`, `rulesVersion`
and `contentVersion`. Snapshots add `type:'snapshot'`, `tick`, `serverTime`,
`lastAcceptedSeq` and the filtered `view`; their target rate is 15 Hz. Accepted and
rejected game commands return `type:'receipt'`, `actionId`, `tick` and `result`.
The result is the plain core `Receipt`, including its exact commit tick. The outer
tick is the gateway's last delivered snapshot tick. Transport errors have
`type:'error'` and a stable `code`.

Retries preserve the original action ID, outer expected revision and entire game
payload, including its numeric epoch. Reconnect changes only the outer shared
scope. The SQLite receipt lookup occurs before current game epoch or phase
rejection, so an already committed action replays after takeover or restart.
After the immutable final result, an existing action ID still replays its
SQLite receipt (or rejects a changed payload with `ACTION_CONFLICT`). A fresh
action ID receives the terminal admission error `MATCH_FINISHED`; the client
must remove that pending action instead of retrying it. No new final-state
receipt or checkpoint is written for this rejected admission. Recovery is
different: commands admitted during its temporary pause receive a durable
`PHASE` receipt, so they cannot execute after the pause ends.
No server state, opposing input, account identity or hidden pose is serialized.
Slow sockets drop obsolete snapshots and close at the hard buffer limit;
receipts are not intentionally dropped. HTTP `GET .../match` remains the
recovery view and common lobby polling remains available.

The runtime caches the final filtered view per current transport owner. The
published shared gateway has no terminal-snapshot hint and may serialize and
send that view on later snapshot intervals. It continues authorization checks,
so takeover, revocation and rematch invalidate the old channel. Reconnecting
receives a fresh personalized final view under its new epoch.

## Ownership and recovery

Each process owns one in-memory state per match. Socket callbacks queue actions;
the 30 Hz scheduler batches both teams into the same fixed tick. Human input is
coalesced per seat. The core resolves priority, movement, interactions, combat,
delivery and phase deadlines in its declared order. Bot commands use the same
queue and rules.

SQLite owns `shift_schema`, `shift_matches`, and `shift_receipts`; it does not
modify another adapter's schema version. State and discrete receipts commit in
one immediate transaction before acknowledgement. Phase transitions, battery
transitions, shift start/end and the 2-second checkpoint are durable. Failure to
commit stops that resident match and returns no success receipt. Restart loads
the last whole checkpoint, cancels old control epochs, and applies the core's
five-second recovery preparation before simulation resumes. Finished matches
are loaded without advancing them. Finished HTTP result reads do not populate
the simulation map. A completed resident remains available while live result
pages reference it, then is evicted after the final lease closes; the result
and receipts remain in SQLite. A stale takeover lease cannot evict its active
replacement. A normal shutdown flushes pending commands and checkpoints before
closing the database. The shared gateway stops scheduling, closes sockets and
awaits accepted operations and disconnect hooks before the caller closes either
database. Connect/disconnect hooks are serialized per seat, including a hook
whose response deadline elapsed while the operation was still running. Invalid
WebSocket handshakes do not acquire a game control. The process shutdown watchdog
remains the last bound for an operation that never settles.

The `advanceTicks` method is an in-process deterministic test driver; no network
route exposes it. Production never accepts client positions, tick changes,
scores or results.

## Isolated browser stand

After `npm run build:foundation`, run
`node games/shift/scripts/demo.mjs --port 4398`. It serves the built portal and
platform on one loopback origin and creates two test accounts through ordinary
signup and the development file mailbox. They become friends through the
existing API. No Telegram or SMTP delivery is enabled.

`--rooms` creates a 2×2 and 3×3 lobby through invitations, reservations and bot
seating. `--start` additionally confirms both humans and starts those matches.
Without these flags, acceptance can create and configure the lobbies in the UI.
The script prints local-only test credentials, profile paths and a
`SHIFT_DEMO_READY` line after setup. Each run gets a new private directory under
`.qa/shift-demo/`; `fixture-4398.json` points to the matching run. No prior DB or
running process is replaced.

Programmatic tests can import `startShiftDemo` and use its real API clients,
two independent `storageState` files, `createRoom`, `stop`, and
`restart({crash:true})`. The latter kills only the child this fixture started.
The server tests separately SIGKILL a subprocess after an acknowledged shift
and verify the whole SQLite checkpoint, frozen recovery interval, exactly-once
receipt, and completed move after restart.
