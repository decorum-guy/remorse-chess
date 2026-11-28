# Bounded production-image profiling

This document describes an executable QA harness, not a completed capacity test.
At this source checkpoint, the script checks below ran locally; Docker and the
hour-long workload did not run in this environment. Earlier failed load attempts
remain failures. A future CI run must be identified by its actual output before
any new result is reported.

## Invocation and boundaries

Build the ordinary `Dockerfile.realtime` with its required retained input. The
release collector and sealed inventory are described in [REALTIME_RETENTION](REALTIME_RETENTION.md).
The load job supplies the same named context, without changing the build's
`NODE_ENV`:

```sh
python3 -B deploy/iva-games/prepare-realtime-image.py
docker build --pull --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --build-context "realtime-retained=$PWD/deploy/iva-games/retained-input/current" \
  --file Dockerfile.realtime --tag "$IMAGE_TAG" .
FORPOST_QA_OUTPUT_DIRECTORY="$RUNNER_TEMP/forpost-load" \
  bash apps/realtime-server/scripts/profile-image.sh --seconds=3600 --rooms=4
```

`IMAGE_TAG` must be exported. Registry authentication, if needed by the collector,
belongs to the existing CI preparation step. The wrapper performs no deployment
or credential changes. It resolves the tag once, then inspects and executes that
immutable local image ID. Image source/revision labels must match a clean checkout
of the exact revision being measured.

The container uses `--cpus=2 --memory=2g --memory-swap=2g`, a read-only root
filesystem, `--network none`, all capabilities dropped, and
`no-new-privileges`. It retains the image's `USER node` (UID 1000). The only
writable locations are a bounded temporary directory, a bounded harness tmpfs,
and a newly created QA output directory under the runner's private temporary
parent. The dedicated output mount has mode 0777 so UID 1000 can create its own
0700 run directory; this does not expose the parent directory or grant access to
host services. No Docker socket, host networking, privileged mode, or writable
source mount is used. HTTP/WebSocket clients and their server communicate over
loopback inside that one network namespace.

The image's Docker healthcheck is disabled for this harness because its fixed
4331 port is not the harness's allocated port. The harness polls the actual
runtime readiness endpoint. Startup, HTTP requests, socket handshakes, and drain
have bounded deadlines. The wrapper removes only its own named container on exit.

## Exact byte identity

The host exports `iva-forpost-source-2`, containing a fixed complete inventory of
the relevant runtime/client/core/art sources, public assets, shared contracts,
QA scripts, package/lock/build files, registry and image preparation inputs.
Each entry has its byte count and independent SHA-256; the aggregate and core
hashes use sorted relative paths followed by exact file bytes. Verification
recomputes the required inventory, so the provided trace cannot omit a new file.
Symlinks and special source files are rejected. Container verification uses
built-in Node modules and does not require git.

Only the QA clients are copied from that read-only source into a tmpfs. The
runtime runs `/app/dist-realtime/main.js`; current client bytes are verified
against `/app/client`. Production startup unconditionally verifies the sealed
`/app/retention` bundle and its readers, including when `NODE_ENV=test`. The
bootstrap records both the exact `bundle.json` file hash and its canonical seal,
build revision, current runtime/client IDs and inventory counts. Readiness must
report the same build/runtime/client identities. A different image, dirty source,
omitted source hash or mismatched seal/current identity cannot produce a passing
diagnostic result.

The QA store is a separately created, initially empty `store/` directory. Traces,
profiles, logs and reports are outside it. This preserves the startup distinction
between explicit first provisioning and a missing existing database/WAL.

## Diagnostic admission assumptions

At runtime only, the harness explicitly selects `NODE_ENV=test` and a profile
with `source: "test-fixture"`. Its values are **synthetic sizing assumptions**:
four slots, 224 bodies, 24 bots, 48 connections, 8 ms assumed step cost and
256 MiB assumed memory per room. Those values are not observations, are not an
accepted capacity profile, and are never exported as a measured production
profile. Production rejects this fixture; the conservative production default
and all resource, backlog, storage and overload guards remain unchanged.

Actual cgroup quotas, memory usage/peaks and runtime resource readings are
recorded separately. If these guards cannot admit four rooms on the capped
runner, that is a measured admission failure. The script does not alter the
profile, retry with fictional hardware values or weaken the guards.

## Workload and result interpretation

Four real 3v3 training rooms use FP01, FP02, FP03 and FP01. Each starts with an
explicit human observer identity and five explicit strong bots; after the
controlling client closes, the human seat's normal temporary bot is observed.
A view-only connection supplies legitimate presence and acknowledges filtered
snapshots. There are no fake account registrations or hidden participant joins.
Finished matches are abandoned by their own guest owner and replaced in the
same load slot. The report retains start/result counts and observed tick advances.

The requested 3600-second monotonic load interval begins only after all four
rooms are admitted and have advanced a tick. It is real elapsed time, not an
accelerated simulation. An unexpected observer closure, stopped snapshot or
tick stream, pause, admission rejection, unhealthy storage or interruption fails
the run. A clean WebSocket close cannot silently reduce the workload.

Health/cgroup samples normally occur every five seconds; a compact progress
message is emitted each minute. CPU utilization uses whole-container counter
deltas over monotonic observation intervals of at least one second. Adjacent
cleanup reads are excluded from this ratio. The denominator is the smaller of
the observed cgroup quota and the runtime's affinity-aware capacity. This is a
sampled utilization measure, not an instantaneous CPU guarantee. Memory reserve
uses latched `memory.peak` across visible limited ancestors, including bootstrap
and the QA clients; missing peak evidence leaves the threshold unverified.

The sanitized summary separately evaluates completion, all slots admitted, no
unexpected pauses/failures, storage errors, sampled queue size plus the cumulative
backpressure counter, step-work p99 below half a 30 Hz tick, commit p99 below
50 ms, at least 30% sampled CPU headroom and 25% peak-memory headroom, observed
resource caps and exact image identity. CPU/RAM headroom is measured independently
of the synthetic admission assumptions. `productionCapacityAccepted` is always
`false`, including when every diagnostic threshold passes. An hour of ordinary
rooms does not replace the separate simultaneous maximum-scene gate or tests on
the production machine.

Only whitelisted hashes, numbers, map names, phases and fixed error codes reach
stdout. Match/result IDs, guest credentials, cookies, raw messages and saved
worlds stay in the isolated raw report directory. CI must not upload the raw
database, report or log tail. No production profile is generated. Browser FPS,
human play, physical-device behavior and public deployment are not measured here.

## Script verification at this checkpoint

Executed locally: 17 Node built-in tests, focused ESLint, Bash syntax and Node
syntax checks. The tests cover complete source rehashing, byte/file/symlink
mismatches, real-format cgroup parsing and unknown metrics, ancestor pressure,
latched memory peaks, effective CPU limits, cleanup sampling, immutable image
identity, partial admission/early termination, cumulative backpressure,
disconnect/stalled progress and stdout redaction. Their numeric inputs are
explicit arithmetic fixtures; passing them is not load evidence.

```sh
node --test apps/realtime-server/tests/profiling-scripts.test.mjs
bash -n apps/realtime-server/scripts/profile-image.sh
```

The actual Docker hour remains pending until the dedicated CI job executes.
