# Capacity evidence and the next one-room measurement

Status: preparation only. No one-room calibration, one-hour run, or retained
heavy-scene run described below has executed. The current browser candidate
must remain unchanged until its acceptance closes. The next measurements use
one subsequently frozen runtime/client artifact and no concurrent browser or
physics test workload.

This review uses the recorded [five calibrations](load-calibrations.json), the
runtime and harness source, and read-only resource inspection. It is not a VPS
measurement. The requirements remain [REALTIME_PLATFORM §13 and §16](../../../docs/game-design/REALTIME_PLATFORM.md):
step p99 strictly below half the fixed step interval, commit p99 at most 50 ms,
30% compute headroom, 25% memory headroom, no overflowing queues, one hour at the
declared capacity, and a repeat with simultaneous heavy work.

## What the existing measurements establish

Every recorded run used two rooms and twelve independent human protocol
clients, with ten seconds of warmup. None passed the complete local gate.

| Run | Measured seconds | Step p99 upper bound, ms | Commit p99 upper bound, ms | Peak server RSS, MiB | Maximum worker ELU | Maximum gateway ELU | Overload observed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 01 | 30.059 | 4 | 40 | 910.965 | 78.063% | 89.957% | Yes |
| 02 | 30.057 | 5 | 50 | 555.789 | 61.500% | 73.048% | No |
| 03 | 30.011 | 10 | 50 | 595.664 | 73.509% | 55.183% | Yes |
| 04 | 60.026 | 15 | 75 | 606.414 | 79.762% | 64.684% | Yes |
| 05 | 60.085 | 10 | 40 | 595.000 | 70.354% | 57.826% | No |

Artifacts/content changed across the series. Run 04 overlapped other physical
tests. Run 05 used an agreed pause in those tests, which does not establish
exclusive machine allocation. Its physics rate was approximately 59.97 steps
per second per room; the step-p99/headroom failure still applies. Stored step
histograms already have boundaries at 7, 8, 8.333333333333334, 9 and 10 ms.
The reported 10 ms bucket means **(9, 10] ms**; it cannot be relabelled as a
passing value below 8.333 ms.

The fifth run's sampled snapshot rate was about 17.73 Hz per connection over
the final 55 seconds. The gateway uses an independent 50 ms timer; it has no
`now + 50` deadline that quantizes snapshot publication to the physics pump.
It skips a connection while its previous snapshot request remains pending.
Recorded request durations include worker queue wait, projection/delta work,
serialization and delivery to the gateway; recent p99 values were about
77–214 ms, with a lifetime maximum of 318.472 ms. Twelve requests were pending
in seven of twelve samples. This supports queue/work pressure as an explanation;
it does not identify a deterministic pacing defect or a particular CPU hot
function. No pacing or histogram change follows from these data.

## Resource reference and limits of the local gate

`cpuHeadroom30Percent` in the five historical reports is an **event-loop
utilization** check: the maximum measured five-second activity fraction of
either gateway or simulation worker must be at most 70%. ELU is not a physical
CPU allocation or a measurement of spare host CPU. The next harness names this
check `eventLoopHeadroom30Percent` and separately records process CPU
microseconds and `cpuCoreEquivalents`, including the runtime's threads.
Load-generator memory/CPU is separate and also recorded.

The recorded machine reported nine available logical CPUs and 10,451,427,328
bytes of RAM. A later read-only inspection still allowed affinity to CPUs 0–8,
but exposed no `cpu.max`, `cpu.stat`, `memory.max` or `memory.high` files at the
visible cgroup root. A guaranteed CPU quota and a dedicated memory allocation
are therefore **unknown**. The examples below use `--memory-mib 1024`, the same
explicit 1 GiB reference as the previous probes. Its RSS threshold is 768 MiB;
the option does not impose a container limit or claim that 1 GiB was allocated.

The next probe declares **two logical CPUs for the runtime**, with
`--server-cpus 0,1`. The harness launches only its own child through `taskset`,
verifies its actual process/thread masks at startup and every sample, and
requires the load generator to use disjoint CPUs. Its separate
`processCpuHeadroom30Percent` check uses:

`runtime process CPU microsecond delta / (wall-second delta × 1e6 × 2) < 0.70`.

Without an explicit verified CPU budget that check does not pass. The commands
pin the generator to CPUs 2–8; all masks and CPU samples are recorded. An actual
small Node child and worker have confirmed inherited affinity in a focused
test; the Rapier workload on that budget is still unmeasured.

A passing local report can establish consumption relative to this explicit
two-CPU affinity budget and the recorded memory reference. It does not reserve
those CPUs from other host work, impose a cgroup quota, or establish production
capacity. Record the actual hosting allocation and measure there before making
that deployment claim. The chosen CPUs must be rechecked if the executor's
available mask changes.

## Prepared maximum scenes

[heavy-seed.ts](heavy-seed.ts) is QA-only source; the product does not import it.
It arranges bodies once in a **new isolated** database and saves through the
normal engine. The unchanged compiled worker restores that world. During
measurement only authenticated WebSocket inputs/actions operate the machinery;
there are no pose writes, victory flags or periodic fixture resets.

