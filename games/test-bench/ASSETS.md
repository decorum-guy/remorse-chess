# Test Bench artwork and sound

## Production source

All meshes, texture pixels, icons, cover artwork and audio samples in this game
are original procedural work. The repeatable source is
`assets-source/generate-models.mjs` and `assets-source/generate-media.py`.
The generators are source assets, not placeholders. The renderer loads their
individual final GLB exports, preserves the steering and wheel nodes, and batches
the static environment by material. Procedural track geometry follows the shared
`tracks.ts` collision profile, with the exported ramp/rib surfaces fitted to it.

Generate from the repository root:

```sh
node games/test-bench/scripts/generate-assets.mjs
node games/test-bench/scripts/verify-assets.mjs
```

`assets-manifest.json` lists every final file, its SHA-256, bytes, author,
licence, source path, URL where applicable, and changes. The same manifest is
served at `/test-bench/assets-manifest.json`. It includes exact model dimensions,
triangle counts, draw counts before environment batching, named attachment
points, audio duration and sample format. These counts are file measurements;
they are not measured FPS or a physical-device acceptance claim.

## Visual construction

- Open chassis with ivory folded rails, serial plate, recessed sockets and
  graphite undertray. Its original amber preview uses a separate enamel material;
  six online seats have six distinct paints. Seven connectors use metres, Y up
  and +Z forward.
- Three axle families have different real radii, tread, hubs and articulated
  steering/spin nodes. Motor fins, terminals, battery charge strips, independent
  ballast and axle-specific dampers remain recognizable at workshop distance.
- The spring cradle is raised on visible coils. Three cups align with the
  authoritative cargo sockets. The active clamp opens when charge reaches zero.
- Egg capsule, measuring block and power cell each have whole, damaged and
  broken exports. Cracks and broken silhouettes supplement colour.
- Gates, light, dock, unload pad, concrete ribs, ramp and water share the same
  warm enamel atlas. Ten workshop prop families furnish the perimeter.
- Original SVG cover depicts the same open carrier, three egg capsules and
  physical suspension above the ribs. Labels remain ordinary localized HTML.
- The 2D renderer shares track data, phase, car pose, cargo, gates and input with
  the 3D renderer. WebGL loss switches rendering without changing the match.

## Candidate and licence review — 28 November 2026

The [Kenney Prototype Kit](https://kenney.nl/assets/prototype-kit) and
[Racing Kit](https://kenney.nl/assets/racing-kit) both advertise CC0 licensing.
They were evaluated as possible blockout/prop sources. Their generic vehicle
silhouettes do not supply this game's seven visible sockets, spring cradle,
per-axle articulation and small workshop scale. No files from either kit were
incorporated; the delivered geometry comes from the checked-in generator.

[ambientCG's licence page](https://docs.ambientcg.com/license/) and
[Poly Haven's licence page](https://polyhaven.com/license) permit asset use and
redistribution under CC0. No downloaded material, HDRI or preview is included.
A 128×128 original enamel atlas keeps the surfaces consistent and the transferred
payload small. Material roughness separates painted metal, bare metal and rubber.

The source and generated original assets carry the accompanying MIT permission
in `assets-source/LICENSE.txt`. The source declares this project grant explicitly;
it does not pretend to be a third-party licence.

Golos Text and Roboto Condensed come from the pinned `@fontsource` npm packages.
The local Latin and Cyrillic WOFF2 files are unmodified. Their SIL OFL 1.1 notices
are included in `public/test-bench/fonts/`, with the authoritative family pages
recorded in the manifest:
[Golos Text](https://fontsource.org/fonts/golos-text/about) and
[Roboto Condensed](https://fontsource.org/fonts/roboto-condensed/about).
The matching source WOFF cmaps were checked for Russian, English, `ё`, `Ё`, `№`
and digits; all required characters were present. Font rendering still requires
the browser acceptance recorded in the main game journal.

## Audio

`generate-media.py` synthesizes all samples mathematically without recordings or
borrowed waveforms: three motor loops, concrete/wet/rib tyre beds, attach/cancel,
three impact weights, cargo crack, loading/unloading, start/finish, reset, gate,
depletion, quiet workshop bed and a short original music loop. Files are mono
22,050 Hz PCM16. Music has a separate gain; motor pitch responds to actual speed
and throttle. Discrete effects use committed event IDs. The first/recovered
snapshot is primed silently by `BenchAudio.syncEvents`, and hidden tabs mute loops.

The asset verifier checks WAV headers, silence and clipping. That is a signal
check, not actual listening. No auditory acceptance or physical phone result is
claimed by this document. Actual browser, listening and device observations belong
in the acceptance journal with the tested SHA.

## Integration

The portal serves `public/test-bench/` as `/test-bench/` with its normal production
build. Fonts are available through `/test-bench/fonts.css`. The thin React Three
Fiber 9.8.2 adapter uses `createRoot` and `useFrame`: R3F schedules and renders
the original Three.js scene graph. A fresh canvas per root isolates replacement
and context-loss lifecycles. The authoritative
physics/runtime never imports the renderer or Web Audio.

`Scene.tsx` exports `TestBenchScene` and `TrackDiagram`; `Audio.ts` exports
`BenchAudio`. Low quality disables dynamic shadows and reduces pixel ratio.
The live canvas exposes renderer draw calls and rolling frame p95 for the actual
browser run; the acceptance journal must identify the browser and viewport when
using these values.

The cosmetic `effects` setting controls impact dust and wet tyre spray, both
derived from current physical events/position. Low quality and reduced motion
disable the particle mesh. Wheel rotation, actual spring compression, chassis
tilt, cargo positions and clamp opening stay visible in every quality setting.
The race presentation mirrors X at the scene root so that +X is screen-right
for both the rear 2.5D camera and the 2D plan. This is a render transform only;
the server's coordinates, gates, steering and shared track map are unchanged.

`seatIndex` maps the portal's six seats to six distinct chassis colours in both
renderers. `participantId` provides a deterministic fallback for standalone
previews; omitted identity uses the amber default. Each live vehicle clones only
its dedicated `test-bench-chassis-paint` material. Shared asset-cache materials,
the rails, tyres, mass markers and cargo colours stay independent of that tint.

`BenchAudio.resetEvents(runIdentity)` starts a fresh effect-ID history for a new
practice run or match, while reconnecting to the same run keeps its history.
