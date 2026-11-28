/** Real-time UI-only Shift acceptance. Reads only renderer ShiftView props; never mutates application state. */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { build } from 'vite';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = new Set(process.argv.length > 2 ? process.argv.slice(2) : ['--all']);
for (const arg of args) if (!['--all', '--ui', '--lessons', '--touch', '--matrix'].includes(arg)) throw new Error(`Unknown acceptance flag: ${arg}`);
const label = process.env.SHIFT_QA_LABEL || 'diagnostic';
const folder = resolve(root, '.qa/shift-local', label);
await mkdir(folder, { recursive: true });
const report = { label, build: {}, method: 'Headless Chromium automation with the normal30Hz scheduled tick, no acceleration; observed rates are recorded separately. Reads only the filtered ShiftView passed to the renderer; every gameplay action uses pointer, keyboard or visible buttons. No application-state writes, timer acceleration or account data changes.', tests: [], defects: [], errors: [], screenshots: [], captureWarnings: [], matches: [] };
const sourceDist = resolve(root, 'apps/portal/dist');
const dist = resolve(folder, 'built');
await rm(dist, { recursive: true, force: true });
await cp(sourceDist, dist, { recursive: true, force: true });
const html = await readFile(resolve(dist, 'index.html'));
async function digestFiles(base, files) {
  const hash = createHash('sha256');
  for (const name of [...new Set(files)].sort()) { try { hash.update(name); hash.update(await readFile(resolve(base, name))); } catch { hash.update('[missing]'); } }
  return hash.digest('hex');
}
async function listFiles(base, prefix = '') { const files = []; for (const entry of await readdir(resolve(base, prefix), { withFileTypes: true })) { const name = prefix + entry.name; if (entry.isDirectory()) files.push(...await listFiles(base, name + '/')); else if (entry.isFile()) files.push(name); } return files; }
const dirty = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim();
const sourceFiles = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
report.build = { testedArtifactCopy: dist, sourceDist, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirtyWorktree: !!dirty, worktreeChanges: dirty.split('\n').filter(Boolean), sourceTreeSha256AtRun: await digestFiles(root, sourceFiles), sourceDigestScope: 'Current working files at run start; diagnostic builds may predate these sources. Built artifact digest identifies tested bytes.', artifactSha256: await digestFiles(dist, await listFiles(dist)), htmlSha256: createHash('sha256').update(html).digest('hex'), htmlEntry: String(html).match(/src="([^"]+\.js)"/)?.[1] };
const helperEntry = resolve(folder, 'helpers.ts');
await writeFile(helperEntry, `export { chooseBotCommands, pilotWaypoint } from '${resolve(root, 'games/shift/src/bots/index.ts')}';\nexport { worldPosition, goalPosition, lineOfSight } from '${resolve(root, 'games/shift/src/core/index.ts')}';`);
await build({ configFile: false, logLevel: 'silent', build: { ssr: helperEntry, outDir: resolve(folder, 'helpers'), emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'helpers.mjs' } } } });
const { chooseBotCommands, pilotWaypoint, worldPosition, goalPosition, lineOfSight } = await import(pathToFileURL(resolve(folder, 'helpers/helpers.mjs')).href);
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'LOCAL_STATIC_ACCEPTANCE' } })); }
    let path = resolve(dist, '.' + pathname);
    if (!path.startsWith(dist + '/')) path = resolve(dist, 'index.html');
    try { if (!(await stat(path)).isFile()) path = resolve(dist, 'index.html'); } catch { path = resolve(dist, 'index.html'); }
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(await readFile(path));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolveListen => server.listen(5299, '127.0.0.1', resolveListen));
const localChromium = resolve(root, '.qa/shift-chromium/chrome-headless-shell-linux64/chrome-headless-shell');
const executablePath = process.env.SHIFT_CHROMIUM_EXECUTABLE || (existsSync(localChromium) ? localChromium : chromium.executablePath());
const browserServer = await chromium.launchServer({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const browser = await chromium.connect(browserServer.wsEndpoint());
report.browser = await browser.version();
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
async function bounded(action, milliseconds) { let timer; try { return await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser teardown timeout')), milliseconds); })]); } finally { clearTimeout(timer); } }
async function closeContext(context) { try { await bounded(() => context.close(), 4000); } catch { console.log(JSON.stringify({ harnessWarning: 'Context teardown exceeded4sec; browser process will be closed at run end.' })); } }
const log = (name, details = {}) => { report.tests.push({ name, ...details }); console.log(JSON.stringify({ test: name, ...details })); };
const defect = (name, details) => { report.defects.push({ name, details }); console.log(JSON.stringify({ defect: name, details })); };
async function snap(page, name) { if (await page.locator('.shift-match').count()) {
  const capture = await page.evaluate(() => { const host = document.querySelector('.shift-scene [data-shift-renderer]'); const canvas = host?.querySelector('canvas'); return { image: host?.getAttribute('data-shift-renderer') === '2d' && canvas ? canvas.toDataURL('image/png') : null, text: document.querySelector('.shift-match')?.innerText || '' }; });
  await writeFile(resolve(folder, `${name}-ui.txt`), capture.text);
  if (capture.image) { const file = resolve(folder, `${name}-canvas.png`); await writeFile(file, Buffer.from(capture.image.split(',')[1], 'base64')); report.screenshots.push(file); }
  console.log(JSON.stringify({ capture: name, method: capture.image ? 'Actual rendered2D canvas export plus separate DOMtext; not a full-page screenshot.' : 'DOM text; see separate renderer3D visual audit.' })); return;
} const file = resolve(folder, `${name}.png`); try { await page.screenshot({ path: file, fullPage: !!(await page.locator('.shift-home').count()), timeout: 15000 }); report.screenshots.push(file); } catch (error) { const warning = { name, message: error.message }; report.captureWarnings.push(warning); console.log(JSON.stringify({ captureWarning: name, message: error.message })); } }
async function view(page, withPresentation = false) {
  return page.evaluate(withPresentation => {
    const host = document.querySelector('.shift-scene [data-shift-renderer]'); if (!host) return null;
    let fiber = host[Object.keys(host).find(key => key.startsWith('__reactFiber$'))];
    while (fiber) {
      if (fiber.memoizedProps?.view?.wireVersion === 'shift-wire@1') {
        const views = [fiber.memoizedProps.view, fiber.alternate?.memoizedProps?.view].filter(v => v?.wireVersion === 'shift-wire@1');
        const permitted = structuredClone(views.sort((a, b) => b.tick - a.tick)[0]);
        if (!withPresentation) return permitted;
        const recap = document.querySelector('.shift-round-recap');
        return { view: permitted, batteryHud: document.querySelector('.shift-pilot-status > span')?.textContent, batteryOrder: document.querySelector('.shift-command-panel .shift-order > p')?.textContent, recap: recap ? { open: recap.open, summaryHeight: recap.querySelector('summary')?.getBoundingClientRect().height, hasMap: !!recap.querySelector('svg[role="img"]'), lines: [...recap.querySelectorAll('.shift-round-recap__path')].map(line => ['x1', 'y1', 'x2', 'y2'].map(key => Number(line.getAttribute(key)))), events: [...recap.querySelectorAll('.shift-round-recap__events li')].map(item => item.textContent) } : null };
      }
      fiber = fiber.return;
    }
    return null;
  }, withPresentation);
}
function checkBatteryPresentation(observed, language) {
  const v = observed.view, actor = v.actors.find(a => a.seatId === v.self.seatId);
  if (v.self.role !== 'pilot' || v.phase === 'finished') return null;
  const ru = language === 'ru', battery = v.battery;
  const team = battery.team === 'teal' ? (ru ? 'Бирюза' : 'Teal') : battery.team === 'amber' ? (ru ? 'Янтарь' : 'Amber') : '—';
  const space = battery.spaceId === 'west' ? (ru ? 'западном шлюзе' : 'west airlock') : battery.spaceId === 'east' ? (ru ? 'восточном шлюзе' : 'east airlock') : battery.spaceId;
  const objective = battery.mode === 'carried' ? `${ru ? 'Батарея у команды' : 'Team carrying'}: ${team}` : `${ru ? 'Батарея в' : 'Battery in'} ${space}`;
  const expectedHud = actor?.carrying ? (ru ? 'Батарея у вас · к своим воротам' : 'You have the battery · reach your gate') : objective;
  const expectedOrder = actor?.carrying ? (ru ? 'Удержитесь на своих воротах до полной зарядки.' : 'Hold on your gate until charging completes.') : objective;
  if ((!actor?.respawnAtTick && observed.batteryHud !== expectedHud) || observed.batteryOrder !== expectedOrder) return { tick: v.tick, permittedBattery: battery, actorCarrying: actor?.carrying, respawnAtTick: actor?.respawnAtTick, expectedHud, actualHud: observed.batteryHud, expectedOrder, actualOrder: observed.batteryOrder };
  return null;
}
function checkRoundPresentation(observed) {
  const { view: v, recap } = observed;
  if (!v.roundRecap || !recap?.hasMap || recap.summaryHeight < 44) return { problem: 'Missing permitted recap, schematic or44px summary', round: v.round, phase: v.phase, recap };
  if (v.phase === 'finished' && !recap.open) return { problem: 'Final battery route is not expanded', round: v.round };
  const trace = v.roundRecap.batteryTrace;
  const near = (a, b) => Math.abs(a - b) < .000001;
  // Every displayed line must connect consecutive permitted observations; a gap cannot supply either endpoint.
  const unexpected = recap.lines.find(line => !trace.some((point, index) => {
    const next = trace[index + 1];
    return !point.gap && next && !next.gap && near(line[0], point.worldX) && near(line[1], point.worldZ) && near(line[2], next.worldX) && near(line[3], next.worldZ);
  }));
  if (unexpected) return { problem: 'Schematic joins unobserved coordinates or a visibility gap', round: v.round, line: unexpected };
  if (recap.events.length > 3) return { problem: 'More than three latest events', round: v.round, events: recap.events };
  return null;
}
async function setupPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, ...options });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push({ url: page.url(), message: error.message }));
  await page.goto('http://127.0.0.1:5299/shift'); await page.locator('.shift-home').waitFor();
  return { context, page };
}
async function settings(page, mode = '2d', language) {
  await page.getByRole('button', { name: /^(Настройки|Settings)$/ }).click();
  await page.getByLabel(/Вид этажа|Floor view/).selectOption(mode);
  if (language) await page.getByLabel(/Язык|Language/).selectOption(language);
  await page.keyboard.press('Escape');
}
async function focusScene(page) { await page.locator('.shift-scene [data-shift-renderer]').focus(); }
async function clickLive(page, locator) { try { const box = await locator.boundingBox({ timeout: 500 }); if (!box || !(await locator.isEnabled({ timeout: 500 }))) return false; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); return true; } catch { return false; } }
async function aimAt(page, point) {
  const box = await page.locator('.shift-scene [data-shift-renderer]').boundingBox();
  if (!box) return;
  const scale = Math.min((box.width - 20) / 33, (box.height - 20) / 25);
  await page.mouse.move(box.x + box.width / 2 + (point.x - 8) * scale, box.y + box.height / 2 + (point.z - 8) * scale);
}
const held = new WeakMap();
async function keysFor(page, moveX = 0, moveZ = 0, fire = false) {
  const desired = new Set();
  if (Math.abs(moveX) > .24) desired.add(moveX > 0 ? 'd' : 'a');
  if (Math.abs(moveZ) > .24) desired.add(moveZ > 0 ? 's' : 'w');
  if (fire) desired.add('Space');
  const old = held.get(page) || new Set();
  for (const key of old) if (!desired.has(key)) await page.keyboard.up(key);
  for (const key of desired) if (!old.has(key)) await page.keyboard.down(key);
  held.set(page, desired);
}
async function stop(page) { await keysFor(page); }
async function lesson(page, role) {
  await settings(page, '2d');
  await page.getByRole('button', { name: role === 'pilot' ? /Урок пилота|Pilot lesson/ : /Урок штурмана|Navigator lesson/ }).click();
  await page.locator('.shift-match').waitFor(); await focusScene(page);
  const seen = new Set(), started = Date.now(); let lastStep = -1, lastActionTick = -1000, rideObserved = false, arrowFocusChecked = false;
  while (Date.now() - started < 120000) {
    const v = await view(page); if (!v) { await sleep(40); continue; }
    const displayed = await page.locator('.shift-lesson').evaluate(node => ({ complete: node.classList.contains('complete'), title: node.querySelector('h2')?.textContent, number: node.querySelector('.shift-lesson-number')?.textContent }));
    if (displayed.complete) { await stop(page); await snap(page, `${role}-lesson-complete`); log(`${role} lesson completed`, { wallSeconds: (Date.now() - started) / 1000, tick: v.tick, steps: [...seen], rideObserved }); return; }
    const title = displayed.title;
    const step = Number(displayed.number.match(/\d+/)?.[0]) - 1;
    seen.add(title);
    if (step !== lastStep) { console.log(JSON.stringify({ lesson: role, step, title, tick: v.tick })); lastStep = step; if (step === 0) { await stop(page); await snap(page, `${role}-lesson-step-${step}`); } }
    if (v.motion && !rideObserved) { rideObserved = true; await snap(page, `${role}-lesson-room-moving`); }
    if (role === 'navigator') {
      await stop(page);
      if (step === 0) {
        if (!arrowFocusChecked) {
          await page.locator('.shift-room-keys').getByRole('button', { name: 'A', exact: true }).click(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
          const until = Date.now() + 2000; let after = await view(page); while ((after.stats[after.self.seatId]?.shifts || 0) === 0 && Date.now() < until) { await sleep(50); after = await view(page); }
          if ((after.stats[after.self.seatId]?.shifts || 0) === 0) { defect('Navigator Enter does not confirm arrow-selected room', 'Focus roomA, pressArrowUp to selectO, thenEnter: no shift accepted.'); await focusScene(page); await page.keyboard.press('ArrowUp'); }
          arrowFocusChecked = true;
        } else await page.keyboard.press('ArrowUp');
      }
      else if (step === 1 && !v.motion && v.tick - lastActionTick > 15) { await focusScene(page); await page.keyboard.press('Enter'); lastActionTick = v.tick; }
      else if (step === 3 && !v.motion) {
        const option = v.shiftOptions.find(o => o.allowed);
        if (option && v.tick - lastActionTick > 15) { await page.locator('.shift-room-keys').getByRole('button', { name: option.roomId, exact: true }).click(); await page.locator('.shift-order').getByRole('button', { name: /Сдвинуть|Shift room/ }).click(); lastActionTick = v.tick; }
      } else if (step === 4) {
        const option = v.shiftOptions.find(o => o.reason === 'NOT_ADJACENT');
        if (option) await page.locator('.shift-room-keys').getByRole('button', { name: option.roomId, exact: true }).click();
      }
    } else {
      const actor = v.actors.find(a => a.seatId === v.self.seatId); if (!actor) throw new Error('Pilot actor missing');
      let target, fire = false;
      if (step === 0) target = { spaceId: 'O', x: -3.4, z: 0 };
      if (step === 1) {
        const enemy = v.actors.find(a => a.team !== actor.team && a.hp > 0);
        if (enemy && lineOfSight(v.settings.arena, v.board, actor, enemy, v.motion, v.tick, 12)) { await aimAt(page, worldPosition(v.board, enemy, v.motion, v.tick)); fire = true; }
        else target = { spaceId: 'O', x: 0, z: 1.3 };
      }
      if (step === 2) {
        target = { spaceId: 'O', x: 0, z: 0 };
        if (lineOfSight(v.settings.arena, v.board, actor, target, v.motion, v.tick, .85) && v.tick - lastActionTick > 4) { await page.keyboard.press('e'); lastActionTick = v.tick; }
      }
      if (step === 4) target = goalPosition(v.goalSpace);
      const point = target ? pilotWaypoint(v, actor, target) : { x: actor.x, z: actor.z };
      const dx = point.x - actor.x, dz = point.z - actor.z, distance = Math.hypot(dx, dz);
      const done = target && target.spaceId === actor.spaceId && Math.hypot(actor.x - target.x, actor.z - target.z) < (step === 4 ? .35 : .09);
      await keysFor(page, distance > .07 && !done ? dx / distance : 0, distance > .07 && !done ? dz / distance : 0, fire);
    }
    await sleep(35);
  }
  await stop(page); await snap(page, `${role}-lesson-timeout`);
  throw new Error(`${role} lesson did not finish: ${JSON.stringify({ title: await page.locator('.shift-lesson h2').textContent(), view: await view(page) })}`);
}
async function uiSweep() {
  const { page, context } = await setupPage();
  try {
    await snap(page, 'home-ru');
    await settings(page, '2d');
    await page.getByRole('button', { name: /Начать практику/ }).click(); await page.locator('.shift-match').waitFor();
    await page.getByRole('button', { name: 'Пауза', exact: true }).click(); const firstExit = await view(page);
    await page.getByRole('button', { name: 'В меню', exact: true }).click(); await page.locator('.shift-home').waitFor();
    await page.getByRole('button', { name: 'Продолжить практику', exact: true }).click(); await page.locator('.shift-match').waitFor();
    const firstResume = await view(page);
    if (firstResume.tick < firstExit.tick || firstResume.round !== firstExit.round) defect('Immediate practice resume lost progress', { firstExitTick: firstExit.tick, firstResumeTick: firstResume.tick });
    log('Practice resume after first immediate exit', { exitTick: firstExit.tick, resumedTick: firstResume.tick, beforePeriodicCheckpoint: firstExit.tick < 60, pageReloaded: false });
    await page.getByRole('button', { name: 'В меню', exact: true }).click(); await page.locator('.shift-home').waitFor();
    await page.getByRole('button', { name: /Как устроен матч/ }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    const trapped = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    if (!trapped) defect('Modal keyboard focus escapes', 'Help dialog after14 Tab presses');
    await page.keyboard.press('Escape');
    const restored = await page.evaluate(() => document.activeElement?.textContent?.includes('Как устроен матч'));
    if (!restored) defect('Help focus does not return to opener', 'Open help, pressEscape');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('button', { name: /How the match works/ }).click(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Floor view').selectOption('2d'); await page.getByLabel('Quality').selectOption('low'); await page.getByLabel('Text size').selectOption('1.3');
    await page.getByLabel('Reduce camera motion').check(); await page.getByLabel('Reduce effects').check();
    for (const label of ['Game sound volume', 'Ambience volume', 'Aim stick sensitivity']) { const slider = page.getByLabel(label, { exact: true }); await slider.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); }
    await page.locator('.shift-bindings button').filter({ hasText: 'Battery' }).click(); await page.keyboard.press('f');
    if (!(await page.locator('.shift-bindings button').filter({ hasText: 'Battery' }).textContent()).includes('F')) defect('Key rebinding failed', 'Battery→F');
    await snap(page, 'settings-en-130');
    await page.getByRole('button', { name: 'Reset settings', exact: true }).click(); await page.getByLabel('Floor view').selectOption('2d'); await page.keyboard.press('Escape');
    for (const arena of ['Crane Foundry', 'Calibration', 'Module Depot']) await page.locator('.shift-arena-picker button').filter({ hasText: arena }).click();
    await page.getByRole('button', { name: '3×3', exact: true }).click(); await page.getByLabel(/^Bots/).selectOption('hard'); await page.getByLabel('Rotate roles each round').uncheck();
    await page.locator('.shift-role-picker button').filter({ hasText: 'Navigator' }).click();
    await snap(page, 'home-en-configured');
    await page.getByRole('button', { name: /Start practice/ }).click(); await page.locator('.shift-match').waitFor();
    const v = await view(page); log('UI configuration reaches match', { settings: v.settings, role: v.self.role, botDifficulties: v.seats.filter(s => s.bot).map(s => s.difficulty) });
    if (v.settings.difficulty === 'hard' && v.seats.some(s => s.bot && s.difficulty !== 'hard')) defect('Practice difficulty ignored by bot seats', 'SelectHard onhome→start;settingshard butseatdifficulty!=hard');
    await page.getByRole('button', { name: 'Pause', exact: true }).click(); const pausedTick = (await view(page)).tick; await sleep(700); const heldTick = (await view(page)).tick;
    if (heldTick !== pausedTick) defect('Pause advanced simulation', `${pausedTick}→${heldTick}`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Rules', exact: true }).click(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Switch view', exact: true }).click(); await sleep(1000); const renderer = await page.locator('.shift-scene [data-shift-renderer]').getAttribute('data-shift-renderer');
    await snap(page, 'navigator-3d');
    await page.getByRole('button', { name: 'Switch view', exact: true }).click();
    await page.getByRole('button', { name: 'RU', exact: true }).click();
    await page.getByRole('button', { name: 'В меню', exact: true }).click();
    await page.getByRole('button', { name: /Продолжить практику/ }).click();
    const resumed = await view(page); log('Pause/settings/mode/locale/resume buttons', { renderer3d: renderer, pausedTick, heldTick, resumedArena: resumed.settings.arena, resumedTeamSize: resumed.settings.teamSize });
    await snap(page, 'navigator-resumed-ru');
  } finally { await closeContext(context); }
}
async function fullMatch({ arena, teamSize, role, language, viewport }) {
  const { page, context } = await setupPage({ viewport });
  const title = { foundry: /Крановый цех|Crane Foundry/, calibration: /Калибровка|Calibration/, depot: /Склад модулей|Module Depot/ }[arena];
  const id = `${arena}-${teamSize}v${teamSize}-${role}`; console.log(JSON.stringify({ startingMatch: id }));
  try {
    await settings(page, '2d', language);
    await page.locator('.shift-arena-picker button').filter({ hasText: title }).click();
    await page.getByRole('button', { name: `${teamSize}×${teamSize}`, exact: true }).click();
    await page.locator('.shift-role-picker button').filter({ hasText: role === 'pilot' ? /Пилот|Pilot/ : /Штурман|Navigator/ }).click();
    await page.getByRole('button', { name: /Начать практику|Start practice/ }).click(); await page.locator('.shift-match').waitFor(); await focusScene(page);
    const memory = { seq: 0, counter: 0, nextDecisionTick: 0, recentRooms: [] }, started = Date.now();
    const actions = { inputDecisions: 0, fireDecisions: 0, interactPresses: 0, shiftClicks: 0 }, rolesSeen = new Set(), presentationFailures = new Set(), recapRoundsChecked = new Set(), batteryModesChecked = new Set(); let hiddenSamples = 0, observedSamples = 0, batterySamplesChecked = 0;
    let priorRound = 0, lastInteract = -100, lastShift = -100, lastRole, maxTick = 0, shiftsObserved = 0, previousMotionId;
    while (Date.now() - started < 540000) {
      const observed = await view(page, true), v = observed?.view; if (!v) { await sleep(40); continue; }
      maxTick = Math.max(maxTick, v.tick); rolesSeen.add(v.self.role); observedSamples++; if (await page.evaluate(() => document.hidden)) hiddenSamples++;
      if (v.self.role === 'pilot' && v.phase !== 'finished') {
        batterySamplesChecked++; batteryModesChecked.add(`${v.battery.mode}:${v.battery.team || v.battery.spaceId || 'hidden'}`);
        const issue = checkBatteryPresentation(observed, language);
        if (issue && !presentationFailures.has('battery')) { defect('Battery HUD disagrees with permitted view', { id, ...issue }); presentationFailures.add('battery'); }
      }
      if (['intermission', 'finished'].includes(v.phase) && !recapRoundsChecked.has(`${v.round}:${v.phase}`)) {
        const issue = checkRoundPresentation(observed);
        if (issue) defect('Round schematic presentation failed', { id, ...issue });
        recapRoundsChecked.add(`${v.round}:${v.phase}`);
      }
      if (v.round !== priorRound) { console.log(JSON.stringify({ match: id, round: v.round, role: v.self.role, score: v.score, tick: v.tick })); priorRound = v.round; }
      if (v.self.role !== lastRole) { await stop(page); await focusScene(page); lastRole = v.self.role; memory.nextDecisionTick = 0; }
      if (v.motion && `${v.motion.startTick}:${v.motion.roomId}` !== previousMotionId) { shiftsObserved++; previousMotionId = `${v.motion.startTick}:${v.motion.roomId}`; }
      if (v.phase === 'finished') {
        await stop(page); await page.locator('.shift-result').waitFor(); await snap(page, `match-${id}-result`);
        if (!v.rounds.some(r => r.reason === 'delivery')) throw new Error('Normal browser match ended without a delivery');
        const resultText = await page.locator('.shift-result').innerText();
        for (const label of language === 'ru' ? ['Доставки', 'Перехваты', 'Попадания', 'Сдвиги', 'Перевозки союзников', 'Перевозки батареи', 'Новые стыки'] : ['Deliveries', 'Interceptions', 'Hits', 'Shifts', 'Ally rides', 'Battery rides', 'New connections']) if (!resultText.includes(label)) defect('Result contribution missing', { id, label });
        await page.locator('.shift-recap summary').click();
        if (!(await page.locator('.shift-recap').evaluate(el => el.open))) defect('Tactical recap did not expand', id);
        for (let n = 0; n < 8; n++) await page.keyboard.press('Tab');
        if (!(await page.evaluate(() => !!document.activeElement?.closest('.shift-result')))) defect('Result focus escaped dialog', id);
        const result = { id, arena, teamSize, initialRole: role, language, viewport, unacceleratedClock: true, targetTickHz: 30, observedAverageTickHz: Number((v.tick / ((Date.now() - started) / 1000)).toFixed(2)), rolesSeen: [...rolesSeen], actions, hiddenSamples, observedSamples, batterySamplesChecked, batteryModesChecked: [...batteryModesChecked], recapRoundsChecked: [...recapRoundsChecked], wallSeconds: (Date.now() - started) / 1000, tick: v.tick, score: v.score, rounds: v.rounds, stats: v.stats, shiftsObserved, documentHidden: await page.evaluate(() => document.hidden) };
        report.matches.push(result); log('Full browser practice match finished', result);
        if (arena === 'foundry' && teamSize === 2) { await page.locator('.shift-result').getByRole('button', { name: /В лобби|Back to lobby/ }).click(); await page.locator('.shift-home').waitFor(); return; }
        await page.getByRole('button', { name: /Реванш|Rematch/ }).click(); await page.locator('.shift-result').waitFor({ state: 'hidden' });
        const rematch = await view(page); if (rematch.round !== 1 || rematch.score.teal || rematch.score.amber) defect('Rematch did not reset', id);
        await page.getByRole('button', { name: /В меню|Back to menu/ }).click();
        return;
      }
      if (v.phase !== 'active') { await stop(page); await sleep(80); continue; }
      const commands = chooseBotCommands(v, memory), move = commands.find(c => c.type === 'input');
      if (move) {
        actions.inputDecisions++; if (move.fireHeld) actions.fireDecisions++;
        const actor = v.actors.find(a => a.seatId === v.self.seatId);
        if (actor) { const point = worldPosition(v.board, actor, v.motion, v.tick); await aimAt(page, { x: point.x + Math.cos(move.aim) * 6, z: point.z + Math.sin(move.aim) * 6 }); }
        await keysFor(page, move.moveX, move.moveZ, move.fireHeld);
      }
      if (commands.some(c => c.type === 'interact') && v.tick - lastInteract >= 5) { await page.keyboard.press('e'); actions.interactPresses++; lastInteract = v.tick; }
      const shift = commands.find(c => c.type === 'shift');
      if (shift && v.tick - lastShift >= 15) {
        const button = page.locator('.shift-room-keys').getByRole('button', { name: shift.roomId, exact: true });
        await clickLive(page, button); const act = page.locator('.shift-order').getByRole('button', { name: /Сдвинуть|Shift room/ });
        if (await clickLive(page, act)) actions.shiftClicks++; await focusScene(page); lastShift = v.tick;
      }
      await sleep(40);
    }
    await snap(page, `match-${id}-timeout`); throw new Error(`Practice match timeout ${id}, maxTick${maxTick}, view=${JSON.stringify(await view(page))}`);
  } finally { await stop(page).catch(() => {}); await closeContext(context); }
}
async function touchSweep() {
  const { page, context } = await setupPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  try {
    await settings(page, '2d'); await page.getByRole('button', { name: /Начать практику/ }).click(); await page.locator('.shift-match').waitFor();
    const readyStart = Date.now(); let ready; while ((ready = await view(page))?.phase !== 'active' && Date.now() - readyStart < 25000) await sleep(100); if (ready?.phase !== 'active') throw new Error(`Touch practice did not reach active: ${JSON.stringify({ tick: ready?.tick, phase: ready?.phase, hidden: await page.evaluate(() => document.hidden), text: (await page.locator('.shift-match').innerText()).slice(0, 1500) })}`);
    const before = await view(page), actorBefore = before.actors.find(a => a.seatId === 'self');
    const cdp = await context.newCDPSession(page), stick = await page.getByRole('group', { name: 'Ход', exact: true }).boundingBox();
    if (!stick) throw new Error('Touch movement stick is absent');
    const x = stick.x + stick.width * .78, y = stick.y + stick.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); await sleep(450); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(100);
    const after = await view(page), actorAfter = after.actors.find(a => a.seatId === 'self');
    if (actorBefore.x === actorAfter.x && actorBefore.z === actorAfter.z && actorBefore.spaceId === actorAfter.spaceId) defect('Touch movement did not move actor', { actorBefore, actorAfter });
    const aim = await page.getByRole('group', { name: 'Прицел', exact: true }).boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: aim.x + aim.width / 2, y: aim.y + aim.height * .8, id: 3 }] }); await sleep(150); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const aimed = await view(page); const aimingActor = aimed.actors.find(a => a.seatId === 'self');
    if (aimingActor && Math.abs(aimingActor.aim - Math.PI / 2) > .25) defect('Touch aim stick did not turn actor', aimingActor.aim);
    const fire = await page.getByRole('button', { name: 'Выстрел', exact: true }).boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fire.x + fire.width / 2, y: fire.y + fire.height / 2, id: 2 }] }); await sleep(450); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const fired = await view(page); if (!fired.events.some(e => e.kind === 'shot' && e.seatId === 'self')) defect('Touch fire did not produce visible shot', { tick: fired.tick, role: fired.self.role });
    await page.getByRole('button', { name: 'Поставить метку', exact: true }).tap(); await page.getByRole('button', { name: 'Взять или сбросить батарею', exact: true }).tap();
    await page.getByRole('button', { name: 'Пауза', exact: true }).tap();
    await page.getByRole('button', { name: /План этажа/ }).click(); await page.getByRole('button', { name: /План этажа/ }).click();
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, buttons: [...document.querySelectorAll('.shift-touch-controls button')].map(e => ({ label: e.getAttribute('aria-label'), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, bottom: e.getBoundingClientRect().bottom })), fps: document.querySelector('.shift-scene [data-fps]')?.getAttribute('data-fps') }));
    if (metrics.buttons.some(b => b.w < 44 || b.h < 44 || b.bottom > metrics.height)) defect('Touch controls miss44px orviewport constraint', metrics);
    await snap(page, 'touch-844x390'); log('Touch emulation and expanded minimap', metrics);
  } finally { await closeContext(context); }
}
try {
  if (args.has('--ui') || args.has('--all')) await uiSweep().catch(error => defect('UI sweep failed', error.message));
  if (args.has('--lessons') || args.has('--all')) for (const role of ['pilot', 'navigator']) {
    const { page, context } = await setupPage();
    try { await lesson(page, role); } catch (error) { defect(`${role} browser lesson failed`, error.message); } finally { await closeContext(context); }
  }
  if (args.has('--touch') || args.has('--all')) await touchSweep().catch(error => defect('Touch sweep failed', error.message));
  if (args.has('--matrix') || args.has('--all')) {
    const cases = ['foundry', 'calibration', 'depot'].flatMap((arena, i) => [2, 3].map((teamSize, j) => ({ arena, teamSize, role: j ? 'navigator' : 'pilot', language: i % 2 ? 'en' : 'ru', viewport: { width: j ? 1920 : 1366, height: j ? 1080 : 768 } })));
    const concurrency = Math.min(6, Math.max(1, Number(process.env.SHIFT_QA_CONCURRENCY || 2)));
    for (let offset = 0; offset < cases.length; offset += concurrency) {
      const group = cases.slice(offset, offset + concurrency);
      const results = await Promise.allSettled(group.map(fullMatch));
      results.forEach((result, i) => { if (result.status === 'rejected') defect('Full browser match failed', { case: group[i], error: result.reason?.message }); });
    }
  }
} finally {
  await writeFile(resolve(folder, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ resultFile: resolve(folder, 'results.json'), tests: report.tests.length, matches: report.matches.length, defects: report.defects.length, pageErrors: report.errors.length }));
  try { await bounded(() => browser.close(), 4000); } catch { /* BrowserServer owns fallback shutdown. */ }
  try { await bounded(() => browserServer.close(), 4000); } catch { await browserServer.kill(); }
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
}
process.exitCode = report.defects.length || report.errors.length ? 1 : 0;
