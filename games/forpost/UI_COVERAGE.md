# Forpost interactive inventory

This is the implementation inventory and acceptance checklist. It is derived from the current source. **No row has complete acceptance across its applicable states.** The automated CI observations below cover specific subcases; they are separate from the executor's browser passage, which has not occurred. `N/H/P/S/D/W/OK/E` denotes normal, hover, pressed, selected, disabled with reason, waiting, success, and error. Touch has no hover requirement. Each applicable state requires observation in the actual candidate build.

| ID | Element / action | Applicable states | Required original-scenario check |
|---|---|---|---|
| M01 | Language RU/EN | N/H/P/S/OK | Menu, game, modal and error copy switch; saved reload |
| M02 | Three map choices | N/H/P/S/OK | Preview, name and server-selected map agree |
| M03 | Team size 1/2/3 | N/H/P/S/OK | Equal 2N seats, explicit bot labels |
| M04 | Bot level | N/H/P/S/OK | All three profiles; no extra HP/damage/economy |
| M05 | Callsign | N/S/D/OK/E | Empty fallback, maximum length, escaped text |
| M06 | Weapon and tool | N/H/P/S/OK | All nine pairings; actual starting equipment |
| M07 | Start practice | N/H/P/D/W/OK/E | Double click, full server, no network, retry |
| M08 | Resume | N/H/P/D/W/OK/E | Valid/expired match, reload, no active match |
| M09 | Online link | N/H/P/OK/E | Portal sign-in, room creation, return to game |
| M10 | Tutorial entry | N/H/P/OK | Seven selectable lessons; no regular save mutation |
| M11 | Settings entry | N/H/P/OK | Focus trap, Escape, focus restoration |
| L01 | Create room / room settings | N/H/P/D/W/OK/E | 2/4/6 seats, all maps and server-random map |
| L02 | Per-seat team | N/H/P/S/D/W/OK/E | Own unready human / host bot; unbalanced start refused |
| L03 | Per-seat weapon/tool | N/H/P/S/D/W/OK/E | Ownership, ready lock, start preserves selected loadout |
| L04 | Per-bot level | N/H/P/S/D/W/OK/E | Individual profiles; human level mutation rejected |
| L05 | Add/remove bot | N/H/P/D/W/OK/E | Full room, explicit labels, readiness reset |
| L06 | Ready/unready/start | N/H/P/S/D/W/OK/E | Complete equal teams, reserved seat, stale revision |
| L07 | Open/return to operation | N/H/P/W/OK/E | Signed account admission; no guest/account confusion |
| F01 | Keyboard movement | N/P/D/OK | WASD/arrows, diagonal normalization, release, text focus |
| F02 | Mouse aim/fire | N/P/D/OK | Hold vs tap, all weapons, release outside canvas |
| F03 | Reload / ammo button | N/H/P/D/W/OK/E | Partial/empty/full magazine, death, switching weapon |
| F04 | Tool button / Space | N/H/P/D/W/OK/E | Barrier placement, smoke clipping, held repair/release |
| F05 | Mode switch / Tab | N/H/P/S/D/W/OK/E | Fighter→tactics→fighter; autopilot stops immediately |
| F06 | Own unit bar / 1–4 | N/H/P/S/D/OK | Fighter/builder/two drones, dead unit disappearance |
| F07 | Unit/building/transport selection | N/H/P/S/D/OK | Own, ally, enemy, hidden enemy, stale building memory |
| F08 | Shift selection / drag rectangle | N/P/S/OK | Own units only, additive selection, empty rectangle |
| F09 | Tactical pan / wheel / pinch | N/P/OK | Full map, clamped edges, no accidental order |
| F10 | Minimap / whole map / zoom ± | N/H/P/OK | Correct coordinates with letterboxing and side swap |
| F11 | Move/guard/attack/capture/escort/return/stop | N/H/P/S/D/W/OK/E | Legal own-unit command and hidden/stale target refusal |
| F12 | Context order / right click | N/P/D/W/OK/E | Enemy attack vs move; browser context menu suppressed |
| F13 | Route north/south | N/H/P/S/D/W/OK/E | Current transport unaffected, cooldown, shared author |
| F14 | Team pings | N/H/P/D/W/OK/E | Only teammates receive; point validity and limits |
| F15 | Respawn base/field post | N/H/P/S/D/W/OK/E | Dead fighter, unpowered/suppressed/destroyed post fallback |
| B01 | Choose pad / B / pad selector | N/H/P/S/D/OK | Own side, occupied and reserved pads, bridge pad |
| B02 | Eight module options | N/H/P/D/OK/E | Price/power/time, exact shortage/limit/network reason |
| B03 | Build preview/confirm/cancel | N/H/P/S/D/W/OK/E | Footprint, legal/illegal color, failed command stays open |
| B04 | Queue item cancel | N/H/P/D/W/OK/E | Before/after work, full/partial reserve, credit cap |
| B05 | Queue up/down | N/H/P/D/W/OK/E | Active order fixed; future orders reordered |
| B06 | Builder stop/resume | N/H/P/S/D/W/OK/E | Physical work pauses without losing reservation |
| B07 | Power priority up/down | N/H/P/S/D/W/OK/E | Consumer order, shortage, generator restoration |
| B08 | Drone production/cancel | N/H/P/D/W/OK/E | Powered/unpowered queue, two-drone limit, refund |
| B09 | Battery manual aim/auto | N/H/P/S/D/W/OK/E | Own battery, turn speed, allowed target types |
| B10 | Sell/confirm/cancel sale | N/H/P/D/W/OK/E | Damage quiet window, 2s sale, queued dock refunds, cap |
| H01 | Menu/help/settings | N/H/P/OK | Gameplay input neutral while modal open |
| H02 | Modal close/Escape/outside click | N/H/P/OK | No click-through shot; focus restored; Tab trapped |
| H03 | Renderer 3D/2D | N/H/P/S/W/OK/E | Preserves match/input, WebGL loss, model failure |
| H04 | Detail high/low | N/H/P/S/W/OK | Low models load; no stale geometry or material leaks |
| H05 | Text scale 100/115/130% | N/H/P/S/OK | 390×600 and landscape; no clipped actions |
| H06 | Master/effect/UI volume and mute | N/P/S/OK | Independent gain, user gesture unlock, no resumed old shots |
| H07 | Reduced motion / aim assist | N/H/P/S/OK | Persistent, visible targets only, no hidden aim assistance |
| H08 | On-screen controls switch | N/H/P/S/OK | Sticks/fire/tool/reload fit and remain operable |
| T01 | Movement stick | N/P/D/OK | Multitouch, cancel, orientation, lost capture |
| T02 | Aim stick and fire threshold | N/P/D/OK | Below/above35%, last aim, release of every pointer |
| T03 | Separate fire / reload / tool | N/P/D/W/OK/E | Simultaneous movement, focus loss, interrupted repair |
| S01 | Connection/reconnect/pause status | N/W/OK/E | Controls neutral; stale screen identified; recovery state |
| S02 | View-only / take-control | N/H/P/D/W/OK/E | Two tabs/devices, increasing generation, old controller silent |
| S03 | Health/ammo/power/credits | N/D/W/OK/E | Own data, visible reasons, no opponent private stats |
| S04 | Error/success toast/dismiss | N/H/P/W/OK/E | Localized actionable text; no hidden target data |
| U01 | Lesson selection/skip/restart/resume | N/H/P/S/W/OK/E | All seven isolated fixtures and saved stage |
| U02 | Lesson markers/current objective | N/S/W/OK | One actual predicate at a time; stage changes only on success |
| U03 | Next lesson/start practice | N/H/P/D/W/OK/E | Final operation result does not cover lesson action |
| R01 | Operation result/next operation | N/W/OK | Reason, deliveries, side swap and timer |
| R02 | Final score/statistics | N/OK | Correct win/draw, final-only private combat totals |
| R03 | Replay/back to room/main menu | N/H/P/D/W/OK/E | No duplicated result, new match ID, preserved account room |

