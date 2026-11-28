# Standalone realtime runtime

This package supplies the account-room bridge, WebSocket gateway, authoritative simulation thread and sequential SQLite writer. The browser receives a game adapter's permitted view. It never receives a restoration snapshot or an unchecked client-supplied body position.

## Local launch

From the repository root run `node scripts/dev-tyaga.mjs`. It builds the platform and portal, Tyaga and the three realtime entry points; creates isolated Ed25519 keys and databases; then opens listeners on 4284 (realtime), 4285 (platform) and 5284 (the common browser origin). The browser entry is `http://127.0.0.1:5284/play/tyaga/`.

The runner uses the existing local file-mail mode and normal registration/verification endpoints to prepare two QA accounts. Their generated credentials are stored only in ignored `.qa/tyaga/accounts.json`. It does not add a production login shortcut or send email/Telegram messages. `.qa/tyaga/build.json` records the source commit, dirty flag, build identifier and SHA-256 of every served build file. `--no-build` records and uses the already built artifacts. Ctrl+C drains this runner's own processes. Other checkouts, processes and databases are untouched.

For recorded crash/recovery QA, the browser driver may spawn this runner with a
Node IPC channel. A parent sends
`{type:'tyaga-runner-control',id:'unique-id',command:'status'}` and receives
`{type:'tyaga-runner-result',id,ok,status}`. The only mutation commands are
`restart-realtime`, `crash-realtime`, and `start-realtime`. They address the
runner's own retained `ChildProcess`, never a supplied PID. Graceful restart
requires a successful drain exit; an explicit crash sends SIGKILL only to
realtime and leaves platform/browser processes and all databases in place.
Restart after a crash waits for the old 15-second owner lease rather than
changing its SQLite record. The same built files are reused, and status reports
each child PID, start time and exit/signal for the acceptance record. This
control exists only on the parent IPC channel, not on a website HTTP endpoint.

## Package boundary

- `packages/realtime-kit/src/index.ts` is browser safe: protocol/types, message validation and view-delta operations.
- `src/adapter.ts` is the platform-facing `GameRuntime` bridge. It signs service requests and one-use connection tickets. It does not simulate physics.
- `src/server.ts` owns HTTP/WebSocket, Origin/Host/subprotocol checks, authentication deadline, per-connection input limits, acknowledged per-observer deltas and output backpressure.
- `src/simulation-worker.ts` owns the fixed-step engine and game adapters. A preallocated simulation worker is the initial pool; it does not run on the network event loop.
- `src/writer-worker.ts` is the only production SQLite writer. WAL uses `synchronous=FULL`. Successful acknowledgements are returned after its transaction completes.
- `src/engine.ts` owns control generations, connection presence, stale-input neutralization, pause/return, durable receipts, full-world checkpoints, rewind branches, recovery and outcome outbox.
- `src/storage.ts` owns fenced leases, full restoration snapshots, replay journal, receipts, checkpoints, ticket/bridge nonce consumption and result acknowledgements.

## Configuration

Platform requires all three of `REALTIME_INTERNAL_URL`, `REALTIME_SIGNING_KEY_FILE`, and `REALTIME_KEY_ID` to enable the Tyaga account-room adapter. The private Ed25519 key stays on the platform side. Partial configuration fails startup. With none present, existing games start normally and Tyaga is not falsely advertised as an available runtime.

Realtime requires `REALTIME_TRUSTED_KEYS_FILE`: JSON mapping trusted key IDs to PEM Ed25519 public keys. It never needs the platform signing private key. Other variables are `REALTIME_HOST`, `REALTIME_PORT`, `REALTIME_DATABASE_PATH`, `REALTIME_ALLOWED_ORIGINS`, `REALTIME_ALLOWED_HOSTS`, `REALTIME_TYAGA_STATIC_DIRECTORY`, `REALTIME_MAX_MATCHES` and `REALTIME_REVISION`. Production origins must be HTTPS. The checked-in fallback of two active/returnable matches is a configuration default, not an accepted capacity. The five local calibrations below did not accept two rooms. Set the deployment limit from completed measurements on its actual resource allocation.

