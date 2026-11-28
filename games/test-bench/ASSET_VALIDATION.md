# Asset and scene validation record

This record concerns asset generation and source review in the isolated
`feat/test-bench` working tree based on
`357f60049e83b298bb5bbc2f760654fbd02384e3`. It is not a passed game acceptance
cycle. The acceptance journal must record the final committed and tested SHA.

## Executed checks

| Check | Observed result |
| --- | --- |
| Original generator execution | 43 GLBs generated from the checked-in Three.js source. |
| Manifest/file validation | 97 final files, 43 GLBs, 21 WAVs; exact bytes and SHA-256 match. All source/licence fields present. |
| GLB structural validation | GLB v2 lengths, nonempty accessors, atlas paths, chassis sockets and axle spin nodes checked. |
| Repeatable generation | A complete second generation changed none of the 97 recorded file hashes. |
| Audio signal inspection | WAV headers valid, mono PCM16, no fully silent file or clipped PCM sample. No listening was performed. |
| TypeScript / ESLint | Targeted strict checks passed for Scene, Audio and asset scripts. Root integration checks are recorded separately. |
| Font source coverage | Matching WOFF source cmaps contain Russian/English, `ё`, `Ё`, `№` and digits. WOFF2 browser rendering remains a browser check. |
| Cover visual inspection | Original `cover.svg` rasterized with Sharp and inspected as a 960×600 image. This is cover-art inspection, not a rendered game observation. |

## Defects found and corrected before browser acceptance

| Finding | Correction | Evidence |
| --- | --- | --- |
| Same-stem model/audio files overwrote manifest byte counts. | IDs now include their directory, and model inventory only augments GLB entries. | `verify-assets.mjs` initially failed on `gate`; the corrected verifier passes every file. |
| Atlas row convention disagreed with glTF texture coordinates. | Generated atlas rows follow glTF's upper-left texture origin. | Source and GLB URI/UV inspection; real colour rendering still needs the browser. |
| Cargo art origin differed from authoritative rigid-body origin. | Exported cargo meshes use the body centre; live pose uses the complete authoritative quaternion. | Shared physics socket/source comparison. |
| Cup spacing and visible mass anchors differed from the physics layout. | Cups moved to X = −0.42, 0, +0.42 m; physics and art use the agreed motor/battery anchors. | Shared catalog/physics/scene coordinates. |
| Ramp triangles faced downward; precision barriers were not visible. | Corrected upward winding; rendered barriers from the same ordered-gate widths. | Mesh/source inspection and successful export. |
| Wheel travel did not change coil geometry. | Exported independent suspension nodes; spring length now follows actual wheel positions. | Articulated nodes and animation source. |
| Exported socket markers retained earlier coordinates, and reverse wheel spin used speed magnitude. | Aligned GLB markers with the Scene/physics anchors and projected velocity onto the actual forward vector for spin direction. | Regenerated GLB/manifest and source transform inspection; browser motion remains a rendered check. |
| The 2D precision course omitted solid side barriers. | Draws the same gate-side extents used by 3D and physics; rib width now follows the shared course profile. | Shared course and renderer source comparison. |
| The initial scene did not use the specified R3F layer or individual chassis paints. | Added a thin R3F 9.8.2 root/frame adapter and a separately cloned primary-enamel material; six seat colours share the same mapping in 3D and 2D. | Installed API/source review, generated material verification and portal TypeScript/lint; real rendered acceptance still required. |
| High axles intersected the workbench in the editor. | Workshop pose raises and pitches the chassis according to selected front/rear radii. | Geometry dimensions and pose calculation; still awaits rendered inspection. |
| Rear 3D camera would reverse screen horizontal controls relative to 2D. | Race-only presentation X reflection, with readable text plates; physics and input coordinates unchanged. | Camera-basis and transform inspection; steering playtest still required. |
| Builder sends radians while scene initially expected quarter turns. | Scene rotation contract now uses radians. | Caller/callee source comparison. |
| Practice run IDs can reuse event IDs. | Added `BenchAudio.resetEvents(runIdentity)`; reconnect keeps the same identity. | Audio dedupe source; root wires run/match lifecycle. |

## Browser attempt and present limit

An isolated automated production visual fixture was written at
`scripts/visual-qa.mjs`. It serves the actual portal build on its own local port,
creates an isolated Playwright context and is intended to record real pages.
It does not mock account APIs or mutate a live portal.

