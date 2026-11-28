/** Exercise two real browsers against the built District server with isolated accounts. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { checkCoastalMap } from './district-coastal-smoke.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const path of ['dist-platform/main.js', 'apps/portal/dist/index.html']) {
  assert.ok((await stat(join(root, path)).catch(() => null))?.isFile(), 'Run npm run build:foundation first');
}
await mkdir(join(root, '.qa', 'district-territorial-runs'), { recursive: true });
const directory = await mkdtemp(join(root, '.qa', 'district-territorial-runs', 'run-'));
const mailbox = join(directory, 'mail');
const isolatedServer = join(directory, 'server');
const isolatedPortal = join(directory, 'portal');
await cp(join(root, 'dist-platform'), isolatedServer, { recursive: true });
await cp(join(root, 'apps/portal/dist'), isolatedPortal, { recursive: true });
let running = null;
let browser = null;

let origin = '';
let port = 0;

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });

async function start() {
  const child = spawn(process.execPath, [join(isolatedServer, 'main.js')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PLATFORM_HOST: '127.0.0.1',
      PLATFORM_PORT: String(port),
      PORTAL_ORIGIN: origin,
      PLATFORM_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      PLATFORM_ALLOWED_ORIGINS: origin,
      PLATFORM_DATABASE_PATH: join(directory, 'platform.sqlite'),
      PLATFORM_LAB_DATABASE_PATH: join(directory, 'lab.sqlite'),
      MAIL_MODE: 'file',
      MAIL_FILE_DIRECTORY: mailbox,
      TELEGRAM_ENABLED: 'false',
      TELEGRAM_AUTH_ENABLED: 'false',
      PORTAL_DIST_DIRECTORY: isolatedPortal,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, output: '', error: null };
  running = state;
  const collect = (part) => {
    state.output = (state.output + String(part)).slice(-12000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (error) => {
    state.error = error;
  });
  const ready = `Iva Games platform listening on 127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (state.error) throw state.error;
    assert.ok(child.exitCode === null && child.signalCode === null, 'Built platform exited before readiness');
    // A racing process on the selected port must never be treated as our test server.
    if (state.output.split(/\r?\n/).includes(ready)) {
      assert.equal((await request(origin + '/health/ready')).status, 200);
      return;
    }
    await delay(25);
  }
  throw new Error('Built platform readiness timeout');
}

async function stop() {
  const state = running;
  if (!state) return;
  running = null;
  const { child } = state;
  if (state.error || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    const killDeadline = Date.now() + 1500;
    while (child.exitCode === null && child.signalCode === null && Date.now() < killDeadline) await delay(25);
    throw new Error(`Built platform did not stop gracefully. Startup and shutdown log:\n${state.output}`);
  }
}

class Client {
  cookie = '';
  csrf = '';

  async request(path, data, key) {
    const response = await request(`${origin}/api/platform/v1${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: this.cookie,
        ...(data === undefined
          ? {}
          : { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('iva_dev_session='));
    if (cookie) this.cookie = cookie.split(';')[0];
    const result = await response.json();
    assert.ok(response.ok, `${path}: HTTP ${response.status}, ${result.error?.code ?? 'unknown error'}`);
    if (path === '/session') this.csrf = result.csrfToken;
    return result;
  }

  async register(handle) {
    await this.request('/session');
    const email = `${handle}@example.test`;
    const registered = await this.request('/auth/register', {
      email,
      handle,
      displayName: handle,
      password: 'isolated local fixture password',
    });
    await this.request('/session');
    let token;
    for (const file of await readdir(mailbox)) {
      const contents = await readFile(join(mailbox, file), 'utf8');
      if (!contents.startsWith(`To: ${email}\n`)) continue;
      const url = contents.match(/https?:\/\/[^\s]+\/verify\?token=[^\s]+/)?.[0];
      if (url) token = new URL(url).searchParams.get('token');
    }
    assert.ok(token, 'Verification must reach the isolated file mailbox');
    await this.request('/auth/verify', { token });
    assert.equal((await this.request('/session')).user.emailVerified, true);
    return registered.user;
  }
}

let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    try {
      await Promise.allSettled([browser?.close()]);
      await stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });

const result = { uiActions: [], layouts: [], commands: 0, restarted: false, trade: false, tutorialSteps: [],
  automated: true, humanPlaytest: false, audioListened: false,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHasWorkingChanges: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  build: Object.fromEntries(await Promise.all([['server', join(isolatedServer, 'main.js')], ['portalIndex', join(isolatedPortal, 'index.html')]]
    .map(async ([name, path]) => [name, createHash('sha256').update(await readFile(path)).digest('hex')]))),
};
const artifacts = join(root, '.qa', 'district-territorial-browser');
async function newsFixtures(clients, pages, guest) {
  const [alice, bob] = clients;
  let room = (
    await alice.request(
      '/rooms',
      {
        gameId: 'district',
        capacity: 2,
        title: 'Isolated news fixture',
        settings: { mapId: 'azure-bay', mapVersion: '2', newsPreset: 'medium' },
      },
      'fixture-room',
    )
  ).room;
  const path = '/rooms/' + room.roomId;
  const invite = (await alice.request(path + '/invitations', { playerId: guest.playerId }, 'fixture-invite'))
    .invitation;
  await bob.request('/invitations/' + invite.invitationId + '/accept', {}, 'fixture-accept');
  room = (await bob.request(path + '/join', {}, 'fixture-join')).room;
  for (const [index, c] of clients.entries())
    await c.request(path + '/ready', { ready: true, expectedRevision: room.revision }, 'fixture-ready-' + index);
  room = (await alice.request(path + '/start', { expectedRevision: room.revision }, 'fixture-start')).room;
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: 'games/district/src/territorial/news.ts',
      outDir: join(directory, 'news-core'),
      target: 'node22',
      rollupOptions: { output: { entryFileNames: 'news.mjs' } },
    },
  });
  const { tutorialNews, newsBoundary } = await import(pathToFileURL(join(directory, 'news-core', 'news.mjs')).href);
  const database = join(directory, 'lab.sqlite');
  await stop();
  const reader = new Database(database, { readonly: true });
  const baseline = JSON.parse(
    reader.prepare('SELECT state_json FROM district_territorial_matches WHERE match_id=?').get(room.matchId).state_json,
  );
  reader.close();
  const samples = [];
  for (const [id, draws, label] of [
    ['G02', [], 'aid'],
    ['H04', [0], 'surprise'],
    ['H04', [99, 0, 99], 'cancel'],
    ['H04', [99, 0, 0], 'confirmed'],
    ['P02', [0, 0], 'investment'],
    ['E01', [99, 0, 0], 'spread'],
    ['E01', [99, 0, 99], 'contained'],
  ]) {
    const state = structuredClone(baseline);
    state.phase = 'roll';
    state.turn = 17;
    state.round = 8;
    state.news.processedRound = 8;
    state.news.nextRound = 99;
    const node = state.map.nodes[0],
      zone = node.eventSectorId;
    const other = state.map.nodes.find((n) => n.eventSectorId !== zone);
    state.buildings[node.id] = { ownerId: state.participants[0].participantId, level: 2 };
    state.buildings[other.id] = { ownerId: state.participants[1].participantId, level: 2 };
    let roll = 0;
    tutorialNews(state, id, zone, (bound) => (draws[roll++] ?? 0) % bound);
    let seen = 0;
    for (let tick = 0; tick < 7; tick++) {
      if (state.news.messages.length > seen) {
        const fresh = state.news.messages.slice(seen);
        seen = state.news.messages.length;
        samples.push({ label, state: structuredClone(state), ids: fresh.map((n) => n.messageId) });
      }
      state.round++;
      newsBoundary(state);
    }
  }
  result.fixtureStages = [];
  for (const [index, sample] of samples.entries()) {
    await stop();
    sample.state.revision = 1000 + index;
    sample.state.deadlineAt = Date.now() + 150000;
    const db = new Database(database);
    db.prepare('UPDATE district_territorial_matches SET state_json=? WHERE match_id=?').run(
      JSON.stringify(sample.state),
      room.matchId,
    );
    db.close();
    await start();
    const [a, b] = await Promise.all(clients.map(async (c) => (await c.request(path + '/match')).view));
    assert.deepEqual(a.news, b.news);
    for (const page of pages) await page.goto(origin + path);
    for (const id of sample.ids) {
      const msg = a.news.find((n) => n.messageId === id);
      const forecast = ['forecast', 'confirmed', 'update'].includes(msg.stage);
      if (forecast)
        assert.deepEqual(
          Object.keys(msg).filter(
            (k) =>
              ![
                'messageId',
                'templateId',
                'eventInstanceId',
                'chainId',
                'round',
                'stage',
                'headline',
                'zone',
                'dueRound',
              ].includes(k),
          ),
          [],
        );
      for (const page of pages) {
        const card = page.locator('[data-news-id="' + id + '"]');
        if (!(await card.count())) {
          await page.locator('.tn-journal-open').click();
          await page.locator('.tn-journal-group').getByRole('button').filter({ hasText: msg.headline.en }).last().click();
        }
        await expect(card).toBeVisible();
        if (forecast) {
          await expect(card.locator('.tn-changes')).toHaveCount(0);
          await expect(card.locator('.tn-meta')).toContainText('Due at the end');
        }
        if (!forecast && msg.changes?.length) await expect(card.locator('.tn-changes')).toBeVisible();
        if (msg.zone === undefined || msg.stage === 'cancelled') await expect(card.locator('.tn-area[aria-pressed]')).toHaveCount(0);
        else {
          const show = card.locator('.tn-area[aria-pressed]');
          if ((await show.getAttribute('aria-pressed')) !== 'true') await show.click();
          await expect(
            page.locator(
              '.tb-news-frame.' + (forecast ? 'risk' : 'applied'),
            ),
          ).toBeVisible();
          await expect(page.locator('.tb-news-frame [data-board-target]')).toHaveCount(0);
        }
      }
      result.fixtureStages.push(sample.label + '/' + msg.stage);
    }
  }
}
async function training(page, roomId, touch = false) {
  await page.goto(origin + '/district-training?room=' + roomId);
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  const lesson = page.locator('.territory-lesson');
  let checkedNewsLayout = false;
  for (let step = 0; step < 12; step++) {
    if (await lesson.getByRole('link', { name: 'Play', exact: true }).isVisible()) break;
    const highlighted = page.locator('.tb-target.is-available').first();
    if (await highlighted.count()) await (touch ? highlighted.tap() : highlighted.focus().then(() => highlighted.press('Enter')));
    const button = lesson.locator('button.primary');
    const issue = page.locator('.tn-issue');
    if (!checkedNewsLayout && await issue.isVisible()) {
      const [lessonBox, issueBox, textBox] = await Promise.all([
        lesson.boundingBox(), issue.boundingBox(), page.locator('.tn-issue-cards').boundingBox(),
      ]);
      assert.ok(lessonBox && issueBox && textBox && textBox.height >= 60, 'Lesson and a readable news area must be present');
      assert.ok(lessonBox.y + lessonBox.height <= issueBox.y || issueBox.y + issueBox.height <= lessonBox.y,
        'An open news issue must not cover the current lesson');
      await lesson.scrollIntoViewIfNeeded();
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, touch ? 'practice-news-mobile.png' : 'practice-news-desktop.png') });
      checkedNewsLayout = true;
    }
    result.tutorialSteps.push(await button.innerText());
    if (touch) await button.tap(); else await button.click();
  }
  assert.ok(checkedNewsLayout, 'The practice news layout was exercised');
  await expect(lesson.getByRole('link', { name: 'Play', exact: true })).toBeVisible();
  await lesson.getByRole('button', { name: 'Prepare for a threat' }).click();
  const forecast = page.locator('.tn-stage-confirmed');
  await expect(forecast.locator('.tn-changes')).toHaveCount(0);
  await forecast.getByRole('button', { name: 'Show on map' }).click();
  await expect(page.locator('.tb-news-frame.risk')).toBeVisible();
  if (await page.getByRole('button', { name: 'Dismiss news', exact: true }).isVisible()) await page.getByRole('button', { name: 'Dismiss news', exact: true }).click();
  const home = page.locator('[data-board-target="node:v1_1"]');
  await home.focus();
  await home.press('Enter');
  await lesson.locator('button.primary').click();
  for (let i = 0; i < 2; i++) {
    if (await page.getByRole('button', { name: 'Dismiss news', exact: true }).isVisible()) await page.getByRole('button', { name: 'Dismiss news', exact: true }).click();
    await lesson.getByRole('button', { name: 'Play one round' }).click();
  }
  // Reopen the issue if the earlier forecast is still being inspected.
  await page.locator('.tn-journal-open').click();
  await page.locator('.tn-journal-group button').filter({ hasText: 'Meteor impact' }).last().click();
  await expect(page.locator('.tn-card')).toContainText('No damage');
  await page.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expect(page.locator('.tb-news-frame.applied')).toBeVisible();
  if (await page.getByRole('button', { name: 'Dismiss news', exact: true }).isVisible()) await page.getByRole('button', { name: 'Dismiss news', exact: true }).click();
  await lesson.getByRole('button', { name: 'Finish episode' }).click();
  await lesson.getByRole('link', { name: 'Play', exact: true }).click();
  await expect(page.locator('.territorial-board')).toBeVisible();
}
try {
  port = await availablePort();
  origin = 'http://127.0.0.1:' + port;
  await start();
  await mkdir(artifacts, { recursive: true });
  const clients = [new Client(), new Client()];
  const [alice, bob] = clients;
  await alice.register('territory_first');
  const guest = await bob.register('territory_second');
  const friendship = await alice.request('/friend-requests', { playerId: guest.playerId }, 'territory-friends-send');
  await bob.request('/friend-requests/' + friendship.requestId + '/accept', {}, 'territory-friends-accept');
  let room = (
    await alice.request(
      '/rooms',
      {
        gameId: 'district',
        capacity: 3,
        title: 'Territorial QA',
        settings: { mapId: 'two-shores', mapVersion: '2', newsPreset: 'very-hard' },
      },
      'territory-create',
    )
  ).room;
  const path = '/rooms/' + room.roomId;
  const invite = (await alice.request(path + '/invitations', { playerId: guest.playerId }, 'territory-invite'))
    .invitation;
  await bob.request('/invitations/' + invite.invitationId + '/accept', {}, 'territory-invite-accept');
  room = (await bob.request(path + '/join', {}, 'territory-join')).room;
  room = (
    await alice.request(path + '/bots', { difficulty: 'hard', expectedRevision: room.revision }, 'territory-add-bot')
  ).room;
  for (const [index, client] of clients.entries())
    await client.request(path + '/ready', { ready: true, expectedRevision: room.revision }, 'territory-ready-' + index);
  room = (await alice.request(path + '/start', { expectedRevision: room.revision }, 'territory-start')).room;
  assert.equal(room.rulesVersion, 'district@0.4');
  const current = async (client) => (await client.request(path + '/match')).view;
  const post = async (client, view, action) =>
    (
      await client.request(path + '/actions', {
        actionId: randomUUID(),
        expectedRevision: view.revision,
        payload: { phaseId: view.phaseId, ...action },
      })
    ).view;
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: 'games/district/src/territorial/bot.ts',
      outDir: join(directory, 'policy'),
      target: 'node22',
      rollupOptions: { output: { entryFileNames: 'policy.mjs' } },
    },
  });
  const { chooseTerritoryBot } = await import(pathToFileURL(join(directory, 'policy', 'policy.mjs')).href);
  browser = await chromium.launch({
    headless: true,
    args: ['--mute-audio', ...(process.env.PLAYWRIGHT_CHROMIUM_ARGS ? JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS) : [])
      .filter(value => !value.includes('disable-web-security') && !value.includes('allow-running-insecure-content') && !value.includes('single-process'))],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const pages = [],
    contexts = [],
    errors = [];
  for (const [index, client] of clients.entries()) {
    const context = await browser.newContext({
      viewport: index ? { width: 390, height: 844 } : { width: 1366, height: 768 },
      hasTouch: Boolean(index),
    });
    const [name, value] = client.cookie.split('=');
    await context.addCookies([{ name, value, url: origin }]);
    await context.addInitScript(() => localStorage.setItem('iva.portal.language', 'en'));
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + path);
    await expect(page.locator('.territorial-board')).toBeVisible();
    await expect(page.locator('.territory-players').getByText('Bot 3', { exact: true })).toBeVisible();
    pages.push(page);
    contexts.push(context);
    const box = await page.locator('.tb-surface').boundingBox();
    assert.ok(box.width >= 300 && box.height >= 170);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    result.layouts.push({
      viewport: page.viewportSize(),
      boardWidth: Math.round(box.width),
      boardHeight: Math.round(box.height),
    });
  }
  await pages[0].setViewportSize({ width: 1440, height: 900 });
  const wide = await pages[0].locator('.tb-surface').boundingBox();
  result.layouts.push({
    viewport: pages[0].viewportSize(),
    boardWidth: Math.round(wide.width),
    boardHeight: Math.round(wide.height),
  });
  await training(pages[0], room.roomId);
  await training(pages[1], room.roomId, true);
  async function clickAction(page, button, uiRetry = null) {
    if (await page.getByRole('button', { name: 'Dismiss news', exact: true }).isVisible()) await page.getByRole('button', { name: 'Dismiss news', exact: true }).click();
    if (uiRetry) {
      // Author group decisions own their stale retry in the UI. Observe the
      // same intent after one click; a successful retry removes its button.
      assert.ok(['accept', 'cancel'].includes(uiRetry.type));
      let original, previousRevision, attempts = 0;
      let validation = Promise.resolve(false);
      const pendingResponse = page.waitForResponse(response => {
        if (!response.url().endsWith(path + '/actions') || response.request().method() !== 'POST') return false;
        validation = validation.then(async () => {
          const command = response.request().postDataJSON();
          assert.equal(command.payload.type, uiRetry.type);
          assert.ok(typeof command.actionId === 'string' && command.actionId.length > 0);
          assert.ok(Number.isSafeInteger(command.expectedRevision));
          assert.ok(uiRetry.offerIds.includes(command.payload.offerId), 'Author decision stays within its original offer group');
          if (original) {
            assert.equal(command.actionId, original.actionId, 'UI retry preserves the clicked action identity');
            assert.ok(command.expectedRevision > previousRevision, 'A stale retry uses a newer revision');
            const payload = uiRetry.type === 'cancel' ? { ...command.payload, offerId: original.payload.offerId } : command.payload;
            assert.deepEqual(payload, original.payload, 'UI retry preserves the decision, chosen recipient and phase');
          } else original = command;
          previousRevision = command.expectedRevision;
          const data = await response.json();
          assert.ok(++attempts <= 5, 'Author decision has at most five POST attempts');
          if (response.status() === 200) return true;
          assert.equal(response.status(), 409, JSON.stringify(data));
          assert.equal(data.error?.code, 'STALE_REVISION', JSON.stringify(data));
          assert.ok(attempts < 5, 'Author decision exhausted its stale retry limit');
          return false;
        });
        return validation;
      });
      await Promise.all([button.click(), pendingResponse]);
      result.uiActions.push(uiRetry.type);
      return;
    }
    for(let attempt=0;attempt<3;attempt++) {
      const pendingResponse=page.waitForResponse(r=>r.url().endsWith(path+'/actions')&&r.request().method()==='POST');
      await button.click(); const response=await pendingResponse;
      const data=await response.json();
      if(response.status()===409&&data.error?.code==='STALE_REVISION'&&attempt<2) {
        await page.waitForResponse(r=>r.url().endsWith(path+'/match')&&r.request().method()==='GET'&&r.ok());
        continue;
      }
      assert.equal(response.status(),200,JSON.stringify(data));
      result.uiActions.push(response.request().postDataJSON().payload.type); return;
    }
  }
  let done;
  for (let step = 0; step < 3500; step++) {
    const views = await Promise.all(clients.map(current));
    const snapshot = views[0];
    if (!result.denseScreenshot && snapshot.round >= 8) {
      for (const [index, page] of pages.entries()) {
        await page.reload();
        await expect(page.locator('.tb-house').first()).toBeVisible();
        await page.screenshot({ path: join(artifacts, index ? 'mobile-midgame.png' : 'desktop-midgame.png') });
      }
      result.denseScreenshot = {
        round: snapshot.round,
        houses: Object.keys(snapshot.buildings).length,
        routes: Object.keys(snapshot.routes).length,
      };
    }
    if (snapshot.outcome) {
      done = snapshot;
      break;
    }
    if (snapshot.revision !== views[1].revision) { await delay(250); continue; }
    if (snapshot.round >= 2 && !result.restarted && views.some((v) => v.activeParticipantId === v.you.participantId)) {
      await contexts[1].setOffline(true);
      await stop();
      await start();
      const restored = await current(alice);
      assert.equal(restored.revision, snapshot.revision);
      assert.equal(restored.matchId, snapshot.matchId);
      assert.deepEqual(restored.news, snapshot.news);
      assert.deepEqual(restored.buildings, snapshot.buildings);
      await contexts[1].setOffline(false);
      await pages[1].reload();
      await expect(pages[1].locator('.territorial-board')).toBeVisible();
      result.restarted = true;
    }
    let played = false;
    for (const [index, view] of views.entries()) {
      const page = pages[index],
        client = clients[index];
      const action = chooseTerritoryBot(view, 'hard', 'acceptance-' + index + '-' + view.revision);
      if (!action) continue;
      if ((action.type === 'place' || action.type === 'route') && !result.uiActions.includes(action.type)) {
        const id = action.nodeId ?? action.edgeId;
        const target = page.locator('[data-board-target="' + (action.nodeId ? 'node:' : 'edge:') + id + '"]');
        await target.focus();
        await target.press('Enter');
        await clickAction(
          page,
          page.getByRole('button', { name: action.nodeId ? 'Build house' : 'Build road', exact: true }),
        );
      } else if (!result.trade && view.phase === 'play' && view.you.participantId === view.activeParticipantId) {
        const other = views[1 - index];
        const give = Object.keys(view.you.hand).find(
          (r) => view.you.hand[r] > 0 && Object.keys(other.you.hand).some((k) => k !== r && other.you.hand[k] > 0),
        );
        const take = Object.keys(other.you.hand).find((r) => r !== give && other.you.hand[r] > 0);
        if (give && take) {
          await page.reload();
          if (await page.getByRole('button', { name: 'Dismiss news', exact: true }).isVisible()) await page.getByRole('button', { name: 'Dismiss news', exact: true }).click();
          await page.getByRole('button', { name: 'Offer a trade', exact: true }).click();
          const geometry = async p => p.locator('.tb-surface').evaluate(el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scrollY:window.scrollY}; });
          await Promise.all(pages.map(p => p.evaluate(() => document.fonts.ready)));
          const headerLayout=async p=>p.evaluate(()=>Object.fromEntries(['.territory-top','.territory-phase','.territory-phase-heading','.territory-phase p','.territory-phase>small','.territory-roll','.territory-roll-copy','.territory-roll-copy>strong','.territory-roll-copy>small','.territory-roll-income'].map(selector=>{const el=document.querySelector(selector);const r=el?.getBoundingClientRect();return[selector,{text:el?.textContent,display:el?getComputedStyle(el).display:null,y:r?.y,height:r?.height,width:r?.width}]})));
          const unsynchronizedHeaders=await Promise.all(pages.map(headerLayout));
          if(view.latestRoll) for(const p of pages) {
            await expect(p.locator('.territory-roll-copy>small')).toHaveText(`Round ${view.latestRoll.round+1} \u00b7 turn ${view.latestRoll.turn}`);
          }
          const beforeHeaders=await Promise.all(pages.map(headerLayout));
          const beforeGeometry = await Promise.all(pages.map(geometry));
          const resourceName = (r) => r.charAt(0).toUpperCase() + r.slice(1);
          await page.getByRole('button', { name: 'I give + ' + resourceName(give), exact: true }).click();
          await page.getByRole('button', { name: 'I receive + ' + resourceName(take), exact: true }).click();
          await clickAction(page, page.getByRole('button', { name: 'Send offer', exact: true }));
          const otherPage = pages[1 - index];
          await expect(otherPage.locator('.ta-offer').filter({hasText: nameOfHuman(view)})).toBeVisible();
          await clickAction(
            otherPage,
            otherPage
              .locator('.ta-offer')
              .filter({ hasText: nameOfHuman(view) })
              .getByRole('button', { name: 'Accept', exact: true }),
          );
          await expect(page.locator('.ta-offer[data-offer-status=agreed]').first()).toBeVisible();
          const consentView = await current(client);
          assert.deepEqual(consentView.you.hand, view.you.hand, 'Consent cannot transfer the author hand');
          for (const [i,p] of pages.entries()) assert.deepEqual(await geometry(p), beforeGeometry[i], 'Offer appearance/consent keeps board and page geometry '+JSON.stringify({before:beforeHeaders[i],after:await headerLayout(p)}));
          await mkdir(artifacts, {recursive:true});
          for (const [i,p] of pages.entries()) await p.screenshot({path:join(artifacts,i ? 'trade-mobile.png' : 'trade-desktop.png')});
          await clickAction(page, page.getByRole('button', {name: new RegExp('^Trade with '+other.players.find(p=>p.participantId===other.you.participantId).displayName)}), {
            type: 'accept',
            offerIds: consentView.offers.filter(offer => offer.authorId === view.you.participantId && offer.targetId === other.you.participantId && offer.agreedAt !== undefined).map(offer => offer.id),
          });
          await expect(page.locator('.ta-offer[data-offer-status=agreed]')).toHaveCount(0);
          for (const [i,p] of pages.entries()) assert.deepEqual(await geometry(p), beforeGeometry[i], 'Offer removal keeps board and page geometry');
          // The common author cross remains actionable after consent, without a transfer.
          await page.locator('.ta-trade-open').click();
          if (await page.getByRole('button',{name:'Discard draft',exact:true}).isVisible()) {
            await page.getByRole('button',{name:'Discard draft',exact:true}).click();
            await page.getByRole('button',{name:'Discard',exact:true}).click();
            await page.locator('.ta-trade-open').click();
          }
          await page.getByRole('button', {name:'I give + '+resourceName(take),exact:true}).click();
          await page.getByRole('button', {name:'I receive + '+resourceName(give),exact:true}).click();
          await clickAction(page,page.getByRole('button',{name:'Send offer',exact:true}));
          const cancelBaseline=await current(client);
          const cancellation=cancelBaseline.offers.find(offer=>offer.authorId===view.you.participantId&&offer.targetId===other.you.participantId);
          await clickAction(otherPage,otherPage.locator(`[data-offer-id="${cancellation.id}"]`).getByRole('button',{name:'Accept',exact:true}));
          await expect(page.locator(`[data-offer-id="${cancellation.id}"][data-offer-status=agreed]`)).toBeVisible();
          await clickAction(page,page.getByRole('button',{name:'Withdraw offer for everyone',exact:true}), {
            type: 'cancel',
            offerIds: cancelBaseline.offers.filter(offer => offer.groupId === cancellation.groupId).map(offer => offer.id),
          });
          const cancelled=await current(client);
          assert.deepEqual(cancelled.you.hand,cancelBaseline.you.hand,'The author cross never transfers consented resources');
          assert.equal(cancelled.offers.some(offer=>offer.groupId===cancellation.groupId),false);
          for (const [i,p] of pages.entries()) assert.deepEqual(await geometry(p),beforeGeometry[i],'Group cancellation keeps geometry');
          result.groupCancel=true;
          result.tradeGeometry = beforeGeometry;
          result.tradeHeaderLayout={unsynchronized:unsynchronizedHeaders,before:beforeHeaders,after:await Promise.all(pages.map(headerLayout))};
          result.trade = true;
        } else await post(client, view, action);
      } else await post(client, view, action);
      result.commands++;
      played = true;
      break;
    }
    if (process.env.DISTRICT_TRADE_ONLY === '1' && result.trade) { done = await current(alice); break; }
    // Bots now publish a real, persistent scheduled action. Wait for that
    // action instead of hammering two match endpoints every 8 ms.
    if (!played) await delay(Math.min(1200, Math.max(500,
      (snapshot.botActionAt ?? snapshot.serverNow + 900) - snapshot.serverNow + 50)));
  }
  if (process.env.DISTRICT_TRADE_ONLY !== '1') {
  assert.ok(done?.outcome?.winnerParticipantIds.length, 'Match did not finish with a winner');
  for (const [index, client] of clients.entries()) {
    const final = await current(client);
    assert.deepEqual(final.outcome, done.outcome);
    assert.deepEqual(final.news, done.news);
    await pages[index].reload();
    await expect(pages[index].locator('.territory-outcome')).toBeVisible();
  }
  await checkCoastalMap(bob, pages[1], origin);
  await newsFixtures(clients, pages, guest);
  }
  assert.deepEqual(errors, []);
  assert.ok(result.trade && (process.env.DISTRICT_TRADE_ONLY === '1' || result.restarted));
  console.log(
    JSON.stringify(
      {
        ...result,
        rounds: done.round,
        revision: done.revision,
        winners: done.outcome?.winnerParticipantIds.length ?? 0,
        newsMessages: done.news.length,
      },
      null,
      2,
    ),
  );
} finally {
  await cleanup();
}

function nameOfHuman(view) {
  return view.players.find((p) => p.participantId === view.you.participantId).displayName;
}