Health paths are `/api/realtime/v1/health`, `/health/realtime/live` and `/health/realtime/ready`. The reply identifies actual adapter artifacts and the supplied build revision; readiness fails for frozen failed matches or draining.

For local rendered QA, `TYAGA_REALTIME_CPUS=0,1 taskset -c 2-8 node
scripts/tyaga-browser-workbench.mjs …` keeps the runner/browser on the outer
mask and opts only its owned realtime child into the two-CPU mask. The dev
runner validates actual child/thread affinity after readiness and restart,
records it in `build.json.cpuAffinity`, and includes it in IPC status. Without
the environment option, process launching is unchanged. This isolates the
selected workload from the local renderer; it does not reserve host cores or
accept a capacity claim.

## Browser connection

1. Use the existing platform account/lobby APIs to create and start a room.
2. POST `{}` to `/api/platform/v1/rooms/:roomId/realtime-ticket` with the authenticated cookie, current CSRF token and permitted Origin. The endpoint derives player identity from the website session; additional body fields are rejected.
3. If the ticket includes `clientContentHash` and `launchUrl`, verify the hash, same origin, exact `/play/:gameId/versions/:hash/` route and room ID; navigate to that version before opening the socket. It serves the exact retained client for the saved world. Open the returned `websocketPath` with the returned `subprotocol` (`iva-realtime-v1`). JSON messages separately use `protocolVersion: "iva-realtime@1"`; the at-sign is not valid in an RFC 6455 subprotocol token.
4. Send `{ "type": "authenticate", "ticket": "…" }` as the first frame within five seconds. A ticket lasts 30 seconds and is atomically consumed once in durable storage. It is never placed in a URL.
5. Read `hello`, then `full`. Every subsequent message is scoped to the match, epoch and controller generation. Inputs contain an increasing `inputSeq`; discrete actions contain a stable `actionId` and game-owned payload.
6. Coalesce acknowledgements to the newest retained reconstructed snapshot, at most 20 times per second. Apply a `delta` only to its own `baselineSnapshotSeq` using `applyViewChanges`; request `resync` when the baseline is absent. Keep the last acknowledged baseline until a newer ACK, and keep the baseline still referenced by the server until its ordered stream confirms the switch. Full views are sent at least every two seconds and on epoch/control changes. Baselines are separate for every observer and reset with the transport, epoch or controller generation.
7. A second connection to the same seat is an observer until `claimControl`. The former controller loses mutation rights at the persisted transfer. Reconnection gets a new ticket and full view; accumulated movement is never replayed.

`resync` may carry an old epoch because it cannot change the world and remains bound to the authenticated match. Movement and actions cannot. Acknowledgements at the 20 Hz snapshot rate have a separate limit from low-rate control commands.

Trusted workers may negotiate `iva-static-view@1` with their host. Only an
adapter's explicitly declared `immutableViewFields` are retained, separately
for each connection, participant, epoch and control generation. A replacement
object invalidates that field's cache. Dynamic entity state always crosses the
worker boundary. The host reconstructs the ordinary public snapshot before
generating observer deltas; no internal reference token reaches the browser.
Old workers and hosts continue to exchange complete ordinary snapshots. This
reduces repeated map copying without changing physics or snapshot frequencies.

## Durability and lifecycle

New starts enter a durable FIFO admission queue shared by every archived simulation version. A host can hold one pending start. Each capacity reservation lasts 15 seconds; retries preserve its token and deadline, and an expired reservation moves behind waiting hosts. Insertion of the world consumes that reservation in the same SQLite transaction. The platform retains its frozen start command and exposes `startStatus.state: "queued"` with position/retry details while waiting. A full server never creates a replacement room or silently drops participants. Local development capacity is separate from the production limit.

Continuous input becomes neutral after 250 ms measured from arrival at the gateway. The gateway retains only the newest waiting input, applies the input rate limit at arrival, drops expired queued input, and sends its trusted monotonic arrival to the simulation worker. A delayed action commit or worker RPC cannot renew a held key. Discrete commands keep their independent bounded queue and durable receipts. At five seconds without a controlling human connection, the same participant seat becomes bot controlled. At ten seconds with no controlling humans, the world is saved and paused for up to 24 hours. A result reached without a human is retained as pending, then resolved only after return and a three-second countdown. Expiry abandons the attempt without a winner.

