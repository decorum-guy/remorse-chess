# Forpost art and renderer acceptance record

This record is based on the actual generated repository assets, parsed GLB files, renderer source and executed command output. It contains no inferred browser screenshots, device performance or listening result. Full game acceptance is tracked by the root implementation separately.

## Executed technical checks

- `python3 games/forpost/art/validate_assets.py`: 52 GLBs; 367 primitives; no negative closed mesh volume; 29 PCM16 sound files; three licensed font files with complete Russian/Latin checks.
- `node --experimental-strip-types games/forpost/art/validate_model_states.mjs`: 12 checks of independent materials, team colors and triangle/hex insignia, neutral public models, memory restoration, suppression reset, construction/hit reset, reduced motion, low-profile aiming socket and actual wall dimensions.
- `node games/forpost/art/validate_renderer_geometry.mjs`: 11 Node geometry/raycast checks on all three maps, proving real water holes, exact land area and permanent-wall visibility truncation. No browser was instantiated.
- `node --experimental-strip-types games/forpost/art/validate_mixer.mjs`: 10 mock-WebAudio routing/control checks for coarse pan, gain, voice limits, priority, hidden-tab suppression and disposal. This is not playback or listening.
- `npx tsc --noEmit -p games/forpost/tsconfig.json`: passed after renderer integration.
- ESLint passed for `scene.ts`, `canvas-stage.ts`, `art/models.ts` and `art/audio.ts`.
- Earlier Blender contact sheet and Inkscape cover preview were rendered and visually inspected. They verify authored art in those renderers, not the browser integration.
- Browser gameplay acceptance rounds by this agent: **0**. Actual listening sessions by this agent: **0**. Measured device FPS by this agent: **none**.

## Source integration findings and corrections

| Finding | Correction | Verification obtained |
|---|---|---|
| Low-profile GLBs were not selected by the stage. | Model cache keys include profile; profile change rebuilds the map/entities with the matching assets. | Source review, typecheck; low model retains authoritative turret pivot/socket in executed model check. |
| Side L/R colors could incorrectly imply A/B after the operation swap. | Both renderers resolve side through the current team-side mapping. | Source review and typecheck; browser swap still pending. |
| An enemy participant loadout is intentionally absent from the safe roster. | The visible fighter uses the allowed `UnitView.weapon` field. | Source and contract review. |
| Power, damage, team insignia and memory appearance were not connected to model state. | Per-entity cloned materials, power/damage state, mutually exclusive shape insignia and inactive grey memories are applied from the filtered view. | Executed state checks including restoration from memory. |
| Suppression tint could remain red after suppression ended. | Store/reset the normal signal emissive value on each animation call. | Executed suppression/reset scenario. |
| A lowered water surface was hidden by the continuous opaque ground mesh. | Ground is triangulated with real water holes; water surface is −0.15 m; service seams stop at water. | Source/geometry review and typecheck; final browser image pending. |
| Private enemy transport fields became optional. | No enemy unload/escort state is invented; unload animation/bar require a present field. | Typecheck against the new `TransportView`; source review. |
| Full overlay construction was called on pointer updates. | Reuse aim geometry, fingerprint selection/build/network overlays; fog/hazards update only on snapshots. | Source review; measured runtime effect pending. |
| Upper geometry could obscure a fighter/transport. | Camera silhouette overlap fades upper meshes to 35%, with a separate authoritative collision rectangle. | Source review; camera occlusion screenshots pending. |
| Permanent walls have hp −1, so an hp>0-only renderer filter omitted their visible geometry. | Both renderers and fog contours use indestructible-or-positive-HP filtering. | Executed permanent-wall contour regression; actual browser scene pending. |
| Team seat is already numbered 1–3. | Display direct seat inside the triangle/hex; show explicit BOT/AUTO indicator without recoloring the team. | Source and type checks. |
| Own prediction was not connected to presentation. | Both renderers accept the same validated callback only for the local fighter, smooth correction, and discard old generation poses. | Source and type checks; network browser exercise pending. |
| Hidden-source stereo pan was rotated 90 degrees. | Map server atan2(Z,X) sectors with cosine, making east right and west left. | Executed mock graph east/west/north routing checks. |
| Hidden tab could keep playing newly received audio events. | Visibility handler clears voices; play refuses new events while hidden. | Executed hidden-tab mock graph check. |
| Historic shot effects could replay when a view was resumed. | Sequence cursor resets on first view/reconnect, and effects expire by presentation time rather than a frozen tick. | Source review; network interruption exercise pending. |

## Browser scenarios to execute on the final served build

Record the actual build identifier and loaded `assets/forpost/manifest.json` content hash with each gameplay round. These are outstanding scenarios, not accepted results.

| Scene / action | Required visible observation |
|---|---|
| FP01, FP02, FP03 in tactics and fighter view | Correct geometry and water edges; FP02 channels visible; bridges fit the exact pad; ground numbers readable; no placeholder cubes or missing assets. |
| A and B, then operation side swap | Cyan triangle stays A; amber hex stays B; bases, paths, units and inspector refer to the same team. |
| All three weapons, builder, drone, transport; all eight buildings | Distinct silhouette, forward direction, correct scale and no self-intersecting team signs. Capture standard and low profile. |
| Build, pause by leaving work radius, resume, finish; drone queue | Visible progress and builder movement reflect actual progress; stopped work does not continue the working animation. |
| Power loss, restored power, damage, suppression, repaired HP | Signal and material states change and restore; suppressed red does not remain after the condition ends. |
| Wall / roof between camera and a visible fighter or radar transport | Upper geometry fades to 35%; base/collision outline stays visible; selection and aim remain usable. |
| Enemy building leaves sight, changes/dies unseen, is seen again | Memory remains grey with stale age and frozen HP; no private queue/progress is invented; actual sight replaces/removes the memory. |
| Hidden enemy shoots or is damaged | No hidden muzzle, endpoint spark or source position; only authorized segments and coarse sound metadata are consumed. |
| Unload begins, is interrupted, then succeeds | Own transport progress reflects the server; no enemy private unload bar from an absent field. |
| Tutorial focus / selected unit / hover / denied build preview | Focus markers are distinct yellow dashed circles/crosses; preview color follows allowed/denied state; selection does not freeze or rebuild the complete field on pointer motion. |
| WebGL loss or 2D selection, then return | Same permitted geometry, team state, memory, public radar, targeting and build controls in plan view. |
| Reconnect / focus loss / resize / orientation change | No historical burst of flashes; no retained pointer-fire input; all labels and terrain return; no leaked WebGL canvases or texture resources. |
| Busy 3v3 scene, high/low, small viewport | Measure actual frame time/draw calls and compare visual readability; static model accounting is not a device FPS result. |
| Audio checks through actual playback | Listen to each weapon, reload, tool, order/error, building, transport and outcome cue; verify volume, priority, mute, coarse hidden-source pan and replay prevention. Waveform analysis alone does not accept timbre. |