Global cases: keyboard-only navigation; touch emulation and physical device separately labelled; focus loss, tab backgrounding, pointercancel/lost capture, screen rotation; 390×600 and landscape; every modal at130%; browser console/network errors; retry with changed world state; server and client build identities. Disabled controls must expose a nearby reason where it is not already explicit in the visible state.

## Observed automated subcases, CI round 2

Evidence: [job 141027294468](https://github.com/decorum-guy/iva-games/actions/runs/46160751975/job/141027294468), checkout/build `f957ca52d7e3899f9075a7a4197d6b18e3fcb27f`, PR head `0120205d3b4ac8399ab394a0eafe896d7e03eb67`. Overall result **2 passed / 4 failed**. The table reports the assertions actually reached; it does not accept every visual state of these controls.

| Inventory rows | Actually observed | Still unaccepted within those rows |
|---|---|---|
| M01, H05, H07 | RU→EN selection, 130% text and reduced-motion settings survived reload; English heading appeared | Full gameplay/error translation, visible reduced-motion effects, focus and hover/pressed treatment |
| M02, M09 | Public-style catalogue card opened the real built client; its build attribute matched health; FP01/FP02/FP03 each became the selected map | Complete match on each map and every state of navigation |
| L01, L05–L07 | Isolated account created each map's two-seat room, added a bot, readied, started and opened its pinned client | Four/six seats, random map, per-seat edits, retry/error/ownership cases |
| B01–B03, U01 | Lesson 4 opened; tactics/building panel and pad selects worked; relay/extractor orders were accepted | Actual construction lesson completion failed in this round; cancel/refund/queue outcomes remain unaccepted |
| H01, H03, H05, T01, T03 | At 390×600 the movement stick was visible; visible Game menu opened Settings; 130% text and 2D were selected without page-width overflow; at 844×390 Fire and Continue controls were visible | Touch movement/fire/tool actions, multitouch, actual rendered pixels/FPS and physical phone |
| R01 | FP03 reached two operation results and a 1:1 score before a transition click race failed | Third operation, full match result, replay and return |

Round 1's select-locator and mobile-menu failures were replayed successfully where listed above. FP01/FP02 paused before battle and the construction lesson advanced only about two simulation seconds during its timeout; those failures require further diagnosis. The corrected operation-transition scenario and the new interaction suite are prepared for a later build and are not counted here as passed.

## Observed automated subcases, CI round 3

Build `d0e1833c75685ce51612b58bac3db2e555cdf1f5`, PR head `5cc963b84aa8401e24621e595beca9ed16f9e0ae`. Chromium: 13 PASS / 4 FAIL across 17 scenarios; WebKit: 9 PASS / 1 FAIL across 10. [Exact evidence](qa/ci-round-3.json) preserves failures/timings. No inventory row is accepted across every applicable state.

| Rows | Additional actually observed subcases | Limits |
|---|---|---|
| M02–M06 | Map keyboard/hover selection, all team sizes/bot levels/nine loadout choices, empty/bounded/escaped callsign | Menu choices; not all lobby sizes or complete loadout matches |
| M11, H01–H02, H05–H08 | Focus trap/restoration, Escape, persistence, both checkbox states, independent sliders, RU→EN, text scale, neutral input during modal | Actual listening and all gameplay/error translations unverified |
| F01–F04, U01–U03 | Movement, aim, shots, reload, wall detour/barrier; six lessons completed in 2D | Default-3D construction failed; 2D infrastructure case checked refund rather than completion |
| B01–B04, B07–B08, B10 | Disabled reasons, preview cancel, queued refund, power priority, sale confirm/cancel, generator, drone production/refund/escort | All eight modules and every queue/limit/error/visual state remain unaccepted |
| F05–F06, F11 | Fighter/tactics switches, own drone selection, escort, real delivery/unloading exercise | Full online match and every order/selection mode remain unaccepted |
| T01–T03, H05 | Native Chromium-emulated two-finger movement/aim, fire threshold, touchCancel, released input stability, reload, landscape Fire/menu | No physical phone; combinations/orientations not exhausted |
| F02, S01 | Chromium tab-switch fire stayed stopped; map pauses showed saved state | WebKit case failed without a recorded focus-loss precondition. All online maps failed with SERVER_BUSY |

Prepared additions — infrastructure rebuild/completion, explicit focus-loss precondition and separate 2D full-map passages — do not change these observations. A 2D pass is not 3D performance acceptance.

## Observed automated subcases, CI round 4

Actual build `51748ae944081b5a33a08a630b42b31310b09546`, head `19042c8…`; [exact completed evidence](qa/ci-round-4.json). Chromium 12 PASS/10 FAIL (22 executions), WebKit 8 PASS/2 FAIL (10). No inventory row is accepted across every applicable state; no full UI match or executor-operated passage occurred.

| Rows | Newly observed/replayed behavior | Boundary |
|---|---|---|
| B01–B04, B07, U01–U02 | Original default-3D construction/queue/power/save-resume passed in 37.4s; 2D infrastructure cancel/refund/rebuild reached its completed predicate | Original tutorial-clock defect replayed successfully, but not a 3D FPS acceptance |
| H06 | All 29 shipped WAVs natively decoded; fresh order/carbine voice, mute stopping voice, consumed muted shot and no old shot after saved-lesson reload | Audio not listened to; device/sound privacy matrix remains open |
| M01–M06, M11, H01–H02, H05–H08 | Catalogue/map/settings cases passed again | Full-game translations, every visual state and all online compositions remain open |
| T01–T03 | Native browser-emulated simultaneous touch actions, cancellation/release and landscape controls passed | No physical phone |
| F01/U01 | Restart produced a new Worker while the scenario had already pressed movement; first objective failed in both browsers | Candidate waits actual new connected/enabled UI and focuses its visible Restart; replay pending |
| U03/M07–M08 | WebKit final lesson → separate live practice passed; Chromium created practice but test lost its response body during pinned navigation | Candidate captures real response before unchanged delivery and cleans up only own room; replay pending |
| F02/S01 | Explicit real focus-loss precondition failed in both drivers | Candidate public Chromium CDP removes forced focus; WebKit limitation remains. No simulated blur or accepted focus PASS |
| L01/L05–L07, R01–R03 | All three maps, 2D/3D, reached their real pinned-client room; each received SERVER_BUSY | Six failures, no complete match/result/replay acceptance |

The following lifecycle case received actual 503/ROOM_LIMIT after the uncleaned practice fixture. Its navigation behavior is not accepted or called a demonstrated product defect. Test cleanup/readiness fixes and numeric renderer phase diagnostics are prepared for the next build, not counted as executed UI successes.