Discrete commands persist a receipt and full snapshot atomically. Lost replies can be retried with the same ID and payload; a conflicting payload is rejected. Physical batches journal the normalized inputs and controller context; periodic full snapshots bound replay. Recovery checks adapter/physics/serializer artifacts, verifies hashes and replays only committed batches. A mismatch leaves recovery blocked instead of silently generating a replacement game.

Network epochs change on recovery and rewind. Receipt branches change only on voluntary rewind, so recovery cannot charge a confirmed command twice. Rewind restores the complete game snapshot while keeping current controllers, elapsed time, rewind count and audit sequence outside that rollback. Old-network-epoch messages are rejected. Positive events/snapshots never precede the writer's commit barrier.

The engine freezes a match if storage fails, so no uncommitted mutation becomes a successful acknowledgement or new authoritative snapshot. A fenced owner lease prevents a former process from writing after a successor acquires the match. Graceful drain saves all active worlds before releasing leases; a crash requires the old 15-second lease to expire before a different owner starts.

The worker host archives its own compiled simulation code/chunks in the runtime data volume, with SHA-256 file and aggregate manifests. Each saved match pins that actual artifact; updates load its exact retained worker and serializer. Missing archives isolate affected matches as `VERSION_UNAVAILABLE` while permitting compatible new rooms. Snapshot corruption, replay gaps and diverged hashes likewise quarantine only the affected match; the original saved bytes remain available for diagnosis. Archive contents cannot come from a client URL or an unchecked saved path. No automatic pruning removes active/returnable versions.

An unexpectedly exited simulation worker is restarted from its verified archive after the old 15-second owner lease expires. The gateway closes affected sockets for reconnection while other versions and the SQLite writer remain available. At most three attempts are made within 60 seconds; health reports recovering/failed workers and restart counts. A failed writer freezes mutation instead of starting another writer against uncertain durability.

Overload pauses have a visible reason. For a connected human, the engine waits for one second of stable scheduling, persists a three-second recovery countdown, then resumes without replaying accumulated movement. A further stall restarts that sequence. Those transitions preserve current control ownership and are journaled before being advertised.

The complete built browser client, including public model/audio/font resources, is independently content-addressed in `/data/client-artifacts/<sha256>/`. Its hash includes game/rules/content metadata and every relative filename and byte. Each new world pins this hash and its `/play/:gameId/versions/:hash/` route. All valid retained versions remain served after deployment; ticket and room launch links select the saved version. Missing or corrupt pinned client content blocks only its affected worlds. The startup archive accepts only locally built files, rejects symlinks and absolute document asset paths, and fsyncs before a match can reference it. Both runtime and browser archives are retained beyond the 24-hour return window until an explicit reference-aware cleanup policy is implemented; volume growth must be monitored.

Signed `POST /internal/realtime/v1/drain` is idempotent and returns a durable match/outbox manifest after all workers have saved. Signed `POST /internal/realtime/v1/cancel-drain` restarts those exact archived workers from the saved worlds if release preparation was cancelled. The public proxy must reject all internal paths. Host promotion requires this positive receipt, both database backups and their verified platform/runtime link manifest before replacing an existing realtime image; see `deploy/iva-games/REALTIME_BOOTSTRAP.md`.

## Verification scope

Signed `GET /internal/realtime/v1/metrics` reports bounded telemetry without
player names, account IDs, input payloads, tickets or world data. Public health
omits these detailed records. Every game/worker reports physical step, writer
round-trip, serialization, uncommitted-change age and published-world age. Fixed
histograms retain counts for the complete process lifetime; `p99UpperMs` is a
conservative bucket bound, while `recent.p99Ms` is exact only for the reported
last 2,048 observations. A null upper bound with nonzero count means overflow
beyond the last finite bucket, not a passing latency. Worker and gateway event
loop delay/utilization, process memory/CPU, RPC queues, socket queues, coalesced
or expired inputs and full/resync reasons are separately visible. Archived
workers without instrumentation are explicitly counted as legacy workers.
Rate-limit counters distinguish input, action, ACK, heartbeat, resync and
control claims. Overload journal records retain the triggering scheduler gap,
accumulated lag and preceding step/batch/serialization/commit durations. Signed
health keeps only the last such observation per game; the values are timing
context, not a diagnosis of the delay's cause. Aggregate overload counters
include a measured-worker count so retained older workers are not silently
treated as instrumented.

`taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 3600
--rooms 1 --profile humans --output .qa/realtime-load/candidate-humans` starts only its own compiled main,
private SQLite and keys, and six independent protocol clients. `--profile
bots` instead runs one human controller and five real bots per room. It uses
normal 30 Hz movement and durable appearance actions, checks snapshot/delta
projection and records five-second measurement samples, file growth and exit
status. `--runtime` and `--client` can select a separately compiled candidate;
the output directory must be new. A short calibration uses `--seconds 30` and
must not be reported as an hour. An optional `--memory-mib` sets an explicit
measurement budget, not an enforced container limit.

`--server-cpus` is an explicit local affinity budget. Every runtime thread's
actual mask is checked at startup and during measurement; the load generator
must be pinned to other CPUs. Process CPU consumption divided by that core
count is checked separately from event-loop utilization. Without this verified
budget the report cannot pass its process-CPU headroom check. Affinity does not
reserve CPUs or establish a production VPS quota; use masks available on the
actual test machine instead of assuming the example IDs exist everywhere.

The report distinguishes the completed duration, measured local CPU/memory
reference, whole-window histogram bounds, recent exact quantiles and individual
budget failures. It does not measure an unavailable production VPS, rendered
browser performance, TCP packet loss or the separate simultaneous heavy
ferry/lift/rope scene. Those gates require their own recorded runs on the exact
accepted artifact. Do not run a capacity measurement concurrently with browser
acceptance on the same executor.

The first five 30/60-second calibrations are recorded in
`qa/load-calibrations.json`. None passes the complete capacity gate, and none
is an hour-long run. The third also contains a map content revision, so the
series is not an isolated single-variable benchmark. A passing selected
capacity still requires the hour, heavy-scene repetition and a measurement on
the actual deployment machine.

The fourth/fifth runs retain the previous v5/content-2 physics source while
checking ACK-base retention and immutable-map sharing. The fourth overlapped
other physical tests. The fifth used an agreed pause in those tests; it does
not establish exclusive CPU allocation on the executor. It maintained 60 Hz
without overload, but the step-p99/headroom gate remained open.

The next proposed calibration is one room, first six human protocol clients,
then one human and five actual bots, on the same frozen candidate in a window
without browser/physics workloads. This is a plan, not an accepted one-room
capacity. [The capacity review](qa/CAPACITY_REVIEW.md) records the five results,
the snapshot-cadence inspection, the difference between event-loop activity and
physical CPU headroom, and exact sequential 60-second/hour commands. A passing
short probe must precede the full hour and the separate maximum-scene repeat.

The QA-only `qa/heavy-seed.ts` and `scripts/vite.realtime-heavy.config.ts`
prepare one-room `--scene ferry` or `--scene lift` fixtures for the same compiled
worker. `--scene paired` explicitly requires two rooms. Normal loaded masses,
six physical crew, two cable links and 48 contact segments are asserted; named
extra supports/hanging loads are labelled stress-only, not ordinary inventory.
The fixtures have not yet been calibrated. During measurement only ordinary
authenticated actions/inputs move the machinery, and a lost load, inactive
operator or broken cable fails the run. No shorter run, idle scene, changed
timestep, relaxed p99/headroom target, or test-only physics path can replace
the required gates.

The browser helper `applyViewChanges(before, changes, ['map'])` uses the same
projection as the load client. The optional third argument retains only the
declared immutable top-level field; all dynamic bodies/inventory are copied.
A delta that changes the retained field copies it before writing. Without the
third argument, existing callers still receive a fully detached projection.

