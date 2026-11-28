# Test Bench architecture and operational contract

This document describes the checked-in implementation and executed server checks. Game requirements are in [SPEC.md](SPEC.md); completed product acceptance belongs in [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md). A build, a headless simulation or an HTTP/WebSocket fixture does not establish a personally played browser cycle, listening, or physical-device performance.

## Ownership and entry points

| Layer | Owner and source |
| --- | --- |
| Accounts, sessions, friends, invitations, frozen room roster | Existing `apps/platform`; the game accepts authenticated player IDs from this layer. |
| Shared realtime transport | `packages/session-kit/src/realtime.ts`, `apps/platform/src/realtime.ts`, and the platform HTTP/service adapter. No vehicle, cargo, bot or scoring imports. |
| Authoritative game | `src/runtime.ts`, `store.ts`, `physics.ts`, `rules.ts`, `catalog.ts`, `tracks.ts`, `bots.ts`. |
| Bounded simulation owners | `src/worker-runtime.ts` and `src/worker-entry.ts`. |
| Game interface | `src/TestBench.tsx`, `components.tsx`, `live-client.ts`, `controls.ts`, `preferences.tsx`, `Scene.tsx`, `Audio.ts`, `sound.ts`, `test-bench.css`. |
| Portal integration | Lazy `apps/portal/src/TestBench.tsx`, game registry, and `apps/platform/src/main.ts`. |
| Original assets | `assets-source/`, `public/test-bench/`, `assets-manifest.json`; the portal build copies the public directory using `apps/portal/test-bench-assets.ts`. |