The local attempt stopped **before a page opened**: the sandbox's
`/usr/bin/chromium` wrapper pointed through `/usr/lib/chromium` to an unavailable
`/opt/codex/browsers/chromium/chromium`. No scene screenshot, driving observation,
FPS result, WebGL rendering result or completed browser cycle is claimed here.
The parent separately reported an automatic approval rejection for expanded
execution; this asset task did not bypass it or retry through that route.

The visual fixture defaults to Playwright's installed Chromium, for environments
where that browser is available through the normal test runner. An explicit
`IVA_CHROMIUM_PATH` is optional. The fixture output must be read before any of its
scenarios are described as passed.

`scripts/browser-acceptance.mjs` is a separate real production client/server
fixture for CI. It creates isolated verified accounts, mailbox, databases and
browser contexts; uses normal UI and keyboard/touch inputs; and observes only
received browser WebSocket snapshots and the visible local HUD. Its authored
scope includes a two-human/two-bot cup, tutorial, constraints, settings,
reconnection/restart and rematch startup. Node syntax, lint and the pure helper
bundle were checked locally. The runner has not yet completed in a browser in
this asset record. Its exact JSON result must determine passed/failed coverage;
authored scenarios are not execution evidence.

`IVA_BROWSER_LATENCY_MS=60` optionally routes the complete production HTTP and
WebSocket connection through an owned loopback TCP relay with 60 ms transit delay
in each direction. The runner records actual browser health-request round trips
and exact input-sequence acknowledgement latency. These are application-path
measurements in an artificial local-delay fixture, not public-internet latency.
The default run has no relay. Neither variant is described as passed until its
real browser execution produces a successful report.

## Required rendered checks still open

The local attempt and authored-runner descriptions above are historical. Later
production Chromium CI evidence is recorded, with exact candidate identities, in
[ACCEPTANCE.md](ACCEPTANCE.md). Candidate 7 loaded the real assets, completed
practice and tutorial scopes, rendered both presentation modes and exercised
WebGL loss. Its direct normal cup failed on Precision for Alice in 3D; this is
not a passed visual, human, audio or hardware acceptance cycle.

That direct job observed 57 draw calls on Precision at CSS 1440×818, with a
216.7 ms frame p95. The scene metric records intervals between frame callbacks
in a window of up to 240 frames, not isolated CPU/GPU render time. Canvas2D's
reported zero means this metric was absent, not that its frames cost no time.
The online 2D protocol diagnostic prepared for candidate 8 does not close the
3D failure or target-device performance requirement.

A subsequent read-only source/GLB audit found no WebGL renderer recreation on
each snapshot. Low already disables AA, shadows and particles and caps DPR at
1.25; at the default CI DPR of 1 it still renders at the full CSS resolution,
with standard materials and scene lighting.
The offroad axle GLB contains 8,868 triangles across 10 primitive instances
(node.mesh → mesh.primitives; triangle count from index accessor count / 3).
Two installed offroad axles therefore contain 17,736 triangles and 20 such
instances. This is static geometry accounting, not measured draw calls or proof
of the performance bottleneck. Resolution limits, low LOD and spatial batching
remain hypotheses requiring a controlled rendered comparison; no optimization
or measured speedup is claimed from that inspection.

1. In a real production browser, confirm the atlas colours, every selected part,
   full/empty cups, wheel travel, coil movement, chassis tilt and cargo damage.
2. Compare the same obstacle with two different assemblies and confirm their
   visual feedback agrees with actual physics. Inspect a fallen and recovered load.
3. Verify D/right and A/left visually in both 3D and 2D, including reverse,
   ordinary/mirrored tracks and a full precision course.
4. Confirm all gate barriers, slopes, ribs, wet/smooth edges and unload bounds
   agree with collision/scoring; inspect all three track scenes.
5. Inspect workshop rotation by 90°, top view and slot picking in both renderers.
6. Force WebGL loss during a running trial, continue in Canvas2D and restore 3D
   without losing the session or phase.
7. Inspect 1366×768, 1920×1080 and 844×390, RU/EN, 130% text, keyboard focus,
   touch controls, low quality and reduced motion. Physical hardware is separate.
8. Measure actual transferred bytes and draw calls on low quality, plus frame p95
   on the identified devices. Source/file sizes are not a substitute for these.
9. Actually listen to engine, rolling, damage, cargo and finish together. Check
   music/SFX gains and event replay after reconnect and practice restart.

The two full product acceptance cycles, deployment and external HTTPS checks are
outside the checks completed in this asset record and remain owned by the root
executor's acceptance journal.