`.github/workflows/iva-realtime-network.yml` prepares a separate CI TCP matrix.
The unmodified candidate runs with `--network none` and no capabilities. A
temporary tool container shares only that candidate's loopback namespace and
receives `CAP_NET_ADMIN`; it has no Docker socket, production volume, release
credentials or external network. The helper refuses a namespace with any
interface other than loopback or an unrelated qdisc. It checks 24 combinations
of RTT 0/80/160/300 ms, jitter 0/30 ms and loss 0/1/5%, then complete TCP
blackholes of 1/5/15 seconds, reconnect and the same real unpack receipt/item.
The public test key is the only key mounted in the candidate; the disposable
private test key reaches the helper on stdin. Container cleanup is scoped to
the current CI run. A denied netem capability fails the job; it is not skipped.

`scripts/realtime-network.mjs --mode loopback` is a local functional preflight
of the two-client protocol, ordinary crate approach, actual unpack, application
ACK-loss retry and reconnection. It explicitly reports `netemExecuted:false`
and `matrixComplete:false`. An earlier local preflight passed. Real netem has
also executed in CI, with the partial result recorded below; the complete
matrix has not passed.

### Recorded CI evidence

For commit `b7ab9ed4265b819299d082e21a6a3957ba1d07de`, the
[release-image workflow](https://github.com/decorum-guy/iva-games/actions/runs/46169113385)
passed all three image jobs. The
[realtime job](https://github.com/decorum-guy/iva-games/actions/runs/46169113385/job/141053233365)
built image `sha256:fa9b971cc71483db2a80dac7c33abbd784c6ed543d49cdf59b95cda60e9dcd5f`
and passed both initial and restored-container checks using real Rapier, two
WebSockets, movement, a durable action receipt and retained static assets. The
[platform](https://github.com/decorum-guy/iva-games/actions/runs/46169113385/job/141053233543)
and [chess](https://github.com/decorum-guy/iva-games/actions/runs/46169113385/job/141053233603)
image checks passed as well. Publish and deploy were skipped; these are image
checks, not a public release or host bootstrap.

The same commit's
[TCP impairment job](https://github.com/decorum-guy/iva-games/actions/runs/46169113462/job/141053233494)
completed 14 of 24 profiles, with real qdisc drops, no unexpected client errors,
the same physical item, and the same committed action receipt after restoration.
It failed while waiting for a controlling connection in the next nominal
160 ms RTT / 0 ms jitter / 5% loss profile. The 1/5/15-second blackhole cases
were not reached. The failed client's terminal scope was not recorded, so the
original run does not establish the precise admission failure cause.

Source review found that the test could reconnect before the previous TCP close
arrived, receive correct observer admission, and then wait without issuing
`claimControl`. The next harness explicitly requests that same-player transfer,
records its attempts and terminal client state, and coalesces ACKs like the
production client. Those changes are **not accepted by the failed run**; they
require another real CI matrix. Product observer admission is unchanged.

`npx vitest run --project realtime --project platform --project session-kit` exercises actual HTTP/WebSocket connections, one-use and tamper-proof tickets, membership/Origin/CSRF, duplicate starts/actions, competing controllers, stale input, bot takeover, pause/expiry, checkpoint rollback, SQLite journal recovery, receipt survival across recovery epochs, disk-write refusal, view deltas and the existing platform/session contracts.

Most runtime tests use a clearly labelled small game fixture to isolate protocol behavior. They include a deliberately delayed durable commit over actual WebSockets, multiple queued continuous inputs, overload pause/recovery without losing control, repeated drain/cancellation, oversized frames, durable admission ordering, corrupt replay isolation, and HTTP access to retained client bytes. `tests/browser-connection.test.ts` uses the actual game connection over a real gateway: queued full-frame bursts, more than 64 queued deltas, epoch/control changes and replaced sockets. It does not run a renderer. `tests/tyaga.test.ts` additionally walks an actual Rapier participant to the crate through ordinary input, unpacks one repair charge, verifies one physical item and one mass decrease across action retries, and checks bot takeover, human return and SQLite recovery of the same receipt. These do not count as rendered browser missions, a load-capacity measurement or public deployment acceptance. Tyaga's maps, rendered controls, long-duration load and installed-host integration require their own recorded checks. Deployment still must preserve the installed host release protocol and confirm its actual published revision.

The network tests also race one signed ticket from two separate Node processes,
and pause a real TCP reader until the bounded output queue closes that socket
while a second observer continues receiving. Neither test represents random
TCP packet loss, jitter or the required impairment matrix.
