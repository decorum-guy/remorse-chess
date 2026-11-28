# Bounded checkout storage diagnostic

Run separately from browser, network and load acceptance. This diagnostic writes only a new private `.qa/storage-*` directory inside its own checkout. It does not select another disk, use tmpfs, change SQLite FULL, modify production code or create an online match.

## CI command

Dependencies: Node 24 and the repository's normal `npm ci` dependencies. On Linux, `strace` enables the optional syscall comparison; `util-linux` supplies `findmnt` and `lsblk`. Missing tools or denied ptrace are reported explicitly. The runner does not request privilege or attach to another process.

```sh
node --test apps/realtime-server/tests/storage-diagnostic.test.mjs
timeout --signal=TERM --kill-after=5s 190s \
  node apps/realtime-server/scripts/storage-diagnostic.mjs --trace=auto
```

The outer timeout is the end-to-end CI process boundary. The runner's internal default deadline is 180 seconds; it terminates only its own child process group and allows 1500 ms before SIGKILL. Filesystem metadata and cleanup awaits are not themselves abortable, so the internal deadline is not an absolute end-to-end bound. Its build is a separate bounded Vite process under `.qa`, with a 45-second maximum and the same global deadline. `dist-realtime` and client builds are not touched. No full application build is required first.

Optional packages can be installed in the CI job with its ordinary package setup (`strace`, `util-linux`). This changes no production host permissions. Use `--trace=required` only when a missing trace should fail the diagnostic; `--trace=auto` records unavailability and can still complete the baseline. A missing or failed baseline is always a failure.

## What runs

1. Capture the complete existing source trace, actual git revision/dirty state, kernel/CPU metadata and statfs/mount metadata. If `IVA_BUILD_SHA` is supplied, it must equal the checked-out revision.
2. Capture read-only filesystem comparisons for checkout, the diagnostic directory, `RUNNER_TEMP` if set and the OS temporary directory. All measurements still write to the original checkout directory. RAM-backed checkout storage is rejected.
3. Build the diagnostic and existing checkpoint worker, hash every compiled file and reverify the source inventory. The SQLite phase additionally hashes the native addon actually loaded by `RealtimeStore`, covering both prebuilt and locally compiled dependencies; the traced phase must load identical bytes.
4. Run 8 warmup plus 64 measured 16 KiB file appends and actual `fsync` calls, paced toward 30 calls/second. Record write, sync, wall and thread-CPU durations separately.
5. Run the existing `RealtimeStore.commitBatch` and production PASSIVE checkpoint worker against an actual fresh SQLite WAL database: 30 warmup plus 300 measured legal core steps, paced toward 30 Hz. FULL=2, WAL and disabled writer autocheckpoint are asserted. The fixture is FP01 1×1 preparation, one inactive human seat and one explicit normal bot, seed 5149. It is representative diagnostic input, not a replay of a particular user's room.
6. If own-child ptrace works, repeat the identical SQLite case in a fresh database under `strace -ff -ttt -T`, selecting only `fsync`, `fdatasync` and `fcntl`. No write buffers, SQL text, environment, keys or existing process are traced.
7. Verify the final actual stored state and journal sequence, reverify unchanged source bytes, save reports and clean up only the newly created raw directory.

The common fixture helper preserves the earlier writer comparison's defaults: FP01 3×3, seed 5149, 750 ordinary initial steps and a temporary bot on the human seat. Its older recorded results remain attached to their earlier source/executable hashes.

## Interpretation

The JSON summary reports p50/p95/p99/max/mean and counts above 50 ms. It does not turn this diagnostic into a capacity profile or change the 50 ms acceptance target. `writer.finalizeP99Ms` retains its production definition (transaction elapsed minus body), so it is explicitly **not** a direct fsync measurement. Syscall timings provide a separate observation. Thread CPU helps distinguish executed CPU work from wall time but does not identify the reason for every wait.

Trace aggregates distinguish the writer's Linux main thread from other child threads. Whole-trace figures include setup and shutdown. An additional timestamp-filtered window covers measured commits, with one-millisecond boundary precision. Overlapping threads mean summed syscall wall durations are not total elapsed runtime. Traced and untraced cases run sequentially on the same mount, but tracer overhead and order effects remain; no claim of an uncontaminated performance comparison is made.

Before/after snapshots include available CPU/I/O/memory pressure and cgroup counters. Missing allocation/device information stays unknown. Overlay filesystems may not resolve to a block device through the visible mount namespace; the diagnostic does not invent that underlying device. Filesystem source/options are filtered for stdout; raw metadata remains private.

## Bounds, files and failure

Defaults: 300 SQLite samples, 30 warmup, 64 file samples, 180-second global deadline and a 32 MiB raw-data guard. CLI ranges are bounded: SQLite samples 30–540, warmup 0–30, file samples 8–128, deadline 30–240 seconds. Larger ad hoc workloads are rejected. The byte guard polls every 250 ms and is checked again before completion; an in-flight write can briefly exceed the sampled guard.

The unique directory is mode 0700 with umask 0077. `source.json`, private `report.json` and sanitized `summary.json` remain there. The private report contains raw host metadata and, on failure, a bounded error detail and at most four 16 KiB child-log tails. Publish **only stdout or summary.json**, never report.json or a wildcard directory artifact. By default the diagnostic removes only its own `raw/` subtree, including fixture databases/WAL, sync file, compiler output, per-sample records, trace and child logs. `--keep-raw` preserves that bounded private evidence for inspection; nothing uploads it. Remove that exact newly reported directory when the evidence is no longer needed. No generic cleanup glob or removal of another run is used.

Only the sanitized summary is printed. A failed command is recorded by a stable error code; captured child output stays private. Unsupported ptrace, missing strace, timeout, byte-limit failure, changed source identity and failed state verification are distinct outcomes. A completed diagnostic says only that this specified measurement ran; it is not browser, power-loss, production storage, image or deployment acceptance.
