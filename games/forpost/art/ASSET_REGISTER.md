# FORPOST — asset register

## Delivered files and source

This register is based on the actual files produced for this implementation and the normative `DESIGN.md`, `ART_AND_MAPS.md` and `ART_PRODUCTION_STANDARD.md`. It does not infer a public release or completed game acceptance from the presence of assets.

The package contains **26 model families in two quality profiles (52 GLBs), 29 original PCM16 WAVs, 50 own SVG icons, 8 effect graphics, a vector cover projected from the actual model meshes, three exact-map previews, and three locally served font files**. Every runtime file and SHA-256 is in `public/assets/forpost/manifest.json`. Current content digest: `e8ac30932c18e1e82215b4c174222e82120ea73b374597daef3ca55cbd4c98ed`.

Original sources:

- `scripts/generate-assets.py` — Blender 4.3.2 mesh creation, chamfered shapes, mechanical assemblies, material definitions, export, contact-sheet render. Both quality profiles are generated together.
- `scripts/generate-assets-audio.py` — deterministic original synthesis, filtering, envelopes and finished PCM16 export. No borrowed recordings or sounds from other Iva Games products.
- `scripts/generate-assets-vectors.py` — coherent line icons, exact route/map previews, effect vectors, and a cover projected directly from the authored GLB triangles.
- `src/art/models.ts` — per-instance team/damage/power/ghost/selection states and mechanically named animations, driven by actual entity state and confirmed event timing.
- `src/art/audio.ts` — user-gesture unlock, local samples, master/effects/interface gain, priority, maximum 12 combat + 2 UI voices and clearing old playback on reconnect.
- `art/validate_assets.py` — independent checks of GLB byte structure, finite geometry, normals, closed-mesh winding, PCM format/duration/clipping and actual Cyrillic/Latin glyph coverage.

`art/licenses/ORIGINAL-ASSETS.txt` records the original production source. Font licenses are retained verbatim under both `art/licenses` and runtime `assets/forpost/licenses`.

## Candidate search and decisions

The following primary author pages were actually read during production. Their CC0 declarations apply to their own files. **No Kenney model is included in this delivery.** Attempts to obtain their archives through the download link endpoint returned HTTP 403; those binary files were therefore not obtained or inspected and have no claimed local hash. This led to original modeling, not a substitution of an unlicensed preview.