The shared foundation was developed separately in `feat/iva-realtime-foundation`, [PR #42](https://github.com/decorum-guy/iva-games/pull/42). Its remote commit `6a9337df076c9542c8c8a705bb0accc331cea304` was integrated into `feat/test-bench`. Remote and locally tested commit `6d1a172a8284687a52aba151c7fbed80ac927ea0` share the exact tree `6b004426bc93e9127607cd30e49b3ffbd773c87d`. PR #42 was still open, draft and unmerged at the read-only coordination check on 28 November 2026. The intended release path is the accepted game PR through ordinary main CI, including this foundation, rather than an intermediate foundation deployment.

At that same check, remote `feat/shift` was `a9fd11dc758a14a46fd0efe7ade0a3766b2ca1c8`. Its only changes from the original main were `games/shift/SPEC.md`, `STATUS.md`, `package.json` and `vitest.config.ts`. Its status says it intends to add a narrow shared realtime interface. No published Shift gateway code or Shift PR was observed. This is a concrete ownership overlap to reconcile before integrating future shared changes, not evidence of a second implemented gateway. The existing optional interface and authenticated endpoint are the reuse point. No repository comment or message to another project owner was sent as part of this inspection.

### Subsequent cross-PR audit after candidate 7

The preceding paragraph records the earlier ref only. A fresh inspection found the following **published draft implementations**, while accepted main remained `1f571a7fa24a5c682a236d5fa0ef5a499f09c24d`:

| Draft | Inspected immutable head | Current transport relationship |
| --- | --- | --- |
| [Shift #46](https://github.com/decorum-guy/iva-games/pull/46) | `d917de193ea23a10d01a098a4aa16be709f16ed4` | `apps/platform/src/live.ts` attaches another handler to the same `/api/platform/v1/rooms/:id/live` path, using `LiveGameSession` / `openLiveSession`, `shift-wire@1` and `controllerEpoch`. It does not use the #42 `iva-live@1` contract. |
| [Knock First #48](https://github.com/decorum-guy/iva-games/pull/48) | `3487a7d981cc158d5c649e86eeedee9107fba4ed` | Includes #42 in its history and uses its `RealtimeGameRuntime` / `iva-live@1`. The inspected platform `realtime.ts` is byte-for-byte identical to #42. |
| [Forpost #47](https://github.com/decorum-guy/iva-games/pull/47) | `5cc963b84aa8401e24621e595beca9ed16f9e0ae` | Separate `apps/realtime-server`, `/ws/realtime/v1`, `iva-realtime-v1`, and a signed admission ticket from `/rooms/:id/realtime-ticket`; overlaps platform lifecycle, shared types and deployment, not the same upgrade path. |

These branches are not incorporated into this game or main. Two handlers for the same room-live URL are **not an agreed common foundation**. The integration requirement is one #42 platform gateway, with a game-specific Shift adapter to its optional runtime contract and unchanged game-owned state/receipts; #48 already reuses that gateway. Forpost's separate service requires an explicit compatibility decision for lifecycle, shared contracts, images, compose and backups. This is an unresolved cross-PR integration boundary, not authorization to overwrite another game's branch or silently change its transport. No such edits, merges or external messages were performed. Recheck the actual shared main before any accepted release.

## Build and local run

Use Node 24 as in CI. From the repository root:

```sh
npm ci --no-audit --no-fund
npm run build:foundation
```

`vite.platform.config.ts` emits `dist-platform/main.js`, `dist-platform/test-bench-worker.js` and their shared runtime chunk. Rapier `0.19.3` is bundled from the Test Bench workspace, independently of older physics dependencies elsewhere. `ws` is an explicit platform production dependency. `Dockerfile.platform` copies the entire server output and portal build after pruning development dependencies. Both worker files are included in the deployment compatibility fingerprint; the whole game directory and its resolved dependency closure are image inputs.

The main renderer uses `@react-three/fiber` pinned to `9.8.2`: `createRoot` configures the existing Three.js scene/camera/renderer, and `useFrame` owns animation updates. Canvas 2D remains the explicit alternate renderer and WebGL-loss fallback. Six deterministic seat colors use a dedicated chassis material cloned per vehicle; the same palette is used by Canvas 2D. The frozen seat index reaches the online builder, local workshop test, live lane and selected spectator lane. Standalone practice has a default seat color.

An isolated production-build stand with local-only test accounts:

```sh
NODE_ENV=development \
PLATFORM_HOST=127.0.0.1 PLATFORM_PORT=4391 \
PORTAL_ORIGIN=http://127.0.0.1:4391 \
PLATFORM_DATABASE_PATH=.runtime/test-bench/platform.sqlite \
PLATFORM_LAB_DATABASE_PATH=.runtime/test-bench/runtime.sqlite \
PORTAL_DIST_DIRECTORY=apps/portal/dist \
MAIL_MODE=file MAIL_FILE_DIRECTORY=.runtime/test-bench/mail \
TELEGRAM_ENABLED=false TELEGRAM_AUTH_ENABLED=false \
node dist-platform/main.js
```

The JavaScript above is the production build; `NODE_ENV=development` explicitly permits the isolated file mailbox. This is not the production authentication configuration. Production uses the existing secure portal sessions and persistent `/data/platform.sqlite` and `/data/platform-lab.sqlite` volume. No test account delivery leaves the local file mailbox.

For Vite development, use port 5197 and start the backend with `PORTAL_ORIGIN=http://127.0.0.1:5197`; then run `IVA_PLATFORM_TARGET=http://127.0.0.1:4391 npm --prefix apps/portal run dev -- --port 5197`. The WebSocket origin must match the browser origin exactly. Do not reuse another worktree's databases or running listener.

## Worker and simulation lifecycle

Production creates two worker threads. The room ID deterministically chooses a preferred owner; creation tries the other owner only when the preferred owner returns `GAME_BUSY`. Other failures retain their original result. Each owner admits at most three active cups, for a total of six. New match IDs contain the actual owner as `tb0_…` or `tb1_…`. Workers share the SQLite file but load and advance only their own matches. Unprefixed match IDs route to owner zero. Each owner retains at most 64 finished matches in memory; evicting one also clears its controls, while durable results remain readable from SQLite. Changing routing or reducing the pool requires a compatibility decision for persisted matches.

The platform records a start attempt before invoking the runtime. A first, definitive `SessionError('GAME_BUSY', …, 503)` means no match was created: its existing start-command row becomes terminal, the room returns to an editable lobby, and the additive `Room.startError: 'GAME_BUSY'` identifies the capacity rejection. The game lobby renders that error in RU/EN and again offers its normal start/cancel/leave controls. An explicit later start replaces only that known-rejected command with a fresh ID. Any prior unknown outcome, timeout or interrupted attempt keeps its frozen roster and original command ID, even if a subsequent call returns `GAME_BUSY`. This uses existing SQLite columns and requires no schema migration.

Each owner initializes Rapier and restores its assigned matches before signalling readiness. Main awaits both game and platform readiness before listening. Workers retain their event-loop references through startup; closing the runtime explicitly terminates them. Removing that reference before readiness was observed to make Node exit with an unsettled top-level await, and was corrected.

The game advances fixed `1/60` second steps. A pump catches up at most twelve steps at once; excessive remaining lag extends the phase deadline and persists a pause rather than consuming race time without simulation. Inputs older than 300 ms become zero throttle with braking. Bot policy receives its own lane and public track data and uses the same lane physics.

`groundHeight` and `terrainMesh` use explicit surface breakpoints. The Climb ramp rises 2.9 m from `Z=24` to `Z=34`, with 0.6 m transition bevels at its ends. The shared mesh supplies terrain rendering and collision geometry; a beveled ramp omits the straight decorative GLB overlay so it cannot cover the physical bevel with a different visible slope. `axleGrip` applies absolute wet coefficients: lateral/longitudinal `0.54/0.64` for road and high axles, `0.85/0.90` for all-terrain axles; dry coefficients come from the part catalog. Wet coefficients are not multiplied by the dry values. These final geometry/grip changes must be included in the exact candidate used for acceptance.

IPC has at most 256 pending calls per owner, a ten-second startup/call deadline, explicit dead-owner rejection, and at most three replacement attempts within a one-minute restart window. A worker timeout terminates that owner so it can recover from durable state. Platform HTTP and the gateway have shorter response deadlines; a response timeout does not imply cancellation of an already accepted game operation.

An internal `ownerMetrics` worker RPC reports bounded samples of whole pump, checkpoint and SQLite-write durations, advancing steps and accumulated overload pauses. The profiling harness can reset its observation window. This RPC is not exposed by HTTP, the live gateway or the browser. A pump sample includes all work performed during that invocation, so it is not a measurement of one vehicle's physics step.

## Wire and personalized views

The optional `RealtimeGameRuntime` extends the existing HTTP game contract with `wireVersion`, `liveConnect`, `liveInput`, `liveSnapshot` and `liveDisconnect`. The endpoint is:

```text
/api/platform/v1/rooms/:roomId/live
```

It requires the existing session cookie, exact configured origin, allowed host, current room membership and the room's pinned match/runtime. Query parameters and tokens in URLs are rejected. The first frame is a personalized snapshot. A new connection to the same match/player obtains a fresh epoch and closes the predecessor with code 4001; an old disconnect cannot clear the successor's controls.

The exact client scope is `protocol, wireVersion, roomId, matchId, epoch`, with protocol `iva-live@1`. An input adds `type: input, seq, payload`. A command adds `type: command, actionId, expectedRevision, payload`. Server frames additionally carry game/rules/content versions. Snapshots carry `tick, serverTime, lastAcceptedSeq, view`; receipts carry the command ID and the runtime result. The receipt envelope tick is the latest delivered snapshot tick, not an invented exact physics-action tick.

Test Bench input payloads contain `phaseId, throttle, steering, brake` and an optional `watchParticipantId`. The runtime validates phase/epoch, ignores old sequence numbers and clamps finite driving values. Only a finished driver can select another participant's lane. The active view contains the driver's full lane, compact opponent progress, and an optional selected spectator lane. Opponent draft blueprints are hidden in briefing/building and recovery from those phases. Full stage event records appear in result phases; Rapier checkpoint bytes never enter client views.

The gateway limits input to 30 packets per second per seat across reconnects and requests snapshots at about 15 Hz. Incoming frames are capped at 16 KiB; binary frames are rejected. Inputs coalesce to the latest pending value. Above 128 KiB buffered output, old snapshots are skipped; reliable replies are bounded to 32 entries and 512 KiB total. There are at most eight queued commands, with twelve commands and ninety total messages per second per connection. An individual outgoing message is capped at 512 KiB. Session revocation and membership are checked again while connected.

The browser sends rare actions over the existing HTTP endpoint, retains an uncertain command with its original ID for retry, and uses WebSocket input/snapshots for driving. It reconnects on stale control or game timeout, polls HTTP while no live scope exists, and stops reconnecting when superseded. Fresh snapshots replace obsolete state by revision/tick; input authority remains server-side.

## Storage, receipts and recovery

`BenchStore` adds `test_bench_schema`, `test_bench_matches` and `test_bench_receipts` to the configured game-runtime SQLite database. WAL, foreign keys, a five-second busy timeout and private file permissions are enabled. Starting a room records a request hash and unique start-command/room IDs. A conflicting replay is rejected.

Accepted discrete commands save state and a receipt in one immediate SQLite transaction, keyed by `(match_id, participant_id, action_id)`. The request hash covers the original envelope. Identical retries produce the current authorized view without applying the command again; changed content under the same ID produces `ACTION_CONFLICT`. Whole-view `expectedRevision` is validated as an integer; game concurrency is guarded by `phaseId` and, for blueprint edits, `buildRevision`.

A checkpoint contains the full phase, roster, versions, builds, stage results, lane state, base64 Rapier world snapshot and body/collider handles. The owner checkpoints at least every 120 advancing ticks, on significant lane events, phase boundaries, accepted commands and planned shutdown. A finishing lane is persisted before the scored state is served. A phase boundary has its own atomic save; if it fails after a command receipt was committed, that committed command remains accepted.

Capture/write failures quarantine only the affected match: controls are cleared, mutated worlds are disposed, and the durable state is reloaded. Its pump stops until a read can reconstruct and successfully persist recovery. Failed writes do not become successful acknowledgements. Both uncommitted blueprint rollback and a committed ready receipt followed by phase-save failure have explicit fault-injection checks.

Restart reconstructs the latest complete checkpoint, starts a five-second shared recovery phase and retains `phaseEndsAt - savedAt` as remaining time. Downtime is not charged to the race. Epochs are not persisted; clients reconnect for new control. Already committed receipts/results survive, while steps after the last durable checkpoint may be replayed. Stored schema/rules/content/physics versions are checked at load. Current identifiers are `test-bench@1`, `test-bench-content@1`, `test-bench-wire@1`, `test-bench-bot@1`, `test-bench-rapier@1`, snapshot schema 1.

## Verification and limits

| Command from repository root | Actual scope |
| --- | --- |
| `npm run test-bench:test` | Rules, catalog limits, real Rapier lanes, cargo/gates, runtime privacy/replay/restart and persistence fault injection. |
| `npx vitest run --config vitest.platform.config.ts apps/platform packages/session-kit` | Shared HTTP/session/WebSocket/SQLite contracts, including authentication, epochs, bounds and deterministic backpressure injection. |
| `npm run test-bench:platform` | Built main/worker, two independent local accounts plus bot, real HTTP/WS, personalized views, private drafts, commands/replay, budget/conflict rejection, input acknowledgement, graceful restart, recovery, SQLite receipts and served asset hashes. It does not play a full cup or use a browser. |
| `node games/test-bench/tests/worker-smoke.mjs` | Two built workers, six rooms/36 seats/30 bots, six neutral/braking input streams, shared SQLite and IPC, bounded admission, parent-loop and per-owner pump/checkpoint/write observations, tick advancement, abrupt owner termination, durable replay and fresh epoch. It calls worker entries directly and does not exercise pool fallback routing or WebSocket transport. |
| `npx vitest run --config games/test-bench/vitest.profile.config.ts` | Serial opt-in bot/build/track/mirror matrix and the admitted three-room/18-seat owner profile with on-disk SQLite. |
| `node games/test-bench/scripts/verify-assets.mjs` | Export hashes, provenance fields, GLB structure and WAV signal checks. No listening. |
| `node games/test-bench/scripts/visual-qa.mjs` | Automated local static production interface/scene inspection. Its observation report defines its actual coverage; it is not an authenticated online-cup acceptance. |
| `npm run test-bench:browser` | Automated Chromium UI against production client/server bundles, two independent accounts and two bots. The runner records its executed scenarios and open coverage; authoring or syntax-checking it does not establish a passed browser run or personal play. |
| `IVA_BROWSER_RUN=rtt120 IVA_BROWSER_LATENCY_MS=60 npm run test-bench:browser` | The same browser path through an owned, bounded loopback TCP relay delaying HTTP and WebSocket bytes by 60 ms in each direction. It records measured browser health-request round trips and input-to-acknowledged-snapshot timing. This is an injected nominal 120 ms network fixture, not a public-internet measurement. |

Ordinary `npm run check` discovers the game's regular Vitest project. The platform workflow runs `test-bench:platform` after the builds and existing platform smoke. Its separate Test Bench browser job builds production bundles, verifies assets, installs Chromium and invokes the browser runner; the default invocation has no injected latency. A pending or green baseline job does not establish the opt-in latency scenario or personal play. Release image checks preserve the existing games and additionally require the worker file, Test Bench tables/version and exact served asset hashes. The public catalogue check verifies both District and Test Bench. A green release run still requires an actual `DEPLOYED` result; a newer main can supersede a candidate.

Performance reports are measurements of their named fixtures, not interchangeable release proofs. The current headless profile advances three six-seat rooms in one synchronous production-sized owner with a temporary on-disk SQLite database, including serialization and checkpoint writes. Its p95 threshold is 12.525 ms. Historical six-room single-owner measurements predate the three-room admission limit and cannot establish the current production capacity. An admission cap itself is also not a passed performance measurement.

The two-worker fixture uses wall-clock simulation and polls each room about 15 times per second while sending six input streams approximately every 34 ms. It checks input acknowledgement progress, parent event-loop p95, whole-owner pump p95, durable-write observations, absence of overload pauses, and advancement close to 60 Hz. This is server/IPC evidence; it excludes WebSocket fan-out and browser rendering. Neither fixture replaces the required six-room/browser load check, 120 ms RTT scenario, device/frame-time measurement or first-scene network budget. Reports under `.qa/test-bench` may be overwritten by later runs, so acceptance must record the exact committed SHA, build identity, environment and result. Failed or superseded measurements remain separate from accepted release evidence.

### Source corrections and remaining acceptance gates

The source review led to the corrections below. Their implementation does not replace the corresponding executed acceptance evidence. Recheck the exact candidate and its acceptance record before release.

| Requirement | Current implementation and remaining evidence |
| --- | --- |
| SPEC §7.1: Three.js through React Three Fiber or a thin R3F adapter | R3F `9.8.2` is connected through `createRoot`/`useFrame`. Repeat 3D/2D fallback, resizing and scene-lifecycle acceptance on the resulting production build. |
| SPEC §6.1: an individual chassis color | Six seat colors, per-vehicle materials, regenerated chassis export, matching Canvas 2D paint and workshop/test/race/spectator seat wiring are present. The browser runner checks that the two room seats have different paint identifiers; visual consistency and reconnect confirmation require its executed result and personal inspection. |
| Capacity rejection and uncertain starts | The reopened lobby and RU/EN error are implemented. Real HTTP/SQLite regressions cover rejected-command retirement, restart, explicit retry/cancellation and preservation of earlier unknown outcomes. Browser verification of the displayed state remains separate. |
| SPEC §7.3: a real 120 ms RTT test with a short interruption | The opt-in relay is implemented for both HTTP and WebSocket traffic, with browser round-trip samples and an explicit latency report. The nominal 120 ms configuration must actually run; a 15 Hz delayed-observation policy test or the zero-delay CI invocation does not close this gate. |

The automated browser runner also explicitly leaves exact tied-result construction and any unobserved surviving loose-cargo pickup open. These must be closed by their required targeted acceptance scenarios; existing rule tests do not establish browser execution. At this document freeze, completed personal browser cycles remain **0**. Listening, physical-device performance, the required full browser/load scenarios and release confirmation must have their own recorded evidence. No source review, authored runner or server fixture substitutes for the two requested personal browser cycles.
