# Local WebKit environment check — 28 November 2026

**A real Linux headless WebKit launched and closed successfully.** This is an
environment check, not a Tyaga acceptance round, a completed mission, Apple
Safari/iOS verification, or a physical-device test.

Evidence comes from the actual downloaded browser, a local HTTP page, Playwright
actions and WebGL pixel readback. The successful launch log records
2026-11-28T18:08:56Z. No product runtime, built game files, existing QA database,
Git index or system package installation was changed for this check.

## Actual result

| Item | Observed value |
| --- | --- |
| Host | Debian GNU/Linux 13 (trixie), x86_64 |
| Playwright | 1.65.1 |
| Downloaded browser artifact | `webkit-2388`, Debian-13 build |
| `browser.version()` | `27.2` |
| Backend | WPE headless |
| Local HTTP page / title | Loaded with HTTP 200; title matched |
| Ordinary button click | Counter changed from 0 to 1 |
| WebGL 1 and WebGL 2 | Contexts created; clear/readPixels each returned `[51,102,153,255]`; `getError()` returned 0 |
| Page errors | None recorded |
| Screenshot | Captured and visually inspected |
| Browser shutdown | Graceful process exit 0, no signal; browser disconnected |

The browser's default User-Agent contains Macintosh/Safari strings. WebGL
reports `WebKit WebGL`, vendor `WebKit`, and the debug-renderer extension returns
`Apple GPU` / `Apple Inc.`. **These are reported browser strings, not evidence of
Apple hardware or Safari running on macOS.** `navigator.platform` was
`Linux x86_64`. No physical GPU model is established by this probe.

## Isolated dependencies and provenance

The initial ordinary `apt-get download` could not find packages because
`/var/lib/apt/lists` was absent; it also reported an unreadable global retries
configuration. A separate APT configuration, index, cache and log were created
under this checkout's `.qa/tyaga/webkit-libs`. Sources were copied from the
existing `/etc/apt/sources.list.d/caas-snapshot.list`:
`https://snapshot.debian.org/archive/debian/20261123T173250Z/` and its configured
security snapshot. Normal signature and package-hash checks remained enabled.
No global `apt install`, configuration edit, privilege escalation or alternate
network route was used.

Only the requested libraries and two discovered dependencies were downloaded
as `.deb` files and extracted with `dpkg-deb -x` into the private `root` directory:

| Package | Actual version |
| --- | --- |
| libgtk-4-1 | 4.18.6+ds-2 |
| libgraphene-1.0-0 | 1.10.8-5 |
| libharfbuzz-icu0 | 10.2.0-1+deb13u1 |
| libmanette-0.2-0 | 0.2.12-1 |
| libhyphen0 | 2.8.8-7+b2 |
| libgles2 | 1.7.0-1+b2 |
| libhidapi-hidraw0 | 0.14.0-1+b2 |
| libcairo-script-interpreter2 | 1.18.4-1+b1 |

The actual WPE dependency chain has no unresolved libraries. The unused headed
GTK variant still reports `liblzo2.so.2` missing; headed GTK was not launched or
accepted. No extra installation was performed for that unused backend.

## Launch configuration

The downloaded `minibrowser-wpe/MiniBrowser` wrapper replaces `LD_LIBRARY_PATH`,
so setting that environment variable outside it is insufficient. The separate
owned wrapper preserves the downloaded browser binaries, sets their ordinary
`WEBKIT_EXEC_PATH`, injected-bundle and inspector-resource paths, and adds the
private extracted library directory before executing the actual WPE binary.

Paths relative to this repository root:

- Browser directory: `.qa/tyaga/webkit-runtime`.
- Private executable wrapper: `.qa/tyaga/webkit-libs/pw-run-local.sh`.
- Additional library directory: `.qa/tyaga/webkit-libs/root/usr/lib/x86_64-linux-gnu`.
- Reproducer: `.qa/tyaga/webkit-libs/capability.mjs`.
- Results: `.qa/tyaga/webkit-libs/capability.json`, `capability.log`, `capability.png`.
- Package versions/SHA-256 hashes, wrapper/binary hashes and limitations:
  `.qa/tyaga/webkit-libs/manifest.json`.
- Signed-index/download logs and WPE/GTK linker reports remain in that same
  private directory. They contain no user account credentials.

The browser workbench's opt-in configuration is `TYAGA_BROWSER=webkit`,
`PLAYWRIGHT_BROWSERS_PATH` pointing to the browser directory, and
`TYAGA_WEBKIT_EXECUTABLE` pointing to the private wrapper. The wrapper supplies
the required library path; the default Chromium configuration remains separate.
Run the workbench only after its game candidate is frozen and identified.

The first probe invocation stopped before browser launch because its metadata
read used an incorrect relative path to Playwright's package.json. The path was
corrected; that log is retained as `capability-attempt01-harness-path.log`.
The subsequent actual browser invocation produced the results above.

Game rendering/performance, keyboard/touch flows, native audio, persistence and
all mission paths remain to be checked in the actual frozen candidate. The
32×32-pixel capability check does not close any of those gates.