| Candidate / primary source | Intended families | Observed availability / choice |
|---|---|---|
| [Kenney Blaster Kit](https://kenney.nl/assets/blaster-kit) and [author's distribution page](https://kenney-assets.itch.io/blaster-kit) | Three firearms, target, small field equipment | Source page lists CC0; archive unavailable to this request. Original distinct carbine, wide shotgun and long rifle made to fit the 0.32 m operator and fixed game camera. |
| [Kenney Space Kit](https://kenney.nl/assets/space-kit) | Vehicles, energy machinery and industrial props | Primary page accessible; archive link returned 403. Original grounded six-wheel transport, construction trolley, four-wheel combat drone and mechanism silhouettes created. |
| [Kenney Tower Defense Kit](https://kenney.nl/assets/tower-defense-kit) | Turret/platform, ground, structures | Primary page lists CC0 and the current medieval/castle set. Archive unavailable; no mesh inspection claimed. Original industrial structures match the mandated footprint and moving parts. |
| [Kenney support / license statement](https://kenney.nl/support) | General license interpretation of candidates | Source confirms pack-license files are the relevant supplied terms. No optional donation or purchase was made. |

Fonts were actually downloaded from the Google Fonts repository, opened with FontTools and checked against full uppercase/lowercase Russian and Latin alphabets, Ё/ё and digits. Runtime files are unmodified TTFs, with native variable weight for Roboto Condensed. The optional WOFF2 conversion was unavailable because the local Brotli Python extension is absent; TTF delivery is complete and does not require a web font service.

| File | Primary source | License / changes |
|---|---|---|
| RobotoCondensed.ttf | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/robotocondensed) | SIL OFL 1.1, original bytes; copyright The Roboto Project Authors. |
| PTSans-Regular.ttf | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/ptsans) | SIL OFL 1.1, original bytes; copyright ParaType, reserved font names preserved. |
| PTSans-Bold.ttf | Same PT Sans source | SIL OFL 1.1, original bytes; no renaming or glyph modification. |

## Model catalogue

All GLBs use metres, Y up, forward −Z, grounded origins and embedded PBR materials. Collision metadata documents the rules; decorative mesh does not create server collision. Wall models use a **1×1 m nominal XZ footprint** and are scaled to each authoritative wall rectangle; the destructible wall warning plate projects 1.5 mm beyond that visual footprint and creates no collision. Bridge is **4×4 m in XZ**, so FP01 uses Z scale 0.75; its supports/railings are decorative. Foundations are 1.8×1.8 m. Station and complex are flat passable floor geometry.

The table records standard / low triangle and mesh-node counts. Mesh-node counts are an accounting upper bound before hidden insignia, renderer batching and shadows. Runtime animations are supplied by `src/art/models.ts`; they are not embedded skeletal clips. Their driving state is always provided by the game, never inferred to produce rule outcomes.

| assetId / GLB basename | Triangles std / low | Mesh nodes std / low | Collider / placement | Presentation states |
|---|---:|---:|---|---|
| `fighter-carbine` | 1424 / 504 | 21 / 11 | `{"shape":"circleXZ","radius":0.32}` | walk, fire, reload, death |
| `fighter-shotgun` | 1424 / 504 | 22 / 11 | `{"shape":"circleXZ","radius":0.32}` | walk, fire, reload, death |
| `fighter-rifle` | 1468 / 548 | 22 / 12 | `{"shape":"circleXZ","radius":0.32}` | walk, fire, reload, death |
| `builder` | 808 / 392 | 18 / 4 | `{"shape":"circleXZ","radius":0.28}` | drive, work, destroy |
| `drone` | 756 / 372 | 19 / 5 | `{"shape":"circleXZ","radius":0.3}` | drive, aim, fire, destroy |
| `transport` | 1524 / 636 | 28 / 5 | `{"shape":"capsuleXZ","radius":0.8,"segmentLength":1.2}` | drive, unload, destroy |
| `relay` | 808 / 360 | 9 / 5 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | powered, destroy |
| `generator` | 1440 / 560 | 17 / 5 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | work, powered, destroy |
| `extractor` | 808 / 260 | 11 / 7 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | work, powered, destroy |
| `turret` | 720 / 272 | 12 / 7 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | aim, fire, powered, destroy |
| `dock` | 792 / 264 | 9 / 5 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | work, powered, destroy |
| `battery` | 924 / 300 | 11 / 7 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | aim, fire, powered, destroy |
| `respawn` | 824 / 264 | 8 / 5 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | powered, suppressed, destroy |
| `bridge` | 692 / 276 | 4 / 1 | `{"shape":"rectangleXZ","width":4,"depth":4,"walkable":true}` | construct, destroy |
| `foundation` | 316 / 108 | 6 / 4 | `{"shape":"rectangleXZ","width":1.8,"depth":1.8}` | construct, destroy |
| `wall` | 312 / 88 | 4 / 1 | `{"shape":"rectangleXZ","width":1,"depth":1}` | static |
| `wall-destructible` | 400 / 112 | 4 / 1 | `{"shape":"rectangleXZ","width":1,"depth":1}` | destroy |
| `station` | 732 / 268 | 5 / 2 | `none (floor/decor)` | capture |
| `complex` | 696 / 280 | 5 / 2 | `none (floor/decor)` | unload |
| `ground-concrete` | 92 / 60 | 2 / 1 | `none (floor/decor)` | static |
| `ground-sand` | 460 / 60 | 3 / 1 | `none (floor/decor)` | static |
| `ground-industrial` | 116 / 84 | 3 / 1 | `none (floor/decor)` | static |
| `water` | 68 / 36 | 2 / 1 | `{"shape":"mapDefined"}` | static |
| `target` | 316 / 156 | 4 / 1 | `{"shape":"circleXZ","radius":0.32}` | hit |
| `depot` | 312 / 120 | 6 / 2 | `none (floor/decor)` | static |
| `crane` | 512 / 192 | 4 / 1 | `none (floor/decor)` | static |

Each model family has a `models/<id>.glb` and `models/<id>-low.glb`. Low models preserve silhouettes, team signs, signals, real aim and working assemblies. They combine neutral materials with vertex colors and freeze ornamental wheel/fan spin to reduce draw calls; they do not change a hitbox, vision or rule. Standard models retain distinct rubber, steel, concrete and armour material response.

Named `socket_*` nodes include muzzles, nameplate positions, network antenna, tool, vehicle energy/unload attachment, field exit and dock exits where applicable. Body nodes are under `asset_<assetId>` to avoid a root/turret naming collision. Named mechanical groups include `weapon`, `leg_left`, `leg_right`, `turret`, `arm`, `piston`, `energy_container`, wheel groups and rotor groups in standard models.

`FP_Team` and `FP_Signal` are cloned per instance before recoloring; A is cyan #47C9E5 with triangle and B is amber #FFB25B with hexagon. `cloneForpostModel`/`applyForpostModelState` select only the matching insignia. Hidden or last-observed entities must be filtered by the server/client integration; these presentation helpers never decide visibility. Team marker geometry is separate from authoritative collision.

## Audio catalogue

All files are mono 44,100 Hz PCM16 WAV. The loudest recorded absolute sample is 0.789978 of full scale; no file clips. This is a technical measurement, **not a listening judgment**. Individual gain and priority are included in the manifest and mixer. Master/effects/UI defaults are 70% / 80% / 60%.

| assetId / WAV basename | Length | Group / priority | Intended character |
|---|---:|---|---|
| `carbine` | 0.26 s | combat / 1 | Dry short mechanical report with restrained low body |
| `shotgun` | 0.64 s | combat / 1 | Wider low report, metallic cycling tail |
| `rifle` | 0.55 s | combat / 1 | Tight crack with resonant steel tail |
| `drone-fire` | 0.22 s | combat / 1 | Small servo gun report |
| `turret-fire` | 0.28 s | combat / 1 | Heavy mounted gun report |
| `battery-fire` | 0.75 s | combat / 1 | Charged metallic rail impulse |
| `empty` | 0.15 s | ui / 1 | Dry magazine click |
| `reload-start` | 0.29 s | combat / 1 | Release catch and magazine movement |
| `reload-end` | 0.23 s | combat / 1 | Magazine lock and short bolt return |
| `barrier` | 0.70 s | combat / 1 | Metal deployment impact and stabilizing field |
| `smoke` | 1.00 s | combat / 1 | Canister release and falling filtered pressure |
| `repair` | 1.00 s | combat / 1 | Pulsed maintenance arc with mechanical hum |
| `order` | 0.22 s | ui / 1 | Brief two-note confirmed order |
| `error` | 0.32 s | ui / 1 | Descending restrained denied action |
| `menu` | 0.13 s | ui / 1 | Soft mechanical switch |
| `build-start` | 0.48 s | combat / 1 | Ground anchor and drive engagement |
| `build-complete` | 0.72 s | combat / 1 | Locking mechanism and rising ready tone |
| `destroy` | 0.90 s | combat / 1 | Low metal collapse with uneven debris |
| `power-lost` | 0.75 s | combat / 1 | Motor winding down |
| `transport-spawn` | 0.95 s | combat / 1 | Diesel-electric start and clearance signal |
| `unload-start` | 0.65 s | combat / 1 | Coupling click and steady charging indication |
| `unload-interrupted` | 0.48 s | combat / 1 | Short interrupted coupling warning |
| `unload-success` | 1.05 s | combat / 3 | Power transfer lock and bright three-step arrival |
| `station-captured` | 0.72 s | combat / 1 | Relay handshake and rising status pair |
| `respawn` | 0.78 s | combat / 1 | Equipment engagement and ready tone |
| `overtime` | 1.25 s | combat / 3 | Three spaced low industrial warning notes |
| `operation-end` | 1.65 s | combat / 3 | Resolved four-note operation cadence |
| `hit` | 0.16 s | combat / 1 | Short armour contact |
| `engine-loop` | 2.00 s | combat / 1 | Seamless electric drivetrain loop |

The mixer accepts only a quantized sector and near/far category for a concealed source. It has no hidden emitter coordinates or continuous position pan. The authoritative event filter must still decide whether any event is allowed. Reconnect/leave/hidden-tab must call `clear()`; historical events are not replayed by this class.

## Technical verification and observed corrections

`python3 games/forpost/art/validate_assets.py` passed on the delivered files: 52 GLBs, 367 mesh primitives, 29 sounds and 3 fonts. The art TypeScript modules and integrated Three/Canvas renderers passed a no-emit type check. `node --experimental-strip-types games/forpost/art/validate_model_states.mjs` passed 12 model state/contract checks. `node games/forpost/art/validate_renderer_geometry.mjs` passed 11 geometry/raycast checks without a browser; `node --experimental-strip-types games/forpost/art/validate_mixer.mjs` passed 10 routing/control checks with a mock WebAudio graph, which is not sound playback. `RENDER_ACCEPTANCE.md` separates these executed technical checks from the outstanding browser and listening scenarios. The cover was rendered with Inkscape and visually inspected; a Blender contact sheet was rendered and inspected under `.qa/forpost-art`. These are art checks, not gameplay/browser acceptance rounds.

| Defect | Observation | Correction and recheck |
|---|---|---|
| ART-01 | Chamfered-prism winding was inverted; the first GLB-derived cover exposed hollow walls despite a two-sided Blender preview. | Reversed authoring face winding; regenerated all models and cover. Independent signed-volume check reports zero negative closed-mesh volumes; cover re-render shows solid walls. |
| ART-02 | Floating-point truncation shortened one audio duration by one sample. | Sample count now rounds the requested exact duration; all 29 WAV lengths revalidated against the manifest. |
| ART-03 | Material-per-part accounting gave too many low-profile draws. | Low profile uses vertex-color batches and freezes ornamental wheels/rotors while retaining aim/work assemblies. New exact mesh/triangle counts are in validation.json; actual frame time remains a game-scene measurement. |
| ART-04 | A model root named `turret` collided with its moving head's name. | Roots use `asset_<id>`; the moving head is consistently `turret`. Re-import inventory checks the named node. |

Maximum-content static accounting for 6 fighters + 6 builders + 12 drones + 2 transports + 30 structures:

- Standard: 53,088 triangles, 884 mesh draws before hidden-part culling/batching.
- Low: 21,120 triangles, 346 mesh draws before hidden-part culling/batching.
- These estimates exclude map terrain, shadows, six simultaneous smoke/barrier effects, UI and renderer implementation. They are not measured FPS or a phone performance claim.

## Reproduction

```sh
blender -b -t 2 --python games/forpost/scripts/generate-assets.py -- --no-render
python3 games/forpost/scripts/generate-assets-audio.py
python3 games/forpost/scripts/generate-assets-vectors.py
python3 games/forpost/art/validate_assets.py
node --experimental-strip-types games/forpost/art/validate_model_states.mjs
node games/forpost/art/validate_renderer_geometry.mjs
node --experimental-strip-types games/forpost/art/validate_mixer.mjs
python3 games/forpost/art/build_register.py
```

Optional full art contact sheet: `blender -b -t 2 --python games/forpost/scripts/generate-assets.py -- --preview-only`. Blender Cycles is configured without OpenImageDenoise because that feature is absent in the available build. Screenshots are intentionally ignored and not committed. Assets are served locally and contain no runtime model/font CDN dependencies.

## Integration acceptance still required

The root implementation must check the full, populated gameplay camera, correct collision scaling, both team marks, weapon range readability, damaged/disabled/selected states, mobile layouts, reduced motion, actual event-to-sound correspondence and measured maximum-scene performance. No physical-phone play, auditory timbre review, public deployment or full game browser acceptance is claimed by this register.