| Scene | Rooms / controllers | Normal loaded assembly | Simultaneous cable work | Explicit stress-only additions |
| --- | --- | --- | --- | --- |
| `ferry` | 1 / 6 humans | Actual Quarry truck, equipment and three cargoes plus six 80 kg crew: 3059 kg payload, 3779 kg including the 720 kg ferry; capacity 3500 kg payload | Two physical mooring cables, 24 contact segments each; ordinary propulsion/steering against the restraints | Two fixed winch supports at (39; −2; 54) and (79; −2; 70), which are absent from ordinary map stock |
| `lift` | 1 / 6 humans | Actual Ridge truck, equipment and three cargoes plus six crew: 3417 kg payload, 3937 kg including the 520 kg platform/barriers; capacity 3800 kg payload | Two 18 m hanging cables, 24 contact segments each, while ordinary lift controls alternate full upward/downward travel | Two fixed overhead winches and two extra ordinary 24 kg beams outside the loaded platform |
| `paired` | 2 / 12 humans | Both scenes together | Both sets together | All additions above; this is not a one-room run |

Two normal winch sources permit two cables, each at most 18 m, using contact
segments no longer than 0.75 m: at most **48 contact segments**, plus two drum
collars and two terminal hooks. `rope64` denotes additional Rapier solver
iterations, not a cable/segment budget. The ferry fixture uses actual
`ring-rear`/`ring-front` sockets. It verifies endpoint distances before creating
links and records the resulting lengths; its two 24-segment cables need not
both be exactly 18 m. Its extra fixed supports are not presented as a legal
inventory arrangement. Original inventory and normal assembly masses are
asserted unchanged. Every physical body/collider/joint count is recorded.
The far mooring drum faces the deck; the overhead drums face downward. The
fixture must also satisfy the candidate's new source-body cable-path check
after the game owner freezes that change; no older reader is substituted.

The fixture's stability and the ordinary `operate` action have **not** been
accepted by a run. Each probe fails if the loaded truck/crate/cargo/crew leave
the machinery, a cable detaches/breaks, the 48-segment workload disappears,
the operator is inactive, rescue/failure occurs, or a capacity is exceeded.
The report also requires observed full payload, nonzero cable tension, and
actual movement after warmup: ferry displacement over 0.1 m or lift travel over
5.5 m. This prevents an hour of an idle/broken scene from passing. Initial
settling is excluded from these movement/tension checks. A failed fixture must
be repaired and recalibrated; it cannot be counted as a passed heavy repeat.

## Commands after the new candidate is frozen

Run these sequentially from the repository root, after the active renderers
and other physics tests have exited. The root agent must first identify the
new runtime/client artifact. Do not run them against the old R04 output merely
because its files exist. Keep that candidate unchanged for the entire series;
`configuration.json` records worker/client manifests and entry hashes.

Start with two short probes, each with ten additional seconds of warmup:

```bash
taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 60 --rooms 1 --profile humans --scene normal --map ridge --memory-mib 1024 --output .qa/realtime-load/r05-n1-humans-60
taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 60 --rooms 1 --profile bots --scene normal --map ridge --memory-mib 1024 --output .qa/realtime-load/r05-n1-bots-60
```

`humans` means six authenticated independent controllers; `bots` means one
human and five real game bots. Neither is a rendered-browser test. If either
short probe fails, stop before the hour and investigate the measured failure.
Do not lower physics frequency, disable bots, relax thresholds, or accept two
rooms from these one-room results. Other normal maps can be selected explicitly
with `--map valley` or `--map quarry` when checking which scene is limiting.

Run the one-hour probe using the profile selected from the measured short
results. The following is the six-human command; use `--profile bots` and a
new output directory if bots are the limiting profile. If neither dominates,
record separate hour runs instead of claiming an unmeasured combined bound.

```bash
taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 3600 --rooms 1 --profile humans --scene normal --map ridge --memory-mib 1024 --output .qa/realtime-load/r05-n1-humans-hour
```

Compile the separate fixture preparation module from the **same frozen game
source**. It writes only its private QA directory, not `dist-realtime` or a
browser build. The runner rejects a prepared-world manifest that differs from
the actual worker's game/rules/content/physics/runtime artifact.

```bash
npx vite build --config scripts/vite.realtime-heavy.config.ts
taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 60 --rooms 1 --profile humans --scene ferry --memory-mib 1024 --output .qa/realtime-load/r05-n1-ferry-60
taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 60 --rooms 1 --profile humans --scene lift --memory-mib 1024 --output .qa/realtime-load/r05-n1-lift-60
```

Only a stable, correctly loaded short scene proceeds to its hour repeat. Both
different mechanisms remain in scope; one room cannot contain both maps.

```bash
taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 3600 --rooms 1 --profile humans --scene ferry --memory-mib 1024 --output .qa/realtime-load/r05-n1-ferry-hour
taskset -c 2-8 node scripts/realtime-load.mjs --server-cpus 0,1 --seconds 3600 --rooms 1 --profile humans --scene lift --memory-mib 1024 --output .qa/realtime-load/r05-n1-lift-hour
```

Every output directory must be new; the harness refuses to overwrite saved
evidence or reuse a database. Each command creates only its own port, keys,
SQLite, archives and child runtime. To stop a run, send Ctrl-C to its own
terminal/session (allocate a PTY when using the executor). The harness handles
SIGINT/SIGTERM, records an incomplete result, closes its own sockets, requests
durable shutdown of its own child, and uses SIGKILL only if that child exceeds
the 32-second drain deadline. Do not kill PIDs discovered in another executor
namespace or use a broad process-name kill.

Inspect `report.json`, `configuration.json`, `measurements.jsonl`,
`runtime.log`, and for heavy scenes `data/heavy-fixture.json`. Five-second
samples retain step/commit/serialization histograms, snapshot age, snapshot
request duration, full/delta/resync counts, input and socket queues, lag/ELU,
server and load-generator CPU/RSS, and SQLite growth. Check the complete-hour
flag, all independent gates and a clean durable shutdown. A process exit of
zero after a 60-second probe is not an hour, and a passed build is not a
capacity measurement or a public release.
