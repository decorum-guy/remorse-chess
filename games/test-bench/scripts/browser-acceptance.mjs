/** Automated UI acceptance of the actual production bundles.
 * Isolated accounts/mail/SQLite/browser contexts. No application-state hooks,
 * API gameplay commands, mocked transport, timer jumps or production writes.
 * Gameplay observation: received browser WebSocket frames and visible DOM/HUD.
 * Gameplay control: Playwright keyboard, pointer, touchscreen and normal UI.
 */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { delayedLoopback } from './latency-proxy.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, '.qa', 'test-bench-browser', process.env.IVA_BROWSER_RUN ?? 'current');
const digest = data => createHash('sha256').update(data).digest('hex');
function timing(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = fraction => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 10) / 10 : null;
  return { count: sorted.length, min: at(0), p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
}
const directory = await mkdtemp(join(tmpdir(), 'iva-test-bench-browser-'));
const mailbox = join(directory, 'mail');
const players = [];
const latencyMs = Number(process.env.IVA_BROWSER_LATENCY_MS ?? 0);
assert.ok(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 1000, 'IVA_BROWSER_LATENCY_MS must be between 0 and 1000');
const extended = process.env.IVA_BROWSER_EXTENDED === '1';
let fixtureDirectory;
let policy;
let browser;
let server;
let origin = '';
let port = 0;
let relay;
const report = {
  status: 'running', method: 'Automated Chromium UI against production client/server bundles',
  scope: 'Automated 2D online protocol/controller diagnostic with two isolated account contexts and two explicit bots; separate 3D practice, tutorial and fault checks',
  humanPlaytest: false, audioListening: false, physicalDevice: false, mockedGameApi: false,
  directGameplayApiCommands: 0, externalMessages: 0, fullCups: 0, fullCupsMode: '2D browser automation; neither human play nor 3D online acceptance', tutorial: 'not started',
  extendedCoverage: {
    enabled: extended, flag: 'IVA_BROWSER_EXTENDED=1', targetedZeroScoreTieCups: 0,
    looseCargoPickup: { status: extended ? 'not started' : 'disabled' },
    zeroScoreTieCup: { status: extended ? 'not started' : 'disabled' },
    originalFinishedCupReturn: { status: extended ? 'not started' : 'disabled' },
  },
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  gitTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  scopes: [], requiredScopeFailures: [], scenarios: [], cups: [], metrics: [], coldTransfers: [], layouts: [], browserErrors: [], consoleErrors: [], consoleErrorsDropped: 0, failedAssets: [], expectedOfflineAssetFailures: [], actionErrors: [], observedGameActions: {},
  controls: { keyboardEvents: 0, touchGestures: 0, acceptedUiActions: 0 },
  roomResponses: [], roomKeyboardActivations: [], restoreChecks: [], restoreCommands: [], uprightStallRecoveries: [], interactionStops: [], restartChecks: [], driveStages: [], localDriverTraces: [], tutorialRetries: [],
  controller: {
    method: 'Real keyboard W/A/D/Space/E/R, with normal bot decisions and wheel-angle feedback from received own-lane snapshots',
    uprightStall: { track: 'precision', method: 'QA-only public-snapshot stall detector; an accepted trigger requests real R with brake and neutral steering', requestedHoldMs: 750, holdTiming: '750 ms after keyboard-down acknowledgement; actual dispatch/release times are recorded', gameStateMutation: false },
    delayedPrecision: { enabled: latencyMs > 0, track: 'precision', configuredPerDirectionMs: latencyMs, horizon: 'Decision wall time plus configured input delay minus snapshot.serverTime', inputHistory: 'Last 30 actually observed browser WebSocket input frames, in send order, including frames preceding the snapshot', deliveryEstimate: 'Runner framesent observation time plus configured relay delay', wheelEstimate: 'Snapshot wheel angle replayed at 60 Hz toward each historical steering target, with rate 2.8 rad/s and the snapshot speed limit', poseEstimate: 'Constant received x/z velocity and yaw angular velocity; y, speed and all other lane fields unchanged', clockAssumption: 'Isolated runner and server share one host wall clock. Snapshot timestamp can be later than its physics step; estimates require real-browser validation.', resetScope: 'Socket connection, match, epoch, stage and phase; only controller history is cleared', gameStateMutation: false },
  },
  transport: { path: latencyMs ? 'Owned loopback TCP delay relay for HTTP and WebSocket bytes' : 'Direct owned loopback', configuredPerDirectionMs: latencyMs, publicInternetMeasurement: false },
  openCoverage: ['Actual listening', 'Physical touch hardware', 'Human browser play', '3D online driving/performance remains unaccepted: candidate 7 Direct Alice did not finish Precision with SwiftShader; this run uses 2D online without replacing that failure'],
};
const http = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8000), redirect: 'error' });

function omitDataUrls(value) {
  const omitted = [];
  const text = value.replace(/data:[^\s"'<>]+/gi, url => {
    const comma = url.indexOf(',');
    const type = comma < 0 ? 'unspecified' : url.slice(5, comma).slice(0, 100);
    omitted.push({ type, characters: url.length });
    return `[data URL omitted: ${type}; ${url.length} characters]`;
  });
  return { text, omitted };
}

async function emitEvidence(kind, value) {
  const envelope = { evidence: 'test-bench-browser@1', kind, data: value };
  const write = text => new Promise((resolve, reject) => process.stdout.write(text + '\n', error => error ? reject(error) : resolve()));
  if (Buffer.byteLength(JSON.stringify(envelope)) + 1 <= 8192) { await write(JSON.stringify(envelope)); return; }
  // Every line stays below the observed 65,536-byte loss boundary. Split by
  // Unicode code point, measuring its JSON-escaped byte cost, so recombining
  // dataFragment in part order reproduces the complete JSON value exactly.
  const pieces = []; let piece = ''; let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + cost > 6000) { pieces.push(piece); piece = ''; bytes = 0; }
    piece += character; bytes += cost;
  }
  if (piece) pieces.push(piece);
  for (const [index, dataFragment] of pieces.entries()) await write(JSON.stringify({ evidence: 'test-bench-browser@1', kind, part: index + 1, parts: pieces.length, dataFragment }));
}

function buildIdentity() {
  return Object.fromEntries(['gitHead', 'gitTree', 'workingTreeDirty', 'builtMainSha256', 'builtWorkerSha256', 'builtIndexSha256', 'runnerSha256', 'qaDriverSha256', 'browserVersion'].map(key => [key, report[key] ?? null]));
}

function compactLocalTrace(trace) {
  const { observations, keyTransitions, ...metadata } = trace;
  return { ...metadata, firstObservations: observations.slice(0, 4), finalObservations: observations.slice(-24), peakSpeedObservation: observations.reduce((best, value) => !best || value.speed > best.speed ? value : best, null), longestDecisionInterval: observations.reduce((best, value) => !best || value.intervalMs > best.intervalMs ? value : best, null), finalKeyTransitions: keyTransitions.slice(-40) };
}

function compactFinalReport() {
  const verdict = ({ id, name, status, dependencies, error }) => ({ id, name, status, dependencies, error });
  return {
    status: report.status, method: report.method, scope: report.scope, ...buildIdentity(),
    humanPlaytest: report.humanPlaytest, audioListening: report.audioListening, physicalDevice: report.physicalDevice,
    directGameplayApiCommands: report.directGameplayApiCommands, externalMessages: report.externalMessages,
    fullCups: report.fullCups, fullCupsMode: report.fullCupsMode, tutorial: report.tutorial,
    extendedCoverage: { enabled: extended, flag: report.extendedCoverage.flag, targetedZeroScoreTieCups: report.extendedCoverage.targetedZeroScoreTieCups, ...Object.fromEntries(['looseCargoPickup', 'zeroScoreTieCup', 'originalFinishedCupReturn'].map(key => [key, { status: report.extendedCoverage[key].status, error: report.extendedCoverage[key].error }])) },
    scopes: report.scopes.map(verdict), requiredScopeFailures: report.requiredScopeFailures, scenarios: report.scenarios.map(verdict),
    cups: report.cups.map(cup => ({ roomId: cup.roomId, matchId: cup.matchId, mode: cup.mode, renderers: cup.renderers, status: cup.status, completedStages: cup.stages.length, stages: cup.stages.map(stage => ({ stage: stage.stage, track: stage.track, mirrored: stage.mirrored, results: stage.results, sameProtocol: stage.sameProtocol, reset: stage.reset, disconnect: stage.disconnect, restart: stage.restart })), standings: cup.standings })),
    controls: report.controls, observedGameActions: report.observedGameActions, roomResponses: report.roomResponses, roomKeyboardActivations: report.roomKeyboardActivations,
    errorCounts: { uncaught: report.browserErrors.length, console: report.consoleErrors.length, consoleOccurrences: report.consoleErrors.reduce((sum, item) => sum + item.occurrences, 0), consoleDropped: report.consoleErrorsDropped, failedAssets: report.failedAssets.length, unexpectedActions: report.actionErrors.length, expectedOfflineAssets: report.expectedOfflineAssetFailures.length, transport: players.map(player => ({ profile: player.name, count: player.transportErrors.length })) },
    coldTransfers: report.coldTransfers.map(value => ({ profile: value.profile, scope: value.scope, transferBytes: value.transferBytes, encodedBodyBytes: value.encodedBodyBytes, transferredEncodedBodyBytes: value.transferredEncodedBodyBytes, transferIsBrowserEstimate: value.transferIsBrowserEstimate, exactWireBytesMeasured: value.exactWireBytesMeasured, fixedHeaderAllowanceBytes: value.fixedHeaderAllowanceBytes, navigationEntries: value.navigationEntries, resourceEntries: value.resourceEntries, cachedRepeatCount: value.inSceneCachedRepeats.length, unavailableCount: value.zeroOrUnavailableEntries.length, excludedOriginCount: value.excludedOrigins.length, readiness: value.readiness, budget: value.budget })),
    transport: report.transport, onlineRenderers: report.onlineRenderers,
    controller: { ...report.controller, profiles: report.controller.profiles?.map(({ samples, resetObservations, ...stats }) => ({ ...stats, sampleCount: samples.length, recordedResetCount: resetObservations.length })) },
    restoreChecks: report.restoreChecks.map(({ snapshots, inputFrames, ...check }) => ({ ...check, recordedSnapshots: snapshots.length, recordedInputFrames: inputFrames.length })),
    restoreCommands: report.restoreCommands,
    uprightStallRecoveries: report.uprightStallRecoveries,
    interactionStops: report.interactionStops,
    restartChecks: report.restartChecks,
    driveStages: report.driveStages.map(({ profiles, ...stage }) => ({ ...stage, profiles: profiles.map(({ firstObservations, trajectory, ...profile }) => ({ ...profile, firstObservationCount: firstObservations.length, retainedTrajectoryCount: trajectory.length })) })),
    localDriverTraces: report.localDriverTraces.map(({ observations, keyTransitions, ...trace }) => ({ ...trace, recordedObservations: observations.length, recordedKeyTransitions: keyTransitions.length })),
    tutorialRetries: report.tutorialRetries,
    metrics: report.metrics,
    layouts: report.layouts.map(({ name, profile, width, height, scrollWidth, controls }) => ({ name, profile, width, height, scrollWidth, offscreen: controls.filter(control => control.visible && !control.inViewport) })),
    assetLoads: report.assetLoads ?? players.map(player => ({ profile: player.name, files: player.loadedAssets.size, receivedSnapshots: player.receivedFrames, sentInputFrames: player.sentInputs, socketConnections: player.socketConnections, socketCloses: player.socketCloses })),
    openCoverage: report.openCoverage, lastObserved: report.lastObserved, error: report.error, cleanupError: report.cleanupError,
    evidenceFormat: 'test-bench-browser@1 NDJSON; multipart dataFragment values concatenate in part order into the exact JSON value. Every output line is at most 8192 bytes.',
    omittedFromConsole: 'Complete resource lists and complete local-driver traces remain in the ignored local report. Bounded drive-stage trajectories, restart checks, scenario evidence, scope diagnostics, counters and build identities are emitted separately.',
  };
}

async function until(predicate, label, timeout = 10000, interval = 30) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(interval); }
  throw new Error(`Timed out: ${label}`);
}
async function scenario(name, work) {
  console.info(`[test-bench browser] ${name}`);
  const row = { name, status: 'running' }; report.scenarios.push(row);
  try { const evidence = await work(); row.status = 'passed'; if (evidence !== undefined) row.evidence = evidence; return evidence; }
  catch (error) { row.status = 'failed'; row.error = error.message; throw error; }
  finally { await emitEvidence('scenario', row); }
}
async function extendedScenario(key, name, work) {
  assert.equal(extended, true, 'Extended scenarios require IVA_BROWSER_EXTENDED=1');
  report.extendedCoverage[key].status = 'running';
  try {
    const evidence = await scenario(name, work);
    report.extendedCoverage[key] = { status: 'passed', evidence };
    return evidence;
  } catch (error) { report.extendedCoverage[key] = { ...report.extendedCoverage[key], status: 'failed', error: error.message }; throw error; }
}
async function requiredScope(id, name, work, dependencies = []) {
  const missing = dependencies.filter(key => report.scopes.find(scope => scope.id === key)?.status !== 'passed');
  const row = { id, name, status: missing.length ? 'blocked' : 'running', dependencies }; report.scopes.push(row);
  if (missing.length) {
    row.error = 'Required prerequisites did not pass: ' + missing.join(', ');
    report.requiredScopeFailures.push({ id, status: row.status, error: row.error });
    await emitEvidence('scope', row);
    return { ok: false };
  }
  console.info(`[test-bench browser scope] ${name}`);
  try {
    const value = await work(); row.status = 'passed'; return { ok: true, value };
  } catch (error) {
    row.status = 'failed'; row.error = error.stack ?? error.message;
    report.requiredScopeFailures.push({ id, status: row.status, error: error.message });
    row.failureScreens = await Promise.all(players.map(player => failureScreen(player).catch(problem => ({ profile: player.name, unavailable: problem.message }))));
    // Release only actual UI keys. The next independent scope starts through
    // normal navigation; no match state or storage is edited to recover a test.
    const released = await Promise.allSettled(players.map(player => keys(player)));
    row.inputReleaseErrors = released.flatMap((result, index) => result.status === 'rejected' ? [{ profile: players[index].name, message: String(result.reason) }] : []);
    return { ok: false };
  } finally {
    const { failureScreens, ...verdict } = row;
    await emitEvidence('scope', verdict);
    for (const screen of failureScreens ?? []) await emitEvidence('scope-screen', { scopeId: id, ...screen });
  }
}
async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise(resolve => probe.close(resolve)); return address.port;
}
async function start() {
  const child = spawn(process.execPath, [join(root, 'dist-platform/main.js')], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'development', PLATFORM_HOST: '127.0.0.1', PLATFORM_PORT: String(port),
      PORTAL_ORIGIN: origin, PLATFORM_ALLOWED_HOSTS: new URL(origin).host, PLATFORM_ALLOWED_ORIGINS: origin,
      PLATFORM_DATABASE_PATH: join(directory, 'platform.sqlite'), PLATFORM_LAB_DATABASE_PATH: join(directory, 'runtime.sqlite'),
      MAIL_MODE: 'file', MAIL_FILE_DIRECTORY: mailbox, TELEGRAM_ENABLED: 'false', TELEGRAM_AUTH_ENABLED: 'false',
      PORTAL_DIST_DIRECTORY: join(root, 'apps/portal/dist'),
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, log: '', error: null }; server = state;
  const collect = data => { state.log = (state.log + String(data)).slice(-20000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect); child.on('error', error => { state.error = error; });
  await until(async () => {
    if (state.error) throw state.error;
    assert.ok(child.exitCode === null && child.signalCode === null, `Test platform exited before readiness: ${state.log}`);
    if (!state.log.split(/\r?\n/).includes(`Iva Games platform listening on 127.0.0.1:${port}`)) return false;
    return (await http(origin + '/health/ready')).status === 200;
  }, 'isolated production platform readiness', 15000);
}
async function stop() {
  const state = server; if (!state) return; server = null;
  if (state.error) throw state.error;
  const child = state.child;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 'graceful test server shutdown', 12000); }
  catch (error) { child.kill('SIGKILL'); throw error; }
  assert.equal(child.exitCode, 0, `Test server shutdown: ${state.log}`);
}

class Account {
  cookie = ''; csrf = '';
  async request(path, body) {
    const response = await http(origin + '/api/platform/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: this.cookie, ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('iva_dev_session='));
    if (cookie) this.cookie = cookie.split(';')[0];
    const result = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${result.error?.code ?? ''}`);
    if (path === '/session') this.csrf = result.csrfToken;
    return result;
  }
  async register(handle) {
    await this.request('/session');
    const email = handle + '@example.test';
    const result = await this.request('/auth/register', { email, handle, displayName: handle, password: 'isolated browser acceptance password' });
    await this.request('/session');
    let token;
    for (const file of await readdir(mailbox)) {
      const message = await readFile(join(mailbox, file), 'utf8');
      if (!message.startsWith(`To: ${email}\n`)) continue;
      const url = message.match(/https?:\/\/[^\s]+\/verify\?token=[^\s]+/)?.[0];
      if (url) token = new URL(url).searchParams.get('token');
    }
    assert.ok(token, 'The isolated file mailbox must receive account verification');
    await this.request('/auth/verify', { token });
    assert.equal((await this.request('/session')).user.emailVerified, true);
    this.user = result.user; return this;
  }
}

function resetKeyboardPrediction(player, reason, scope = null) {
  player.steeringHistory = []; player.predictionScope = scope;
  clearPrecisionProgress(player, reason, scope);
  player.predictionStats.resets++;
  if (player.predictionStats.resetObservations.length < 40) player.predictionStats.resetObservations.push({ reason, ...(scope ?? {}) });
}

function clearPrecisionProgress(player, reason, nextScope = null) {
  player.precisionStall = null;
  const recovery = player.uprightRecovery;
  if (recovery) recovery.scopeEnd ??= { reason, observedAtMs: Date.now(), nextScope };
  player.uprightRecovery = null; player.uprightHoldUntil = 0;
  // Keep uprightKeyRecord until the real R keyup, so cancellation cannot erase
  // its actual hold duration. No application input/state is changed here.
}

function observeUprightReset(recovery, source, observation) {
  if (!recovery || observation.matchId !== recovery.matchId || !Number.isFinite(observation.resets) || observation.resets <= recovery.resetsBefore) return;
  if (recovery.resetEvidence.some(value => value.source === source)) return;
  recovery.resetEvidence.push({ source, observedAtMs: Date.now(), ...observation, resetDelta: observation.resets - recovery.resetsBefore });
  recovery.resetObserved = true;
}

function observe(player, page) {
  player.page = page; player.snapshot = null; player.receivedAt = 0;
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.browserErrors.push({ profile: player.name, message: error.message }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const observedAtMs = Date.now();
    const location = message.location();
    // Redact embedded font payloads before bounding the message, so the CSP
    // reason after a long data URL remains in the diagnostic output.
    const sanitized = omitDataUrls(message.text());
    const text = sanitized.text.slice(0, 1400);
    const scenario = report.scenarios.at(-1)?.name ?? 'setup';
    const previous = report.consoleErrors.find(value => value.profile === player.name && value.message === text && value.scenario === scenario);
    if (previous) { previous.occurrences++; previous.lastObservedAtMs = observedAtMs; return; }
    if (report.consoleErrors.length >= 30) { report.consoleErrorsDropped++; return; }
    // These are evidence for review, separate from uncaught exceptions: this
    // suite deliberately loses a WebGL context and disconnects a profile.
    const source = location.url ? location.url.startsWith('data:') ? '[data URL omitted from source]' : new URL(location.url, origin).pathname : null;
    report.consoleErrors.push({ profile: player.name, scenario, message: text, textTruncated: sanitized.text.length > 1400, ...(sanitized.omitted.length ? { omittedDataUrls: sanitized.omitted } : {}), source, line: location.lineNumber, column: location.columnNumber, occurrences: 1, firstObservedAtMs: observedAtMs, lastObservedAtMs: observedAtMs, timingMethod: 'Runner console callback receipt time; not a browser event timestamp' });
  });
  const assetPath = url => { const p = new URL(url).pathname; return !p.startsWith('/api/') && (p.startsWith('/test-bench/') || p.startsWith('/assets/')); };
  page.on('requestfailed', request => {
    const restore = player.restoreByRequest.get(request);
    if (restore) restore.networkError = request.failure()?.errorText ?? 'Request failed';
    if (assetPath(request.url()) && request.failure()?.errorText !== 'net::ERR_ABORTED') {
      const failure = { profile: player.name, path: new URL(request.url()).pathname, error: request.failure()?.errorText };
      (player.intentionalOffline ? report.expectedOfflineAssetFailures : report.failedAssets).push(failure);
    }
  });
  page.on('request', request => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/actions')) return;
    try {
      const body = request.postDataJSON();
      player.actionByRequest.set(request, { observedRequestAtMs: Date.now(), actionId: body?.actionId ?? null, expectedRevision: body?.expectedRevision ?? null, phaseId: body?.payload?.phaseId ?? null, observation: observedDriveState(player) });
      if (body?.payload?.type !== 'restore') return;
      const command = { profile: player.name, path: new URL(request.url()).pathname, observedRequestAtMs: Date.now(), actionId: body.actionId, expectedRevision: body.expectedRevision, phaseId: body.payload.phaseId, status: null };
      const recovery = player.uprightRecovery;
      if (recovery && body.payload.phaseId === recovery.phaseId && command.path.endsWith('/rooms/' + recovery.roomId + '/actions')) {
        command.uprightRecoveryId = recovery.id; recovery.commands.push(command);
      }
      report.restoreCommands.push(command); player.restoreByRequest.set(request, command);
    } catch { /* Non-JSON request evidence is handled by response/error checks. */ }
  });
  page.on('response', response => {
    if (assetPath(response.url())) { player.loadedAssets.add(new URL(response.url()).pathname); if (response.status() >= 400) report.failedAssets.push({ profile: player.name, path: new URL(response.url()).pathname, status: response.status() }); }
    if (response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/actions')) {
      const type = response.request().postDataJSON()?.payload?.type ?? 'unknown';
      report.observedGameActions[type] = (report.observedGameActions[type] ?? 0) + 1;
      if (response.status() >= 400) {
        const record = { profile: player.name, type, status: response.status(), observedResponseAtMs: Date.now(), request: player.actionByRequest.get(response.request()) ?? null, responseObservation: observedDriveState(player), errorCode: null };
        report.actionErrors.push(record);
        // Only the structured public error code is emitted, never arbitrary
        // response messages, headers, cookies or authentication data.
        const reading = response.json().then(body => {
          const code = body?.error?.code;
          record.errorCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null;
          record.errorCodeAvailable = record.errorCode !== null;
        }).catch(() => { record.errorCodeAvailable = false; }).finally(() => player.actionReceiptReads.delete(reading));
        player.actionReceiptReads.add(reading);
      }
      const restore = player.restoreByRequest.get(response.request());
      if (restore) {
        restore.status = response.status(); restore.observedResponseAtMs = Date.now();
        const reading = response.json().then(body => {
          restore.receipt = { error: body.error?.code ?? null, matchId: body.view?.matchId ?? null, phase: body.view?.phase ?? null, phaseId: body.view?.phaseId ?? null, revision: body.view?.revision ?? null, tick: body.view?.tick ?? null, resets: body.view?.you?.lane?.resets ?? null };
          const recovery = report.uprightStallRecoveries.find(value => value.id === restore.uprightRecoveryId);
          if (response.status() === 200 && !body.error) observeUprightReset(recovery, 'restore response receipt', { ...restore.receipt, actionId: restore.actionId });
        }).catch(error => { restore.receiptReadError = error.message; }).finally(() => player.actionReceiptReads.delete(reading));
        player.actionReceiptReads.add(reading);
      }
    }
  });
  page.on('websocket', socket => {
    if (!socket.url().includes('/live')) return;
    const connection = ++player.socketConnections;
    resetKeyboardPrediction(player, 'New socket connection');
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.type === 'snapshot' && frame.view?.you && connection === player.socketConnections) {
          const scope = { connection, roomId: frame.roomId, matchId: frame.matchId, epoch: frame.epoch, stage: frame.view.stage, phaseId: frame.view.phaseId, phase: frame.view.phase };
          if (!player.predictionScope || Object.keys(scope).some(key => player.predictionScope[key] !== scope[key])) resetKeyboardPrediction(player, 'Received snapshot changed controller scope', scope);
          player.snapshot = frame; player.snapshotConnection = connection; player.receivedAt = Date.now(); player.receivedFrames++;
          const recovery = report.uprightStallRecoveries.findLast(value => value.profile === player.name && value.matchId === frame.matchId && value.stage === frame.view.stage && value.participantId === frame.view.you.participantId);
          observeUprightReset(recovery, 'received public snapshot', { matchId: frame.matchId, epoch: frame.epoch, phase: frame.view.phase, phaseId: frame.view.phaseId, laneTick: frame.view.you.lane?.tick ?? null, resets: frame.view.you.lane?.resets ?? null });
          if (player.activeRestoreCheck) {
            const check = player.activeRestoreCheck;
            const observed = { observedAtMs: Date.now(), serverTime: frame.serverTime, epoch: frame.epoch, lastAcceptedSeq: frame.lastAcceptedSeq, phase: frame.view.phase, phaseId: frame.view.phaseId, stage: frame.view.stage, laneTick: frame.view.you.lane?.tick ?? null, resets: frame.view.you.lane?.resets ?? null };
            check.snapshotsObserved++; check.lastSnapshot = observed;
            if (check.snapshots.length < 40) check.snapshots.push(observed);
          }
          // Sample the exact accepted sequence, not older inputs that might have
          // been superseded before a snapshot. Both timestamps use this runner's clock.
          const sent = player.pendingInputs.get(frame.epoch + ':' + frame.lastAcceptedSeq);
          if (sent) player.ackTimings.push(performance.now() - sent.sentAt);
          for (const [key, pending] of player.pendingInputs) if (pending.epoch !== frame.epoch || pending.seq <= frame.lastAcceptedSeq) player.pendingInputs.delete(key);
        }
        if (frame.type === 'error') player.transportErrors.push(frame.code);
      } catch { player.transportErrors.push('unparseable-frame'); }
    });
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.type === 'input') {
          player.sentInputs++; player.lastSent = frame; player.lastSentAtMs = Date.now();
          if (player.activeRestoreCheck) {
            const check = player.activeRestoreCheck;
            const observed = { observedAtMs: Date.now(), seq: frame.seq, epoch: frame.epoch, phaseId: frame.payload?.phaseId, throttle: frame.payload?.throttle, steering: frame.payload?.steering, brake: frame.payload?.brake };
            check.inputFramesObserved++; check.lastInputFrame = observed;
            if (check.inputFrames.length < 40) check.inputFrames.push(observed);
          }
          const scope = player.predictionScope;
          if (scope?.connection === connection && scope.matchId === frame.matchId && scope.epoch === frame.epoch && scope.phase === 'racing' && scope.phaseId === frame.payload?.phaseId && Number.isFinite(frame.payload?.steering)) {
            // This is an observation of a frame the application really sent,
            // never a synthetic input frame or a mutation of gameplay state.
            player.steeringHistory.push({ due: Date.now() + latencyMs, steering: frame.payload.steering });
            if (player.steeringHistory.length > 30) player.steeringHistory.shift();
            player.predictionStats.historyFrames++;
          }
          if (player.neutralObservation?.matchId === frame.matchId) {
            const observation = player.neutralObservation; observation.count++;
            const input = frame.payload;
            if (input.throttle !== 0 || input.steering !== 0) {
              observation.violationCount++;
              if (observation.violations.length < 10) observation.violations.push({ seq: frame.seq, throttle: input.throttle, steering: input.steering, brake: input.brake });
            }
          }
          player.pendingInputs.set(frame.epoch + ':' + frame.seq, { epoch: frame.epoch, seq: frame.seq, sentAt: performance.now() });
          while (player.pendingInputs.size > 300) player.pendingInputs.delete(player.pendingInputs.keys().next().value);
        }
      } catch { /* Other browser frames are not game input. */ }
    });
    socket.on('close', () => {
      player.socketCloses++;
      if (connection === player.socketConnections) resetKeyboardPrediction(player, 'Current socket closed');
    });
  });
}
async function makePlayer(account, name, locale, hasTouch = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch });
  await context.addInitScript(() => performance.setResourceTimingBufferSize(2000));
  const separator = account.cookie.indexOf('=');
  await context.addCookies([{ name: account.cookie.slice(0, separator), value: account.cookie.slice(separator + 1), url: origin }]);
  const player = { account, name, locale, context, held: new Set(), loadedAssets: new Set(), pendingInputs: new Map(), ackTimings: [], socketConnections: 0, socketCloses: 0, receivedFrames: 0, sentInputs: 0, transportErrors: [], snapshot: null, lastInteract: 0, lastRestore: 0, interactionStop: null, driveRemainder: { throttle: 0, steering: 0 }, steeringHistory: [], predictionScope: null, precisionStall: null, uprightRecovery: null, uprightHoldUntil: 0, uprightKeyRecord: null, predictionStats: { calls: 0, historyFrames: 0, resets: 0, resetObservations: [], horizons: [], samples: [] }, restoreByRequest: new WeakMap(), actionByRequest: new WeakMap(), actionReceiptReads: new Set() };
  observe(player, await context.newPage()); players.push(player); return player;
}
const label = (player, ru, en) => player.locale === 'ru' ? ru : en;
const view = player => player.snapshot?.view;
const fresh = player => player.snapshot && Date.now() - player.receivedAt < 1200;
async function waitView(player, predicate, description, timeout = 12000) {
  return until(() => fresh(player) && predicate(view(player)) && view(player), description, timeout);
}
async function keys(player, wanted = []) {
  const next = new Set(wanted);
  const transition = async (key, direction) => {
    const dispatchedAtMs = Date.now();
    const recovery = key === 'KeyR' ? player.uprightKeyRecord : null;
    if (recovery) recovery[direction === 'down' ? 'keyDownDispatchedAtMs' : 'keyUpDispatchedAtMs'] = dispatchedAtMs;
    await player.page.keyboard[direction](key); report.controls.keyboardEvents++;
    if (recovery) {
      recovery[direction === 'down' ? 'keyDownAcknowledgedAtMs' : 'keyUpAcknowledgedAtMs'] = Date.now();
      if (direction === 'up') {
        recovery.holdAfterKeydownAckMs = Number.isFinite(recovery.keyDownAcknowledgedAtMs) ? dispatchedAtMs - recovery.keyDownAcknowledgedAtMs : null;
        if (player.uprightKeyRecord === recovery) player.uprightKeyRecord = null;
      }
    }
    if (player.localKeyTrace) {
      const trace = player.localKeyTrace;
      trace.keyTransitionCount++;
      if (trace.keyTransitions.length < 2000) trace.keyTransitions.push({ key, direction, dispatchedAtMs, acknowledgedAtMs: Date.now() });
      else trace.droppedKeyTransitions++;
    }
  };
  for (const key of player.held) if (!next.has(key)) await transition(key, 'up');
  for (const key of next) if (!player.held.has(key)) await transition(key, 'down');
  player.held = next;
}
async function focusLane(player) {
  await player.page.locator('.tb-scene-canvas').click({ position: { x: 20, y: 120 } });
}
async function action(player, locator, type, activation = 'click') {
  await expect(locator).toBeEnabled();
  const pending = player.page.waitForResponse(response => {
    if (response.request().method() !== 'POST' || !response.url().endsWith('/actions')) return false;
    try { return response.request().postDataJSON()?.payload?.type === type; } catch { return false; }
  });
  if (activation === 'Space') { await keys(player); await locator.focus(); await locator.press('Space'); report.controls.keyboardEvents += 2; }
  else await locator.click();
  const response = await pending; const body = await response.json();
  assert.equal(response.status(), 200, `UI ${type}: ${body.error?.code ?? 'HTTP failure'}`);
  report.controls.acceptedUiActions++;
  if (body.view) await waitView(player, current => current.matchId === body.view.matchId && current.revision >= body.view.revision, `snapshot confirms ${type}`);
  return body.view;
}
async function roomAction(player, locator, endpoint, activation = 'click') {
  let result; let metadata; let keyboardActivation;
  const previousUrl = player.page.url();
  // /rooms can destroy its document immediately after the client consumes the
  // response. Metadata survives; a CDP body read still races that navigation.
  const pending = player.page.waitForResponse(async response => {
    const url = new URL(response.url());
    if (response.request().method() !== 'POST' || url.origin !== origin || !url.pathname.startsWith('/api/platform/v1/') || !url.pathname.endsWith(endpoint)) return false;
    metadata = { profile: player.name, path: url.pathname, method: response.request().method(), status: response.status() };
    report.roomResponses.push(metadata);
    assert.equal(response.status(), 200, `${endpoint}: HTTP ${response.status()}`);
    if (endpoint !== '/rooms') result = await response.json();
    return true;
  });
  const activate = async () => {
    if (activation !== 'Space') { await locator.click(); return; }
    keyboardActivation = { profile: player.name, endpoint, key: 'Space', status: 'waiting for enabled and focused control', startedAtMs: Date.now() };
    report.roomKeyboardActivations.push(keyboardActivation);
    await expect(locator).toBeEnabled();
    await locator.focus(); await expect(locator).toBeFocused();
    const element = await locator.elementHandle(); assert.ok(element);
    const inspectControl = () => element.evaluate(button => ({ capturedAtMs: Date.now(), connected: button.isConnected, enabled: !button.matches(':disabled'), focused: document.activeElement === button, label: button.textContent?.trim().slice(0,160) ?? '', documentFocused: document.hasFocus(), visibility: document.visibilityState }));
    try {
      keyboardActivation.beforeDispatch = await inspectControl();
      keyboardActivation.dispatchedAtMs = Date.now();
      await locator.press('Space'); report.controls.keyboardEvents += 2;
      keyboardActivation.acknowledgedAtMs = Date.now(); keyboardActivation.status = 'key dispatched';
    } finally {
      // Keep the same DOM element handle: a successful ready action changes
      // its accessible name, so the original name locator may no longer match.
      keyboardActivation.afterDispatch = await inspectControl().catch(error => ({ unavailable: error.message }));
      await element.dispose();
    }
  };
  try {
    await Promise.all([pending, activate()]);
    if (endpoint === '/rooms') {
      await player.page.waitForURL(url => url.origin === origin && /^\/rooms\/[^/]+$/.test(url.pathname) && url.href !== previousUrl, { waitUntil: 'commit' });
      const roomId = decodeURIComponent(new URL(player.page.url()).pathname.split('/').at(-1));
      // Observe the room reached by the real UI. This GET never creates a room,
      // replays its POST, issues gameplay commands or changes application state.
      result = await player.account.request('/rooms/' + encodeURIComponent(roomId));
      assert.equal(result.room.roomId, roomId); assert.equal(result.room.gameId, 'test-bench');
      metadata.navigationPath = new URL(player.page.url()).pathname; metadata.followup = 'Read-only GET of the room reached by UI navigation';
    }
    if (keyboardActivation) { keyboardActivation.status = 'response confirmed'; keyboardActivation.responseStatus = metadata.status; }
    report.controls.acceptedUiActions++; return result;
  } catch (error) {
    if (keyboardActivation) { keyboardActivation.status = 'failed'; keyboardActivation.error = error.message; }
    throw error;
  } finally {
    if (keyboardActivation) await emitEvidence('room-keyboard-activation', keyboardActivation);
  }
}
async function inspect(player, name, { race = false, low = false } = {}) {
  const page = player.page;
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, controls: [...document.querySelectorAll('.tb-drive-actions button,.tb-pause,.tb-local-footer button,.tb-pedals button')].map(button => { const r = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label') ?? button.textContent?.trim(), visible: r.width > 0 && r.height > 0, inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; }) }));
  report.layouts.push({ profile: player.name, name, ...layout });
  assert.ok(layout.scrollWidth <= layout.width + 1, `${name}: horizontal overflow`);
  if (race) assert.deepEqual(layout.controls.filter(control => control.visible && !control.inViewport), [], `${name}: race controls outside viewport`);
  const canvas = page.locator('.tb-scene-canvas').first();
  if (await canvas.count()) {
    if (await canvas.getAttribute('data-renderer') === '3d') await page.waitForFunction(() => Number(document.querySelector('.tb-scene-canvas')?.getAttribute('data-draw-calls')) > 0);
    const metrics = await canvas.evaluate(node => {
      const box = node.getBoundingClientRect();
      const bufferWidth = Number(node.dataset.bufferWidth), bufferHeight = Number(node.dataset.bufferHeight);
      return { renderer: node.dataset.renderer, quality: node.dataset.quality, engine: node.dataset.engine, participantPaint: node.closest('.tb-scene')?.getAttribute('data-participant-paint'), drawCalls: Number(node.dataset.drawCalls || 0), frameP95Ms: Number(node.dataset.frameP95 || 0), cssWidth: box.width, cssHeight: box.height, bufferWidth, bufferHeight, bufferPixels: bufferWidth * bufferHeight, pixelRatio: Number(node.dataset.pixelRatio), bufferPixelLimit: node.dataset.bufferPixelLimit === 'none' ? null : Number(node.dataset.bufferPixelLimit), canvasWidth: node.width, canvasHeight: node.height, sizeMethod: 'CSS bounding rectangle; actual WebGL drawing buffer or Canvas2D backing buffer; renderer pixel ratio' };
    });
    report.metrics.push({ profile: player.name, name, ...metrics });
    assert.ok(metrics.cssWidth >= 100 && metrics.cssHeight >= 100, `${name}: collapsed scene`);
    assert.ok(metrics.bufferWidth > 0 && metrics.bufferHeight > 0 && metrics.pixelRatio > 0, `${name}: actual render buffer metrics must be available`);
    if (low && metrics.renderer === '3d') {
      assert.ok(metrics.drawCalls <= 150, `${name}: ${metrics.drawCalls} low-quality draw calls exceeds target`);
      assert.ok(metrics.bufferPixels <= 230400 && metrics.pixelRatio <= 1.25, `${name}: low-quality drawing buffer exceeds the controlled 230400-pixel / 1.25-DPR cap`);
    }
  }
  await page.screenshot({ path: join(output, `${player.name}-${name}.png`), fullPage: false });
}

async function failureScreen(player) {
  const page = player.page;
  const local = await page.locator('.tb-race').count().then(count => count ? localHud(player) : null).catch(() => null);
  const dialog = page.locator('dialog[open]').first();
  const hasDialog = await dialog.count().catch(() => 0);
  const scope = hasDialog ? dialog : page.locator('body');
  const [visibleText, accessibility] = await Promise.all([
    scope.innerText({ timeout: 2000 }).catch(error => `Unavailable: ${error.message}`),
    scope.ariaSnapshot({ timeout: 2000 }).catch(error => `Unavailable: ${error.message}`),
  ]);
  return {
    profile: player.name, path: new URL(page.url()).pathname, scope: hasDialog ? 'open dialog' : 'body', localHud: local,
    visibleText: visibleText.slice(0, 1800), visibleTextTruncated: visibleText.length > 1800,
    accessibility: accessibility.slice(0, 4200), accessibilityTruncated: accessibility.length > 4200,
  };
}

async function measureColdTransfer(player) {
  const page = player.page;
  const readiness = { scene: false, fonts: false, networkIdle: false, errors: [] };
  try {
    await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 30000 });
    readiness.fonts = true;
  } catch (error) { readiness.errors.push({ check: 'fonts', message: error.message.slice(0, 500) }); }
  try {
    const required = ['chassis', 'axle-offroad', 'motor-economy', 'battery-small', 'cargo-cradle', 'aux-damper', 'aux-rollbar'];
    await until(() => required.every(id => player.loadedAssets.has('/test-bench/models/' + id + '.glb')), 'initial home carrier exported models loaded', 30000);
    await page.waitForFunction(() => !document.querySelector('.tb-scene-loading') && Number(document.querySelector('canvas.tb-scene-canvas')?.getAttribute('data-draw-calls')) > 0, undefined, { timeout: 30000 });
    readiness.scene = true;
  } catch (error) { readiness.errors.push({ check: 'scene', message: error.message.slice(0, 500) }); }
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); readiness.networkIdle = true; }
  catch (error) { readiness.errors.push({ check: 'network idle', message: error.message.slice(0, 500) }); }
  const measured = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource');
    const navigation = performance.getEntriesByType('navigation');
    const entries = [...navigation, ...resources].map(entry => {
      const url = new URL(entry.name, location.href);
      return { urlKey: url.protocol === 'data:' ? '[data URL omitted]' : url.origin + url.pathname + url.search, path: url.protocol === 'data:' ? '[data URL omitted]' : url.pathname, origin: url.origin, entryType: entry.entryType, initiatorType: entry.initiatorType, transferSize: entry.transferSize ?? null, encodedBodySize: entry.encodedBodySize ?? null, decodedBodySize: entry.decodedBodySize ?? null, deliveryType: entry.deliveryType ?? null, responseStatus: entry.responseStatus ?? null, startTimeMs: entry.startTime, responseEndMs: entry.responseEnd, durationMs: Math.round(entry.duration * 10) / 10 };
    });
    return { origin: location.origin, path: location.pathname, navigationEntries: navigation.length, resourceEntries: resources.length, documentReadyState: document.readyState, fontStatus: document.fonts.status, fontErrors: [...document.fonts].filter(font => font.status === 'error').map(font => ({ family: font.family, style: font.style, weight: font.weight })), entries, capturedAtMs: Math.round(performance.now()) };
  });
  const sameOrigin = measured.entries.filter(entry => entry.origin === measured.origin).sort((a, b) => a.responseEndMs - b.responseEndMs);
  const excluded = measured.entries.filter(entry => entry.origin !== measured.origin);
  const positive = new Map(); const cachedRepeats = []; const unavailable = [];
  for (const entry of sameOrigin) {
    if (Number.isFinite(entry.transferSize) && entry.transferSize > 0 && Number.isFinite(entry.encodedBodySize) && entry.encodedBodySize > 0) {
      entry.transferClassification = 'network estimate'; positive.set(entry.urlKey, entry);
    } else if (entry.transferSize === 0 && entry.encodedBodySize > 0 && positive.get(entry.urlKey)?.encodedBodySize === entry.encodedBodySize) {
      entry.transferClassification = 'in-scene cached repeat of an earlier measured URL'; cachedRepeats.push(entry);
    } else { entry.transferClassification = 'incomplete or unestablished cache source'; unavailable.push(entry); }
  }
  const record = {
    profile: player.name, context: 'Fresh independent browser context, first home navigation, before settings/reloads/catalog',
    scope: 'All same-origin navigation and resource timing entries, including portal scripts, game assets, fonts and API requests',
    ...measured, entries: sameOrigin, excludedOrigins: excluded,
    readiness, transferBytes: sameOrigin.reduce((sum, entry) => sum + (entry.transferSize ?? 0), 0),
    transferIsBrowserEstimate: true, exactWireBytesMeasured: false, fixedHeaderAllowanceBytes: 300,
    measurementReference: 'https://www.w3.org/TR/resource-timing/#dom-performanceresourcetiming-transfersize',
    encodedBodyBytes: sameOrigin.reduce((sum, entry) => sum + (entry.encodedBodySize ?? 0), 0),
    encodedBodyBytesIncludesCachedRepeats: true,
    transferredEncodedBodyBytes: sameOrigin.filter(entry => entry.transferSize > 0).reduce((sum, entry) => sum + (entry.encodedBodySize ?? 0), 0),
    inSceneCachedRepeats: cachedRepeats, zeroOrUnavailableEntries: unavailable,
    resourceTimingBufferLimit: 2000, timingBufferPossiblyFull: measured.resourceEntries >= 2000,
  };
  const reliable = readiness.scene && readiness.fonts && readiness.networkIdle && measured.documentReadyState === 'complete' && measured.navigationEntries === 1 && measured.fontErrors.length === 0 && unavailable.length === 0 && excluded.length === 0 && measured.resourceEntries < 2000 && !report.failedAssets.some(asset => asset.profile === player.name);
  record.budget = { limitBytes: 6000000, reliableCompleteMeasurement: reliable, passed: reliable ? record.transferBytes <= 6000000 : null, note: reliable ? 'Complete browser cold-transfer estimate with the specified fixed 300-byte header allowance, not exact wire bytes; 6 MB decimal limit. Proven in-scene cached repeats add zero network transfer.' : 'Required measurement fails: unavailable timings, unestablished cache sources, readiness, omitted origins, buffer capacity or failed resources prevent a complete estimate and valid budget comparison. Asset-bank size is never substituted.' };
  report.coldTransfers.push(record);
  assert.ok(reliable, `${player.name}: the required complete cold-transfer estimate is unavailable; see recorded readiness and timing gaps`);
  assert.ok(record.budget.passed, `${player.name}: complete browser cold-transfer estimate ${record.transferBytes} exceeds 6,000,000 bytes`);
  return record.budget;
}

async function nodePathCalibration() {
  const publicUrl = new URL(origin);
  assert.equal(publicUrl.protocol, 'http:'); assert.equal(publicUrl.hostname, '127.0.0.1'); assert.ok(publicUrl.port);
  const result = { method: 'Node http.request plus body completion against the same isolated platform, before browser launch; explicit public Host is preserved', hostHeader: publicUrl.host, configuredPerDirectionMs: latencyMs, pureNetworkRtt: false, requests: [], directBackend: null, configuredPublicPath: null };
  report.transport.nodeCalibration = result;
  const sample = async url => {
    const target = new URL('/health/ready', url);
    assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1'); assert.ok([String(port), publicUrl.port].includes(target.port));
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const began = performance.now();
      const response = await new Promise((resolve, reject) => {
        const request = httpRequest(target, { method: 'GET', headers: { Host: publicUrl.host, 'Cache-Control': 'no-store' } }, response => {
          let bodyBytes = 0;
          response.on('data', chunk => { bodyBytes += chunk.length; });
          response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, bodyBytes }));
        });
        request.setTimeout(8000, () => request.destroy(new Error('Node calibration request timed out')));
        request.on('error', reject); request.end();
      });
      const durationMs = performance.now() - began;
      result.requests.push({ targetPort: target.port, hostHeader: publicUrl.host, ...response, durationMs: Math.round(durationMs * 10) / 10 });
      assert.equal(response.status, 200); samples.push(durationMs);
    }
    return { samplesMs: samples.map(value => Math.round(value * 10) / 10), ...timing(samples) };
  };
  result.directBackend = await sample(`http://127.0.0.1:${port}`); result.configuredPublicPath = await sample(origin); return result;
}

async function browserPathProbe(player) {
  const samples = await player.page.evaluate(async () => {
    const result = [];
    for (let i = 0; i < 5; i++) {
      const url = new URL('/health/ready?bench_timing=' + crypto.randomUUID(), location.origin).href;
      const started = performance.now();
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('Readiness request failed');
      await response.arrayBuffer(); const javascriptCompletionMs = performance.now() - started;
      // Resource entries are published asynchronously after response completion.
      await new Promise(resolve => setTimeout(resolve, 0));
      const entry = performance.getEntriesByName(url, 'resource').at(-1);
      result.push({ javascriptCompletionMs, requestStart: entry?.requestStart ?? null, responseStart: entry?.responseStart ?? null, responseEnd: entry?.responseEnd ?? null, transferSize: entry?.transferSize ?? null, encodedBodySize: entry?.encodedBodySize ?? null, responseStatus: entry?.responseStatus ?? null, networkServerBodyMs: entry && entry.requestStart > 0 && entry.responseEnd >= entry.requestStart ? entry.responseEnd - entry.requestStart : null });
    }
    return result;
  });
  const valid = samples.filter(sample => Number.isFinite(sample.networkServerBodyMs) && sample.transferSize > 0 && sample.encodedBodySize > 0);
  const result = {
    profile: player.name, renderer: await player.page.locator('canvas.tb-scene-canvas').getAttribute('data-renderer'),
    method: 'Resource Timing responseEnd minus requestStart; includes network, server and response body transfer. An RTT proxy, not exact pure network RTT.',
    reference: 'https://www.w3.org/TR/resource-timing/', samples,
    networkServerBodyMs: timing(valid.map(sample => sample.networkServerBodyMs)),
    javascriptFetchBodyCompletionMs: timing(samples.map(sample => sample.javascriptCompletionMs)),
    unavailableNetworkSamples: samples.length - valid.length,
  };
  report.transport.browserPathProbe = result;
  assert.equal(valid.length, 5, 'All five browser probes require genuine same-origin network timing and body measurements');
  if (latencyMs >= 50 && latencyMs <= 100) assert.ok(result.networkServerBodyMs.p50 >= 100 && result.networkServerBodyMs.p50 <= 200, 'The browser-measured network/server/body RTT proxy must be within 100–200 ms; JavaScript completion is reported separately');
  return result;
}

async function settings(player, { locale = player.locale, renderer = '3d', quality = 'low', exhaustive = false, normalize = false } = {}) {
  const page = player.page;
  await page.getByRole('button', { name: label(player, 'Настройки', 'Settings'), exact: true }).click();
  let dialog = page.locator('dialog[open]');
  if (locale !== player.locale) { await dialog.getByLabel(label(player, 'Язык', 'Language'), { exact: true }).selectOption(locale); player.locale = locale; }
  await dialog.getByLabel(label(player, 'Вид', 'View'), { exact: true }).selectOption(renderer);
  await dialog.getByLabel(label(player, 'Качество', 'Quality'), { exact: true }).selectOption(quality);
  if (normalize) {
    await dialog.getByLabel(label(player, 'Размер текста', 'Text size'), { exact: true }).selectOption('100');
    await dialog.getByLabel(label(player, 'Уменьшить движение', 'Reduce motion'), { exact: true }).uncheck();
    await dialog.getByLabel(label(player, 'Пыль и брызги', 'Dust and spray'), { exact: true }).check();
    await dialog.getByRole('button', { name: label(player, 'Сбросить клавиши', 'Reset keys') }).click();
  }
  if (exhaustive) {
    await dialog.getByLabel(label(player, 'Размер текста', 'Text size'), { exact: true }).selectOption('130');
    await expect(dialog.getByLabel(label(player, 'Размер текста', 'Text size'), { exact: true })).toHaveValue('130');
    await dialog.getByLabel(label(player, 'Уменьшить движение', 'Reduce motion'), { exact: true }).check();
    await dialog.getByLabel(label(player, 'Пыль и брызги', 'Dust and spray'), { exact: true }).uncheck();
    const sound = dialog.locator('input[type=range]').first(); await sound.focus(); await sound.press('Home'); await sound.press('ArrowRight');
    await expect(sound).toHaveValue('0.05');
    const music = dialog.locator('input[type=range]').nth(1); await music.focus(); await music.press('Home'); await expect(music).toHaveValue('0');
    const bind = dialog.locator('.tb-bindings button').first(); await bind.click(); await bind.press('KeyA');
    await expect(dialog.getByRole('alert')).toContainText(label(player, 'уже занята', 'already assigned'));
    await bind.press('KeyZ'); await expect(bind.locator('kbd')).toHaveText('Z');
    await dialog.getByRole('button', { name: label(player, 'Сбросить клавиши', 'Reset keys') }).click(); await expect(bind.locator('kbd')).toHaveText('W');
    await dialog.getByRole('button', { name: label(player, 'Готово', 'Done'), exact: true }).click();
    await inspect(player, 'settings-130-text');
    await page.getByRole('button', { name: label(player, 'Настройки', 'Settings'), exact: true }).click(); dialog = page.locator('dialog[open]');
    await dialog.getByLabel(label(player, 'Размер текста', 'Text size'), { exact: true }).selectOption('100');
    await dialog.getByLabel(label(player, 'Уменьшить движение', 'Reduce motion'), { exact: true }).uncheck();
    await dialog.getByLabel(label(player, 'Пыль и брызги', 'Dust and spray'), { exact: true }).check();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  } else await dialog.getByRole('button', { name: label(player, 'Готово', 'Done'), exact: true }).click();
  await expect(page.locator('canvas.tb-scene-canvas')).toHaveAttribute('data-renderer', renderer);
}

async function prepareProfile(player, locale, renderer) {
  await keys(player); await player.page.setViewportSize({ width: 1440, height: 900 });
  await player.page.goto(origin + '/games/test-bench');
  const actualLocale = await player.page.locator('main.tb-app').getAttribute('lang');
  assert.ok(['ru', 'en'].includes(actualLocale), 'The visible page must identify its current locale'); player.locale = actualLocale;
  await settings(player, { locale, renderer, quality: 'low', normalize: true });
  return { profile: player.name, locale: player.locale, renderer: await player.page.locator('canvas.tb-scene-canvas').getAttribute('data-renderer'), configuredThroughUi: true };
}

async function selectPart(player, slot, part, online = true, expectError) {
  const page = player.page;
  await page.locator('.tb-slot-nav button').filter({ hasText: policy.SLOT_NAMES[slot][player.locale] }).click();
  const button = part ? page.locator('.tb-parts button').filter({ hasText: policy.PARTS[part].name[player.locale] }) : page.locator('.tb-parts').getByRole('button', { name: label(player, 'Снять деталь', 'Remove part'), exact: true });
  if (expectError) {
    const before = view(player)?.you.build;
    await button.click(); await expect(page.locator('.tb-builder-strip [role=alert]')).toContainText(expectError);
    if (online) { await delay(130); assert.deepEqual(view(player).you.build, before, 'A rejected UI build must preserve its confirmed blueprint'); }
  } else if (online) await action(player, button, 'blueprint'); else await button.click();
}
async function preset(player, id, online = true) {
  const button = player.page.locator('.tb-presets button').filter({ hasText: policy.PRESET_NAMES[id][player.locale] });
  if (online) await action(player, button, 'blueprint'); else await button.click();
}

async function localHud(player) {
  return player.page.locator('.tb-race').evaluate(node => {
    const transform = node.querySelector('.tb-track-map g[transform]')?.getAttribute('transform') ?? '';
    const match = /translate\(([-\d.e+]+)[,\s]+([-\d.e+]+)\)/.exec(transform);
    const cargo = [...node.querySelectorAll('.tb-cargo-slot')].map((capsule, index) => {
      const healthText = capsule.querySelector('strong')?.textContent?.trim() ?? '';
      const status = ['at-dock', 'secured', 'loose', 'broken', 'deposited'].find(value => capsule.classList.contains(value)) ?? null;
      const health = status === 'broken' || healthText === '×' ? 0
        : status === 'at-dock' || status === 'deposited' ? null
        : /^\d+(\.\d+)?$/.test(healthText) ? Number(healthText) : null;
      return { index, status, health, className: capsule.className };
    });
    return { x: match ? (Number(match[1]) - 50) / 9 : null, z: match ? (250 - Number(match[2])) / 4.8 : null, speed: Number(node.querySelector('.tb-speed b')?.textContent), charge: Number(node.querySelector('.tb-energy b')?.textContent), timer: node.querySelector('.tb-race-timer strong')?.textContent, health: cargo[0]?.health ?? null, cargoStatus: cargo[0]?.className, cargo, interaction: node.querySelector('.tb-interact')?.textContent, canInteract: !node.querySelector('.tb-interact')?.hasAttribute('disabled'), next: !!node.querySelector('.tb-race-lesson .tb-primary'), lessonTitle: node.querySelector('.tb-race-lesson h2')?.textContent, lessonStep: node.querySelector('.tb-race-lesson .tb-eyebrow')?.textContent, attemptStatus: node.querySelector('.tb-race-lesson')?.getAttribute('data-attempt-status') ?? null, lessonFeedback: node.querySelector('.tb-race-lesson [role=status]')?.textContent ?? null, result: !!node.querySelector('.tb-run-result') };
  });
}
async function stableLessonMilestone(player, name, expectedStatus = 'complete') {
  const before = await localHud(player);
  assert.equal(before.attemptStatus, expectedStatus, `${name}: the visible lesson outcome must match`);
  assert.equal(before.next, expectedStatus === 'complete', `${name}: only a successful comparison exposes Continue`);
  await delay(400);
  const after = await localHud(player);
  const state = hud => ({ x: hud.x, z: hud.z, speed: hud.speed, charge: hud.charge, timer: hud.timer, health: hud.health, cargoStatus: hud.cargoStatus, next: hud.next, attemptStatus: hud.attemptStatus, lessonStep: hud.lessonStep, lessonFeedback: hud.lessonFeedback });
  assert.deepEqual(state(after), state(before), `${name}: the frozen comparison must preserve its clock, cargo and physics`);
  return after;
}
async function localDriveTo(player, target, speed = 2.2, extra = () => false, timeout = 30000, trace) {
  await focusLane(player); const deadline = Date.now() + timeout;
  let priorDecisionAt = null;
  const observeDecision = (hud, wanted, done) => {
    if (!trace) return;
    const atMs = Date.now(); trace.observationCount++;
    if (trace.observations.length < 1000) trace.observations.push({ atMs, intervalMs: priorDecisionAt === null ? null : atMs - priorDecisionAt, x: hud.x, z: hud.z, speed: hud.speed, health: hud.health, cargoStatus: hud.cargoStatus, timer: hud.timer, next: hud.next, attemptStatus: hud.attemptStatus, wanted, done });
    else trace.droppedObservations++;
    priorDecisionAt = atMs;
  };
  while (Date.now() < deadline) {
    const hud = await localHud(player); assert.notEqual(hud.z, null, 'Visible minimap position is required for the local UI driver');
    if (await extra(hud) || hud.z >= target - .35 && hud.speed <= .35) { observeDecision(hud, ['Space'], true); await keys(player, ['Space']); return hud; }
    const desired = Math.min(speed, Math.max(0, (target - hud.z - .25) * 1.0));
    const wanted = hud.speed > desired + .12 || desired < .1 ? ['Space'] : hud.speed < desired ? ['KeyW'] : [];
    observeDecision(hud, wanted, false); await keys(player, wanted);
    await delay(45);
  }
  await keys(player); throw new Error(`Local keyboard driver did not reach ${target} m: ${JSON.stringify(await localHud(player))}`);
}

async function approachLoadingDock(player) {
  await focusLane(player);
  let brakingSince = null;
  const hud = await until(async () => {
    const observed = await localHud(player);
    assert.ok(Number.isFinite(observed.z) && Number.isFinite(observed.speed), 'Dock approach requires visible minimap coordinates and rounded HUD speed');
    assert.equal(observed.result, false, 'Dock approach must finish within the real local trial deadline');
    const load = observed.canInteract && observed.interaction?.includes(label(player, 'Загрузить груз', 'Load cargo'));
    const slowDown = observed.interaction?.includes(label(player, 'Остановись для погрузки', 'Stop to load'));
    const brake = load || slowDown || observed.speed > .7;
    await keys(player, brake ? ['Space'] : [observed.z < 3.12 ? 'KeyW' : 'KeyS']);
    if (!brake) brakingSince = null;
    else brakingSince ??= performance.now();
    // Wall time alone is insufficient on a software renderer: re-read the
    // real enabled loading control and low HUD speed after holding the brake.
    if (load && observed.speed <= .3 && brakingSince !== null && performance.now() - brakingSince >= 400) {
      const fresh = await localHud(player);
      if (fresh.canInteract && fresh.interaction?.includes(label(player, 'Загрузить груз', 'Load cargo')) && fresh.speed <= .3) return fresh;
    }
    return false;
  }, 'enabled Load cargo control after at least 400 ms braking and a fresh visible speed at most 0.3 m/s', 40000, 100);
  return hud;
}

async function restartPractice(player) {
  await keys(player);
  const before = await localHud(player);
  await player.page.locator('.tb-local-footer').getByRole('button', { name: new RegExp(label(player, 'Начать заново', 'Restart')) }).click();
  const after = await until(async () => {
    const hud = await localHud(player);
    return Number.isFinite(hud.z) && hud.z < 1 && hud.speed <= .1 && !hud.result && hud.cargo.length === 3 && hud.cargo.every(cargo => cargo.status === 'at-dock') && hud;
  }, 'Restart creates a fresh stationary practice lane with three docked capsules');
  return { method: 'Actual Restart button after releasing all keyboard controls', before, after };
}

async function practiceChecks(alice, bob) {
  await scenario('Every catalog part can be selected on a legal practice build', async () => {
    await alice.page.goto(origin + '/games/test-bench?mode=practice'); await expect(alice.page.locator('.tb-builder')).toBeVisible();
    const chosen = [];
    for (const slot of Object.keys(policy.SLOT_NAMES)) {
      await preset(alice, 'universal', false);
      for (const part of Object.values(policy.PARTS).filter(value => value.slots.includes(slot))) {
        await selectPart(alice, slot, part.id, false);
        const button = alice.page.locator('.tb-parts button').filter({ hasText: part.name.ru });
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await expect(alice.page.locator('.tb-part-description strong')).toHaveText(part.name.ru);
        chosen.push({ slot, part: part.id });
      }
      if (slot.startsWith('aux-')) {
        await alice.page.locator('.tb-parts').getByRole('button', { name: 'Снять деталь', exact: true }).click();
        await expect(alice.page.locator('.tb-parts').getByRole('button', { name: 'Снять деталь', exact: true })).toBeDisabled();
      }
    }
    await preset(alice, 'universal', false);
    await selectPart(alice, 'aux-left', 'ballast', false);
    await alice.page.getByRole('button', { name: /Поменять модули местами/ }).click();
    await expect(alice.page.locator('.tb-slot-nav button').filter({ hasText: 'Правое крепление' })).toContainText('Балласт');
    return { selectedCombinations: chosen, auxiliaryRemoval: true, swap: true, actualRenderInspection: false };
  });
  await scenario('Practice pause, keyboard button activation, two loaded assemblies and WebGL fallback', async () => {
    const page = alice.page;
    await page.goto(origin + '/games/test-bench?mode=practice');
    await expect(page.locator('.tb-builder')).toBeVisible();
    await preset(alice, 'universal', false);
    await page.getByRole('button', { name: /Повернуть/ }).click();
    const top = page.getByRole('button', { name: 'Сверху', exact: true });
    await top.click(); await expect(top).toHaveAttribute('aria-pressed', 'true');
    await top.click();
    const starts = [];
    for (const presetId of ['universal', 'gentle']) {
      let resetAfterFault = null;
      await preset(alice, presetId, false);
      await page.getByRole('button', { name: /Проверить/ }).click();
      await expect(page.locator('.tb-race')).toBeVisible();
      if (presetId === 'universal') {
        await focusLane(alice); await keys(alice, ['KeyW']); await delay(350); await keys(alice);
        const pause = page.locator('.tb-pause'); await pause.focus(); await pause.press('Space');
        await expect(page.locator('.tb-race')).toHaveClass(/paused/);
        const before = await localHud(alice); await delay(400); const after = await localHud(alice);
        assert.deepEqual({ z: after.z, charge: after.charge, timer: after.timer }, { z: before.z, charge: before.charge, timer: before.timer }, 'Paused practice must not advance physics/timer/charge');
        await pause.press('Space'); await expect(page.locator('.tb-race')).not.toHaveClass(/paused/);
        const lost = await page.locator('canvas.tb-scene-canvas').evaluate(canvas => {
          const context = canvas.getContext('webgl2'); const extension = context?.getExtension('WEBGL_lose_context');
          if (!extension) return false; extension.loseContext(); return true;
        });
        assert.equal(lost, true, 'The production 3D canvas must expose context-loss testing');
        await expect(page.locator('canvas.tb-scene-canvas')).toHaveAttribute('data-renderer', '2d');
        const fallback = await localHud(alice); assert.ok(fallback.z >= before.z - .05, 'Renderer fallback must preserve the lane');
        await page.getByRole('button', { name: 'Вернуть 3D', exact: true }).click();
        await expect(page.locator('canvas.tb-scene-canvas')).toHaveAttribute('data-renderer', '3d');
        resetAfterFault = await restartPractice(alice);
      }
      const dock = await approachLoadingDock(alice);
      await keys(alice); await expect(page.locator('.tb-interact')).toBeEnabled(); await page.locator('.tb-interact').click();
      const loaded = await until(async () => { const hud = await localHud(alice); return hud.cargo.length === 3 && hud.cargo.every(cargo => cargo.status === 'secured' && cargo.health > 0) && hud; }, 'all three capsules are secured before the same-obstacle comparison');
      const reached = await localDriveTo(alice, 16, 2.4);
      starts.push({ preset: presetId, resetAfterFault, x: reached.x, z: reached.z, speed: reached.speed, charge: reached.charge, remainingSeconds: reached.timer, loading: { approach: dock, x: loaded.x, z: loaded.z, cargo: loaded.cargo }, endingCargo: reached.cargo });
      await inspect(alice, `practice-${presetId}-same-ribs`, { race: true, low: true });
      await keys(alice); await page.locator('.tb-local-footer').getByRole('button', { name: /В мастерскую/ }).click();
      await expect(page.locator('.tb-builder')).toBeVisible();
    }
    return { compared: starts, obstacle: 'Same real fragile-track ribs at 11–15 m with three loaded capsules', requestedCruiseSpeed: 2.4, superiorityAssertion: false, visualInspection: 'Screenshots recorded, not a human inspection', rendererLoss: 'real WEBGL_lose_context fault', pause: 'position/charge/timer unchanged' };
  });
  await scenario('English short-screen touch emulation and 2D driving', async () => {
    const page = bob.page; await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(origin + '/games/test-bench?mode=practice');
    await expect(page.locator('.tb-builder')).toBeVisible();
    await preset(bob, 'universal', false);
    await page.getByRole('button', { name: /Test drive/ }).click(); await expect(page.locator('.tb-race')).toBeVisible();
    await expect(page.locator('canvas.tb-scene-canvas')).toHaveAttribute('data-renderer', '2d');
    await inspect(bob, 'short-en-2d-controls', { race: true });
    const pedal = page.getByRole('button', { name: 'Accelerate', exact: true });
    await expect(pedal).toBeVisible(); const bounds = await pedal.boundingBox(); assert.ok(bounds);
    const cdp = await bob.context.newCDPSession(page);
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, id: 1, radiusX: 4, radiusY: 4 };
    const before = await localHud(bob);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }); await delay(500);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); report.controls.touchGestures++;
    const after = await localHud(bob); assert.ok(after.z > before.z + .03, 'Touch accelerator must move the real machine');
    await focusLane(bob); await keys(bob, ['Space']); await delay(300); await keys(bob);
    const slider = page.getByRole('slider', { name: 'Steering' }); await slider.focus(); await slider.press('ArrowRight');
    await page.locator('.tb-pause').focus(); await page.locator('.tb-pause').press('Space'); await expect(page.locator('.tb-race')).toHaveClass(/paused/);
    await page.locator('.tb-pause').press('Space'); await expect(page.locator('.tb-race')).not.toHaveClass(/paused/);
    await inspect(bob, 'short-en-2d-after-touch', { race: true });
    await cdp.detach(); await page.setViewportSize({ width: 1440, height: 900 });
    return { viewport: '844×390', emulatedTouch: true, physicalDevice: false, deltaZ: after.z - before.z, nativeSpaceActivation: 'pause/resume' };
  });
}

async function survivingLoosePickup(player) {
  const page = player.page;
  await keys(player); await page.goto(origin + '/games/test-bench?mode=practice');
  await expect(page.locator('.tb-builder')).toBeVisible();
  const track = policy.getTrack('climb');
  const card = page.locator('.tb-track-cards button').filter({ has: page.getByRole('heading', { name: track.name[player.locale], exact: true }) });
  await card.click(); await expect(card).toHaveClass(/selected/);
  await preset(player, 'gentle', false);
  await page.getByRole('button', { name: new RegExp(label(player, 'Проверить', 'Test drive')) }).click();
  await expect(page.locator('.tb-race-top h1')).toHaveText(track.name[player.locale]);
  await expect(page.locator('canvas.tb-scene-canvas')).toHaveAttribute('data-renderer', '2d');
  await expect(page.locator('.tb-race-map > span')).toHaveText(label(player, 'Обычная полоса', 'Standard lane'));
  await focusLane(player);
  const allSecured = hud => hud.cargo.length === 3 && hud.cargo.every(cargo => cargo.status === 'secured' && Number.isFinite(cargo.health) && cargo.health > 0);
  const sample = hud => ({ x: hud.x, z: hud.z, speed: hud.speed, timer: hud.timer, interaction: hud.interaction, cargo: hud.cargo.map(({ index, status, health }) => ({ index, status, health })) });
  let loadPresses = 0;
  const loaded = await until(async () => {
    const hud = await localHud(player);
    assert.notEqual(hud.z, null, 'Pickup approach requires the visible minimap');
    assert.equal(hud.result, false, 'The pickup exercise must remain inside the normal practice deadline');
    if (allSecured(hud)) return hud;
    if (loadPresses) return false;
    if (hud.canInteract && hud.interaction?.includes(label(player, 'Загрузить груз', 'Load cargo'))) {
      await page.keyboard.press('KeyE'); report.controls.keyboardEvents += 2; loadPresses++;
      return false;
    }
    // Quantized normal-bot dock approach, using only visible z and rounded HUD
    // speed; no lane snapshot, body handle or gameplay state hook is consulted.
    const desired = Math.min(3, Math.max(0, track.loadingDock.z + .12 - hud.z - .25));
    const braking = hud.speed > desired + .22 || desired < .18;
    await keys(player, braking ? ['Space'] : (desired - hud.speed) * .9 > .05 ? ['KeyW'] : []);
    return false;
  }, 'load all three power cells through the visible E action', 20000, 33);
  assert.equal(loadPresses, 1);
  await keys(player, ['KeyW']);
  await until(async () => {
    const hud = await localHud(player);
    assert.ok(allSecured(hud), 'Cargo must stay secured during the straight approach');
    return hud.z > 4;
  }, 'straight pickup approach passes four metres', 10000, 25);
  await keys(player, ['KeyW', 'KeyD']);
  const released = await until(async () => {
    const hud = await localHud(player);
    assert.equal(hud.result, false);
    assert.ok(hud.cargo.every(cargo => cargo.status !== 'broken'), 'The deliberate collision must leave the cargo alive');
    return hud.cargo.some(cargo => cargo.status === 'loose' && cargo.health > 0) && hud;
  }, 'a real collision visibly releases surviving cargo', 15000, 25);
  await keys(player, ['Space']);
  const eligible = await until(async () => {
    const hud = await localHud(player);
    assert.ok(hud.cargo.every(cargo => cargo.status !== 'broken'), 'The loose cargo must survive until E pickup');
    return hud.canInteract && hud.speed <= .1 && hud.interaction?.includes(label(player, 'Подобрать груз', 'Collect cargo')) && hud;
  }, 'the visible pickup control is enabled after braking to at most 0.1 m/s', 10000, 25);
  await page.keyboard.press('KeyE'); report.controls.keyboardEvents += 2;
  const collected = await until(async () => { const hud = await localHud(player); return allSecured(hud) && hud; }, 'E visibly secures all three surviving power cells', 5000, 25);
  const integrity = collected.cargo.map(cargo => cargo.health);
  const brakingStarted = performance.now(); let stabilitySamples = 0;
  const settled = await until(async () => {
    const hud = await localHud(player); stabilitySamples++;
    assert.ok(allSecured(hud), 'All three recovered power cells must stay secured and alive while braking');
    assert.deepEqual(hud.cargo.map(cargo => cargo.health), integrity, 'The secured cargo must preserve its actual pickup integrity');
    // The visible timer is ceiled to whole seconds: a three-second change
    // proves at least two simulated seconds, without reading a private tick.
    return performance.now() - brakingStarted >= 2000 && Number(collected.timer) - Number(hud.timer) >= 3 && hud;
  }, 'recovered cargo remains stable for at least two simulated seconds', 15000, 50);
  const brakingWallMs = Math.round(performance.now() - brakingStarted);
  await inspect(player, 'extended-surviving-loose-pickup', { race: true });
  await keys(player); await page.locator('.tb-local-footer').getByRole('button', { name: label(player, 'В мастерскую', 'Workshop'), exact: false }).click();
  await expect(page.locator('.tb-builder')).toBeVisible();
  return { profile: player.name, renderer: '2d', track: 'climb', mirrored: false, preset: 'gentle', loadPresses, pickupPresses: 1, restored: false, observation: 'Visible minimap, all cargo cards, speed, timer and interaction button only', control: 'Real keyboard W/D/Space/E', loaded: sample(loaded), released: sample(released), eligible: sample(eligible), collected: sample(collected), settled: sample(settled), stabilitySamples, brakingWallMs, simulatedStabilityLowerBoundMs: (Number(collected.timer) - Number(settled.timer) - 1) * 1000 };
}

async function initialTutorialCrossing(player) {
  const trace = { profile: player.name, name: 'Initial unloaded tutorial crossing', lesson: 'initial-crossing', status: 'running', controlPolicy: 'Hold W until the visible 13 m goal exposes Continue, as instructed in the lesson', requestedTargetSpeed: null, targetIsHardCap: false, retryPolicy: 'No retry on timeout or error', timingMethod: 'Runner keyboard dispatch/acknowledgement and visible-HUD observations, not DOM event timestamps', observationCount: 0, observations: [], droppedObservations: 0, keyTransitionCount: 0, keyTransitions: [], droppedKeyTransitions: 0 };
  report.localDriverTraces.push(trace); player.localKeyTrace = trace;
  let outcome, failure;
  try {
    trace.initialHud = await localHud(player);
    assert.equal(trace.initialHud.lessonTitle, label(player, 'Проедь через рёбра', 'Drive over the ribs'));
    assert.equal(trace.initialHud.cargo.length, 1); assert.equal(trace.initialHud.cargo[0].status, 'at-dock');
    assert.equal(trace.initialHud.next, false);
    await focusLane(player); await keys(player, ['KeyW']);
    let priorAt = null;
    outcome = await until(async () => {
      const hud = await localHud(player), atMs = Date.now();
      assert.equal(hud.lessonTitle, trace.initialHud.lessonTitle, 'The first crossing must stay in its actual lesson step');
      assert.ok(['running', 'complete'].includes(hud.attemptStatus));
      trace.observationCount++;
      if (trace.observations.length < 1000) trace.observations.push({ atMs, intervalMs: priorAt === null ? null : atMs - priorAt, x: hud.x, z: hud.z, speed: hud.speed, charge: hud.charge, health: hud.health, cargoStatus: hud.cargoStatus, timer: hud.timer, next: hud.next, attemptStatus: hud.attemptStatus, heldKeys: [...player.held], wanted: ['KeyW'], done: hud.next }); else trace.droppedObservations++;
      priorAt = atMs;
      return hud.next && hud;
    }, 'initial tutorial crossing reaches the visible 13 m goal with ordinary W', 30000, 40);
    assert.ok(Number.isFinite(outcome.z) && outcome.z >= 13, `The first lesson must actually cross 13 m, received ${outcome.z}`);
    assert.equal(outcome.attemptStatus, 'complete');
    assert.equal(outcome.cargo.length, 1); assert.equal(outcome.cargo[0].status, 'at-dock');
    trace.outcomeHud = outcome; trace.status = 'passed';
  } catch (error) { trace.status = 'failed'; trace.error = error.message; failure = error; }
  finally {
    try { await keys(player); } catch (error) { failure ??= error; trace.status = 'failed'; trace.inputReleaseError = error.message; }
    delete player.localKeyTrace;
    trace.lastHud = await localHud(player).catch(error => ({ unavailable: error.message }));
    trace.decisionIntervalsMs = timing(trace.observations.map(value => value.intervalMs).filter(Number.isFinite));
    const speeds = trace.observations.map(value => value.speed).filter(Number.isFinite);
    trace.maximumObservedSpeed = speeds.length ? Math.max(...speeds) : null;
    await emitEvidence('local-driver-trace', compactLocalTrace(trace));
  }
  if (failure) throw failure;
  return { completed: true, goalZ: 13, hud: outcome, control: trace.controlPolicy, retried: false };
}

async function tutorialComparisonAttempt(player, kind, attempt, fastHealth) {
  const trace = { profile: player.name, name: `${kind === 'fast' ? 'Fast' : 'Slow'} tutorial attempt ${attempt}`, comparison: kind, attempt, status: 'running', controlPolicy: kind === 'fast' ? 'Hold W until the visible comparison stops' : 'Existing visible-HUD speed feedback', requestedTargetSpeed: kind === 'slow' ? .85 : null, targetIsHardCap: false, fastBaselineIntegrity: fastHealth ?? null, timingMethod: 'Runner times of actual keyboard command dispatch/acknowledgement and visible-HUD observations, not DOM event timestamps', observationCount: 0, observations: [], droppedObservations: 0, keyTransitionCount: 0, keyTransitions: [], droppedKeyTransitions: 0 };
  report.localDriverTraces.push(trace); player.localKeyTrace = trace;
  const retryStatus = 'retry-' + kind;
  const terminal = hud => hud.attemptStatus === 'complete' || hud.attemptStatus === retryStatus;
  let result, failure;
  try {
    trace.initialHud = await localHud(player);
    assert.equal(trace.initialHud.attemptStatus, 'running', 'A crossing attempt must start in its current running lesson step');
    assert.equal(trace.initialHud.cargo.length, 1); assert.equal(trace.initialHud.cargo[0].status, 'secured');
    if (kind === 'fast') {
      await focusLane(player); await keys(player, ['KeyW']);
      let priorAt = null;
      await until(async () => {
        const hud = await localHud(player), atMs = Date.now();
        assert.ok(['running', 'complete', retryStatus].includes(hud.attemptStatus), 'Fast comparison must stay in the same public lesson state');
        trace.observationCount++;
        if (trace.observations.length < 1000) trace.observations.push({ atMs, intervalMs: priorAt === null ? null : atMs - priorAt, x: hud.x, z: hud.z, speed: hud.speed, health: hud.health, cargoStatus: hud.cargoStatus, timer: hud.timer, next: hud.next, attemptStatus: hud.attemptStatus, wanted: ['KeyW'], done: terminal(hud) }); else trace.droppedObservations++;
        priorAt = atMs; return terminal(hud) && hud;
      }, 'fast comparison reaches an explicit completed or unsuccessful frozen outcome', 20000, 40);
    } else {
      await localDriveTo(player, 14, .85, terminal, 45000, trace);
      await until(async () => terminal(await localHud(player)), 'slow comparison reaches an explicit completed or unsuccessful frozen outcome', 10000, 40);
    }
    await keys(player);
    const observed = await localHud(player);
    const hud = await stableLessonMilestone(player, `${kind} attempt ${attempt}`, observed.attemptStatus);
    trace.outcomeHud = hud;
    if (hud.attemptStatus === retryStatus) {
      const prefix = kind === 'fast' ? label(player, 'В этом проезде груз не получил повреждений.', 'This run did not damage the cargo.') : label(player, 'Больше целостности сохранить не удалось.', 'This attempt did not preserve more integrity.');
      assert.ok(hud.lessonFeedback?.startsWith(prefix), 'A retry requires the explicit visible unsuccessful-comparison message');
      assert.equal(hud.next, false); trace.status = 'unsuccessful comparison';
    } else {
      assert.equal(hud.attemptStatus, 'complete');
      if (kind === 'fast') {
        assert.equal(hud.lessonTitle, label(player, 'Почувствуй удар', 'Feel the impact'));
        assert.match(hud.cargoStatus ?? '', /\b(secured|loose|broken)\b/);
        assert.ok(Number.isFinite(hud.health) && hud.health >= 0 && hud.health < 100, `Fast milestone must show real damage, received ${hud.health}`);
      } else {
        assert.equal(hud.lessonTitle, label(player, 'Теперь пройди медленнее', 'Now take it slowly'));
        assert.match(hud.cargoStatus ?? '', /\bsecured\b/, 'Slow comparison must keep the capsule secured');
        assert.ok(hud.z >= 13.5, `Slow comparison must cross the ribs, received z=${hud.z}`);
        assert.ok(Number.isFinite(hud.health) && hud.health > fastHealth && hud.health <= 100, `Slow integrity ${hud.health} must exceed fast ${fastHealth}`);
      }
      trace.status = 'passed';
    }
    result = { hud, status: trace.status, attempt };
  } catch (error) { trace.status = 'failed'; trace.error = error.message; failure = error; }
  finally {
    try { await keys(player); } catch (error) { failure ??= error; trace.status = 'failed'; trace.inputReleaseError = error.message; }
    delete player.localKeyTrace;
    trace.lastHud = await localHud(player).catch(error => ({ unavailable: error.message }));
    trace.decisionIntervalsMs = timing(trace.observations.map(value => value.intervalMs).filter(Number.isFinite));
    const speeds = trace.observations.map(value => value.speed).filter(Number.isFinite);
    trace.maximumObservedSpeed = speeds.length ? Math.max(...speeds) : null;
    await emitEvidence('local-driver-trace', compactLocalTrace(trace));
  }
  if (failure) throw failure;
  return result;
}

async function restartTutorialComparison(player, kind, previous) {
  const record = { profile: player.name, comparison: kind, fromAttempt: 1, toAttempt: 2, status: 'running', method: 'One ordinary Restart button, then ordinary dock approach and loading UI', before: previous };
  report.tutorialRetries.push(record);
  try {
    const before = await localHud(player);
    assert.equal(before.attemptStatus, 'retry-' + kind); assert.equal(before.next, false);
    assert.equal(before.lessonStep, previous.lessonStep); assert.equal(before.lessonTitle, previous.lessonTitle);
    await keys(player);
    await player.page.locator('.tb-local-footer').getByRole('button', { name: new RegExp(label(player, 'Начать заново', 'Restart')) }).click();
    const after = await until(async () => {
      const hud = await localHud(player);
      return hud.attemptStatus === 'running' && Number.isFinite(hud.z) && hud.z < 1 && hud.speed <= .1 && hud.cargo.length === 1 && hud.cargo[0].status === 'at-dock' && hud;
    }, 'Restart keeps the current comparison and creates one docked capsule');
    record.afterRestart = after;
    assert.equal(after.lessonStep, previous.lessonStep); assert.equal(after.lessonTitle, previous.lessonTitle);
    await approachLoadingDock(player); await keys(player);
    await expect(player.page.locator('.tb-interact')).toBeEnabled(); await player.page.locator('.tb-interact').click();
    await expect(player.page.locator('.tb-cargo-slot')).toHaveClass(/secured/);
    record.afterLoad = await localHud(player);
    assert.equal(record.afterLoad.lessonStep, previous.lessonStep); assert.equal(record.afterLoad.attemptStatus, 'running');
    assert.equal(record.afterLoad.cargo.length, 1); assert.equal(record.afterLoad.health, 100);
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.error = error.message; throw error; }
  finally { await emitEvidence('tutorial-retry', record); }
}

async function tutorialComparison(player, kind, fastHealth) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    // An error or timeout propagates immediately. Only the verified public
    // retry outcome can reach the ordinary Restart action below.
    const result = await tutorialComparisonAttempt(player, kind, attempt, fastHealth);
    attempts.push(result);
    if (result.status === 'passed') return { hud: result.hud, attempts };
    assert.equal(attempt, 1, `${kind}: both allowed comparison attempts were explicitly unsuccessful`);
    await restartTutorialComparison(player, kind, result.hud);
  }
  throw new Error('Comparison did not produce a completed outcome');
}

async function tutorial(player) {
  report.tutorial = 'running'; const page = player.page;
  await page.goto(origin + '/games/test-bench');
  await page.getByRole('button', { name: /Как играть/ }).click();
  await expect(page.locator('.tb-builder')).toBeVisible();
  await expect(page.getByRole('button', { name: /Проверить/ })).toBeDisabled();
  await selectPart(player, 'front-axle', 'terrain', false);
  await expect(page.getByRole('button', { name: /Проверить/ })).toBeEnabled();
  await page.getByRole('button', { name: /Проверить/ }).click();
  await expect(page.locator('.tb-race')).toBeVisible();
  const next = () => page.locator('.tb-race-lesson .tb-primary');
  const initialCrossing = await initialTutorialCrossing(player); await next().click();
  await until(async () => (await localHud(player)).z < 1, 'tutorial restarts at the dock lesson');
  await approachLoadingDock(player);
  await keys(player); const load = page.locator('.tb-interact'); await expect(load).toBeEnabled(); await load.focus(); await load.press('Space');
  await expect(page.locator('.tb-cargo-slot')).toHaveClass(/secured/); await next().click();
  const fastComparison = await tutorialComparison(player, 'fast');
  const fast = fastComparison.hud;
  await next().click();
  await until(async () => (await localHud(player)).z < 1, 'tutorial restarts for the slow comparison');
  await expect(page.locator('.tb-race-lesson p b')).toHaveText(String(fast.health));
  await approachLoadingDock(player);
  await keys(player); await page.locator('.tb-interact').click(); await expect(page.locator('.tb-cargo-slot')).toHaveClass(/secured/);
  const slowComparison = await tutorialComparison(player, 'slow', fast.health);
  const slow = slowComparison.hud;
  await expect(next()).toBeVisible(); await inspect(player, 'tutorial-slow-comparison', { race: true, low: true }); await next().click();
  await localDriveTo(player, 22.5, 1.8, hud => hud.next, 25000); await keys(player, ['Space']);
  await expect(next()).toBeVisible({ timeout: 5000 }); await keys(player); await next().click();
  await expect(next()).toContainText('В тренировку'); await next().click(); await expect(page.locator('.tb-builder')).toBeVisible();
  report.tutorial = 'completed through UI and real local physics';
  return { completed: true, steps: 6, initialCrossing, fastIntegrity: fast.health, fastCargoStatus: fast.cargoStatus, slowIntegrity: slow.health, fastAttempts: fastComparison.attempts, slowAttempts: slowComparison.attempts, retryPolicy: 'At most one ordinary UI Restart per comparison, only after a verified frozen retry-fast/retry-slow status; identical driving policy on both attempts; no retry on errors or timeouts', milestonePauseMs: 400, baselineMatchesFastHud: true, slowCargoSecured: true, observation: 'Visible minimap, HUD and lesson controls', control: 'Keyboard and UI only' };
}

async function createCup(alice, bob) {
  await alice.page.goto(origin + '/games/test-bench');
  await alice.page.getByRole('button', { name: /^Создать комнату/ }).click();
  const dialog = alice.page.getByRole('dialog', { name: 'Создать комнату' });
  await expect(dialog.getByLabel('Мест в комнате', { exact: true })).toBeVisible();
  const options = await dialog.getByLabel('Мест в комнате', { exact: true }).locator('option').allTextContents();
  assert.deepEqual(options, ['2', '3', '4', '5', '6']);
  await dialog.getByLabel('Мест в комнате', { exact: true }).selectOption('4');
  let room = (await roomAction(alice, dialog.getByRole('button', { name: /^Создать комнату/ }), '/rooms')).room;
  await expect(alice.page.locator('.tb-lobby')).toBeVisible();
  await expect(alice.page.getByRole('button', { name: /Начать кубок/ })).toBeDisabled();
  await alice.page.getByRole('button', { name: 'Настроить комнату', exact: true }).click();
  const roomDialog = alice.page.locator('dialog[open]');
  await roomDialog.getByLabel('Название', { exact: true }).fill('Browser acceptance cup');
  await roomDialog.getByLabel('Число мест', { exact: true }).selectOption('4');
  room = (await roomAction(alice, roomDialog.getByRole('button', { name: 'Сохранить', exact: true }), '/settings')).room;
  const inviteAndJoin = async () => {
    await alice.page.getByRole('button', { name: /^Пригласить друга/ }).click();
    const row = alice.page.locator('.tb-invite-row').filter({ hasText: bob.account.user.displayName });
    const invitation = (await roomAction(alice, row.getByRole('button', { name: 'Пригласить', exact: true }), '/invitations')).invitation;
    await alice.page.locator('dialog[open]').getByRole('button', { name: 'Готово', exact: true }).click();
    // The recipient fixture accepts its isolated invitation; game control stays in UI.
    await bob.account.request(`/invitations/${invitation.invitationId}/accept`, {});
    await bob.account.request(`/rooms/${room.roomId}/join`, {});
    await alice.page.reload();
    await expect(alice.page.locator('.tb-seat-list')).toContainText(bob.account.user.displayName);
  };
  await inviteAndJoin();
  await roomAction(alice, alice.page.getByRole('button', { name: 'Убрать участника ' + bob.account.user.displayName, exact: true }), '/kick');
  await expect(alice.page.locator('.tb-seat-list')).not.toContainText(bob.account.user.displayName);
  await inviteAndJoin();
  await alice.page.reload(); await bob.page.goto(origin + '/rooms/' + room.roomId);
  await expect(alice.page.locator('.tb-seat-list')).toContainText(bob.account.user.displayName);
  await expect(bob.page.locator('.tb-lobby')).toBeVisible();
  await alice.page.getByLabel('Сложность бота', { exact: true }).selectOption('normal');
  room = (await roomAction(alice, alice.page.getByRole('button', { name: /Добавить бота/ }), '/bots')).room;
  const bot = room.members.find(member => member.controller.kind === 'bot');
  room = (await roomAction(alice, alice.page.getByRole('button', { name: 'Убрать участника ' + bot.displayName, exact: true }), '/remove')).room;
  assert.equal(room.members.filter(member => member.controller.kind === 'bot').length, 0);
  room = (await roomAction(alice, alice.page.getByRole('button', { name: /Добавить бота/ }), '/bots')).room;
  await alice.page.getByLabel('Сложность бота', { exact: true }).selectOption('easy');
  room = (await roomAction(alice, alice.page.getByRole('button', { name: /Добавить бота/ }), '/bots')).room;
  assert.equal(room.members.filter(member => member.controller.kind === 'bot').length, 2);
  await expect(alice.page.getByRole('button', { name: /Добавить бота/ })).toBeDisabled();
  await expect(alice.page.getByLabel('Сложность бота', { exact: true })).toBeDisabled();
  await expect(alice.page.locator('.tb-seat-list')).toContainText('БОТ');
  await roomAction(alice, alice.page.getByRole('button', { name: /^Я готов/ }), '/ready', 'Space');
  await roomAction(alice, alice.page.getByRole('button', { name: /^Пока не готов/ }), '/ready');
  await expect(alice.page.getByRole('button', { name: /Начать кубок/ })).toBeDisabled();
  await roomAction(alice, alice.page.getByRole('button', { name: /^Я готов/ }), '/ready');
  // Bob's portal view polls independently. Wait for the final roster to be
  // visible before its ready action uses that roster's revision.
  const bobSeats = bob.page.locator('.tb-seat-list .tb-seat');
  await expect(bobSeats).toHaveCount(4);
  await expect(bobSeats.filter({ hasText: 'BOT ·' })).toHaveCount(2);
  await expect(bob.page.locator('.tb-seat-list .tb-seat.vacant')).toHaveCount(0);
  await roomAction(bob, bob.page.getByRole('button', { name: /^I’m ready/ }), '/ready');
  await expect(alice.page.getByRole('button', { name: /Начать кубок/ })).toBeEnabled({ timeout: 8000 });
  await inspect(alice, 'ru-four-seat-lobby'); await inspect(bob, 'en-four-seat-lobby');
  const priorConnections = [alice, bob].map(player => player.socketConnections);
  room = (await roomAction(alice, alice.page.getByRole('button', { name: /Начать кубок/ }), '/start')).room;
  // The start response can still be in 'starting' with a null matchId. Bind
  // its created room to the first new connection, then require the same
  // authoritative match identity in the second independent profile.
  await waitView(alice, current => alice.snapshotConnection > priorConnections[0] && current.roomId === room.roomId && !!current.matchId && (!room.matchId || current.matchId === room.matchId), 'new live connection for the created cup room');
  const matchId = view(alice).matchId;
  await waitView(bob, current => bob.snapshotConnection > priorConnections[1] && current.roomId === room.roomId && current.matchId === matchId, 'second profile receives the same newly created cup');
  assert.notEqual(view(alice).you.participantId, view(bob).you.participantId);
  return { roomId: room.roomId, matchId, labelledBotSeats: 2, capacities: options, readyUnready: true, initialConnections: [alice, bob].map((player, index) => ({ profile: player.name, prior: priorConnections[index], observed: player.snapshotConnection })) };
}

async function buildStage(alice, bob, stage) {
  for (const player of [alice, bob]) await waitView(player, current => current.stage === stage && ['briefing', 'building'].includes(current.phase), `stage ${stage + 1} briefing`);
  for (const player of [alice, bob]) {
    if (view(player).phase === 'briefing') {
      await expect(player.page.locator('.tb-briefing')).toBeVisible();
      await action(player, player.page.locator('.tb-briefing').getByRole('button', { name: new RegExp(label(player, '^К сборке', '^To the workshop')) }), 'confirm');
    }
  }
  await Promise.all([alice, bob].map(player => waitView(player, current => current.phase === 'building' && current.stage === stage, 'real building phase')));
  await Promise.all([alice, bob].map(player => expect(player.page.locator('.tb-builder')).toBeVisible()));
  if (stage === 0) {
    await preset(alice, 'gentle');
    await selectPart(alice, 'front-axle', 'high');
    await selectPart(alice, 'rear-axle', 'high', true, 'Бюджет — 16 жетонов');
    await expect(alice.page.locator('.tb-budget strong')).toContainText('17');
    await selectPart(alice, 'front-axle', 'terrain');
    await preset(bob, 'universal');
    await selectPart(bob, 'front-axle', 'terrain'); await selectPart(bob, 'cargo', 'cradle');
    assert.notDeepEqual(view(alice).you.build.blueprint, view(bob).you.build.blueprint, 'Independent drivers must compare different legal machines');
    assert.equal(view(alice).players.find(player => player.playerId === bob.account.user.playerId).blueprint, null, 'Peer workshop draft is private');
    await action(alice, alice.page.locator('.tb-builder-actions').getByRole('button', { name: /^Готов/ }), 'ready', 'Space');
    await expect(alice.page.locator('.tb-parts button').first()).toBeDisabled();
    await action(alice, alice.page.getByRole('button', { name: 'Изменить сборку', exact: true }), 'ready');
    await expect(alice.page.locator('.tb-parts button').first()).toBeEnabled();
    assert.equal(view(alice).you.build.ready, false);
  } else if (stage === 1) {
    await selectPart(alice, 'battery', 'large');
    await selectPart(alice, 'aux-right', null);
    assert.equal(view(alice).you.edits, 2);
    await selectPart(alice, 'motor', 'torque', true, 'только два крепления');
    await selectPart(alice, 'battery', 'small');
    assert.equal(view(alice).you.edits, 1, 'Restoring an original part must return one edit');
    await selectPart(bob, 'rear-axle', 'terrain'); await selectPart(bob, 'aux-right', 'ballast');
  } else {
    await selectPart(alice, 'motor', 'torque'); await selectPart(alice, 'battery', 'large'); await selectPart(bob, 'motor', 'torque');
    assert.equal(view(alice).you.edits, 2);
  }
  const builds = [alice, bob].map(player => ({ profile: player.name, blueprint: view(player).you.build.blueprint, budget: view(player).you.budget, edits: view(player).you.edits }));
  const paints = await Promise.all([alice, bob].map(player => player.page.locator('.tb-scene').getAttribute('data-participant-paint')));
  assert.ok(paints.every(Boolean)); assert.notEqual(paints[0], paints[1], 'Different room seats have different chassis paint in both renderers');
  for (const player of [alice, bob]) await inspect(player, `stage-${stage + 1}-builder`, { low: true });
  for (const player of [alice, bob]) await action(player, player.page.locator('.tb-builder-actions').getByRole('button', { name: new RegExp(label(player, '^Готов', '^Ready')) }), 'ready');
  await Promise.all([alice, bob].map(player => waitView(player, current => current.stage === stage && current.phase === 'countdown', 'four-second countdown')));
  await Promise.all([alice, bob].map(player => expect(player.page.locator('.tb-countdown')).toBeVisible()));
  await Promise.all([alice, bob].map(player => waitView(player, current => current.stage === stage && current.phase === 'racing', 'real racing phase', 8000)));
  for (const player of [alice, bob]) { player.driveRemainder = { throttle: 0, steering: 0 }; await focusLane(player); }
  return builds;
}

async function keyboardDrive(player) {
  const snapshot = player.snapshot;
  if (!fresh(player) || player.snapshotConnection !== player.socketConnections || !player.predictionScope || snapshot.view.phase !== 'racing' || !snapshot.view.you.lane || snapshot.view.you.lane.finished) { clearPrecisionProgress(player, 'Driver has no fresh active racing lane'); player.interactionStop = null; await keys(player); return; }
  const lane = snapshot.view.you.lane, track = snapshot.view.track;
  const { decision, steering, prediction } = policy.chooseBrowserKeyboardInput(lane, track, { snapshotTimeMs: snapshot.serverTime, nowMs: Date.now(), delayMs: latencyMs, sentSteering: player.steeringHistory });
  if (prediction) {
    player.predictionStats.calls++; player.predictionStats.horizons.push(prediction.horizonMs);
    if (player.predictionStats.samples.length < 12) player.predictionStats.samples.push({ stage: snapshot.view.stage, phaseId: snapshot.view.phaseId, tick: lane.tick, ...prediction });
  }
  const sent = player.lastSent;
  const sentInput = sent?.matchId === snapshot.matchId && sent.epoch === snapshot.epoch && sent.payload?.phaseId === snapshot.view.phaseId ? sent.payload : { throttle: 0, steering: 0, brake: true };
  const stalled = policy.observePrecisionStall(player.precisionStall, { lane, track, scope: JSON.stringify(player.predictionScope), nowMs: Date.now(), snapshotTimeMs: snapshot.serverTime, lastAcceptedSeq: snapshot.lastAcceptedSeq, sentInput, plannedInput: decision.input });
  player.precisionStall = stalled.state;
  if (track.id === 'precision' && stalled.restore && !player.held.has('KeyR')) {
    const recovery = { id: 'upright-' + (report.uprightStallRecoveries.length + 1), profile: player.name, participantId: snapshot.view.you.participantId, roomId: snapshot.view.roomId, matchId: snapshot.matchId, stage: snapshot.view.stage, phaseId: snapshot.view.phaseId, scope: { ...player.predictionScope }, trigger: stalled.evidence, triggerObservation: observedDriveState(player), requestedHoldMs: 750, requestedAtMs: Date.now(), resetsBefore: lane.resets, resetObserved: false, resetEvidence: [], commands: [] };
    report.uprightStallRecoveries.push(recovery); player.uprightRecovery = recovery; player.uprightKeyRecord = recovery;
    player.lastRestore = Date.now();
    await keys(player, ['Space', 'KeyR']);
    player.uprightHoldUntil = recovery.keyDownAcknowledgedAtMs + recovery.requestedHoldMs;
    return;
  }
  if (player.uprightRecovery && Date.now() < player.uprightHoldUntil) { await keys(player, ['Space', 'KeyR']); return; }
  player.uprightHoldUntil = 0;
  const interactionScope = JSON.stringify(player.predictionScope);
  const securedCargoIds = lane.cargo.filter(cargo => cargo.status === 'secured').map(cargo => cargo.id);
  const lastInteractionEventId = lane.events.findLast(event => event.kind === 'loaded' || event.kind === 'picked-up')?.id ?? null;
  const confirmedInteraction = player.interactionStop?.issued && (securedCargoIds.some(id => !player.interactionStop.securedCargoIds.includes(id)) || lastInteractionEventId !== null && lastInteractionEventId !== player.interactionStop.lastInteractionEventId);
  const keepBrakingForInteraction = player.interactionStop?.scope === interactionScope && lane.interaction === 'slow-down';
  if (decision.interact || keepBrakingForInteraction) {
    // The 0.7 m/s availability boundary can be crossed during an HTTP trip.
    // Stop through ordinary keyboard input before E, and require a snapshot
    // that acknowledges an actually transmitted brake input. This is QA
    // driving behavior, not a relaxed interaction rule or a gameplay RPC.
    // A pickup secures one item. A second nearby loose item may keep the same
    // public label. A newly secured item or actual loaded/picked-up event
    // confirms that action and can arm another E. Damage cannot re-arm it.
    if (!keepBrakingForInteraction && (player.interactionStop?.scope !== interactionScope || player.interactionStop?.interaction !== lane.interaction || confirmedInteraction)) player.interactionStop = { scope: interactionScope, interaction: lane.interaction, securedCargoIds, lastInteractionEventId, brakeAcknowledgedAtMs: null, firstBrakeSeq: null, firstBrakeSentAtMs: null, issued: false };
    const stop = player.interactionStop;
    await keys(player, ['Space']);
    stop.brakeAcknowledgedAtMs ??= Date.now();
    const brakeFrame = player.lastSent;
    if (stop.firstBrakeSeq === null && player.lastSentAtMs >= stop.brakeAcknowledgedAtMs && brakeFrame?.matchId === snapshot.matchId && brakeFrame.epoch === snapshot.epoch && brakeFrame.payload?.phaseId === snapshot.view.phaseId && brakeFrame.payload.brake === true && brakeFrame.payload.throttle === 0 && brakeFrame.payload.steering === 0) { stop.firstBrakeSeq = brakeFrame.seq; stop.firstBrakeSentAtMs = player.lastSentAtMs; }
    const eligible = () => {
      const current = player.snapshot, currentLane = current?.view.you.lane;
      return !stop.issued && player.interactionStop === stop && JSON.stringify(player.predictionScope) === interactionScope && player.snapshotConnection === player.socketConnections && fresh(player) && Date.now() - current.serverTime <= 300 && current?.matchId === snapshot.matchId && current.epoch === snapshot.epoch && current.view.phaseId === snapshot.view.phaseId && current.view.phase === 'racing' && currentLane && !currentLane.finished && currentLane.interaction === stop.interaction && currentLane.car.speed <= .3 && stop.firstBrakeSeq !== null && current.lastAcceptedSeq >= stop.firstBrakeSeq && Date.now() - stop.firstBrakeSentAtMs >= 200;
    };
    if (eligible() && await player.page.locator('.tb-interact').isEnabled() && eligible()) {
      const record = { profile: player.name, interaction: stop.interaction, minimumBrakeMs: 200, observedBrakeMs: Date.now() - stop.firstBrakeSentAtMs, brakeAcknowledgedAtMs: stop.brakeAcknowledgedAtMs, firstBrakeSentAtMs: stop.firstBrakeSentAtMs, firstBrakeSeq: stop.firstBrakeSeq, observation: observedDriveState(player), keyDispatchedAtMs: Date.now() };
      stop.issued = true; report.interactionStops.push(record);
      await player.page.keyboard.press('KeyE'); report.controls.keyboardEvents += 2; player.lastInteract = Date.now();
      record.keyAcknowledgedAtMs = player.lastInteract;
    }
    return;
  }
  player.interactionStop = null;
  const wanted = [];
  if (decision.input.brake) wanted.push('Space');
  else if (decision.input.throttle > .05) wanted.push('KeyW');
  if (steering > 0) wanted.push('KeyD'); else if (steering < 0) wanted.push('KeyA');
  if (decision.restore && Date.now() - player.lastRestore > 2400) { player.restoreUntil = Date.now() + 750; player.lastRestore = Date.now(); }
  if (player.restoreUntil > Date.now()) wanted.push('KeyR');
  await keys(player, wanted);
}

function observedDriveState(player) {
  const snapshot = player.snapshot, current = snapshot?.view, lane = current?.you.lane;
  const sent = player.lastSent;
  return {
    readAtMs: Date.now(), receivedAtMs: player.receivedAt ?? null, serverTime: snapshot?.serverTime ?? null,
    receivedFrameCount: player.receivedFrames, snapshotConnection: player.snapshotConnection ?? null,
    roomId: current?.roomId ?? null, matchId: current?.matchId ?? null, participantId: current?.you.participantId ?? null,
    epoch: snapshot?.epoch ?? null, phase: current?.phase ?? null, phaseId: current?.phaseId ?? null, stage: current?.stage ?? null,
    lastAcceptedSeq: snapshot?.lastAcceptedSeq ?? null, heldKeys: [...player.held],
    sentInputFrameCount: player.sentInputs,
    lastSentInput: sent ? { seq: sent.seq, matchId: sent.matchId, epoch: sent.epoch, phaseId: sent.payload?.phaseId, throttle: sent.payload?.throttle, steering: sent.payload?.steering, brake: sent.payload?.brake } : null,
    lane: lane ? { tick: lane.tick, position: { ...lane.car.position }, speed: lane.car.speed, yaw: lane.car.yaw, tilt: lane.car.tilt, tiltTicks: lane.tiltTicks, charge: lane.car.charge, wheelSteering: lane.car.wheels[0]?.steering ?? null, gatesPassed: lane.gatesPassed, interaction: lane.interaction, resets: lane.resets, finished: lane.finished, cargo: lane.cargo.map(cargo => ({ id: cargo.id, status: cargo.status, health: cargo.health })) } : null,
  };
}

function captureDriveStage(trace, participants, force = false) {
  for (const [index, player] of participants.entries()) {
    const profile = trace.profiles[index], observation = observedDriveState(player);
    profile.readCount++;
    const previous = profile.lastObservation;
    profile.lastObservation = observation;
    if (observation.matchId === trace.matchId && observation.stage === trace.stage && observation.phase === 'racing' && observation.lane) profile.lastRacingObservation = observation;
    if (previous?.receivedFrameCount === observation.receivedFrameCount && !force) continue;
    profile.sampledSnapshotCount++;
    if (profile.firstObservations.length < 4) profile.firstObservations.push(observation);
    const last = profile.trajectory.at(-1);
    if (force || !last || observation.readAtMs - last.readAtMs >= 500 || last.phase !== observation.phase || last.epoch !== observation.epoch) {
      profile.trajectory.push(observation);
      if (profile.trajectory.length > 32) { profile.trajectory.shift(); profile.evictedTrajectorySamples++; }
    }
  }
}

async function reconnect(player, roomId) {
  const before = player.snapshot; const epoch = before.epoch;
  await keys(player); player.intentionalOffline = true; await player.context.setOffline(true);
  await player.page.reload({ waitUntil: 'commit', timeout: 2500 }).catch(() => {});
  await delay(400); await player.context.setOffline(false); player.intentionalOffline = false;
  await player.page.goto(origin + '/rooms/' + roomId);
  await waitView(player, current => current.matchId === before.matchId && current.phase === 'racing' && player.snapshot.epoch !== epoch, 'independent profile reconnect to the same cup');
  const after = player.snapshot;
  assert.equal(after.view.you.build.revision, before.view.you.build.revision);
  assert.deepEqual(after.view.you.build.blueprint, before.view.you.build.blueprint);
  assert.ok(after.view.you.lane.tick >= before.view.you.lane.tick);
  assert.ok(after.view.you.lane.car.charge <= before.view.you.lane.car.charge + .001);
  await focusLane(player);
  return { method: 'One isolated context offline, reload, online and normal room return', sameMatch: true, epochReplaced: true, savedBuild: true, beforeTick: before.view.you.lane.tick, afterTick: after.view.you.lane.tick };
}

async function restartDuringRace(alice, bob) {
  const check = { scopeId: 'normalCup', roomId: view(alice).roomId, matchId: view(alice).matchId, stage: view(alice).stage, status: 'running', startedAtMs: Date.now(), profiles: [alice, bob].map(player => ({ profile: player.name, participantId: view(player).you.participantId })) };
  report.restartChecks.push(check);
  try {
    for (const player of [alice, bob]) await keys(player, ['Space']);
    await delay(150); const before = [alice, bob].map(player => player.snapshot);
    for (const [index, player] of [alice, bob].entries()) check.profiles[index].before = { observation: observedDriveState(player), blueprint: structuredClone(before[index].view.you.build.blueprint) };
    await stop(); check.serverStoppedAtMs = Date.now();
    await start(); check.serverReadyAtMs = Date.now();
    for (const [index, player] of [alice, bob].entries()) {
      await waitView(player, current => current.phase === 'recovering' && current.matchId === before[index].matchId, 'five-second recovery after real server restart', 12000);
      const recovered = view(player), profile = check.profiles[index];
      profile.recovered = { observation: observedDriveState(player), blueprint: structuredClone(recovered.you.build.blueprint) };
      assert.deepEqual(recovered.you.build.blueprint, before[index].view.you.build.blueprint);
      assert.equal(recovered.you.lane.resets, before[index].view.you.lane.resets);
      assert.ok(recovered.you.lane.car.charge <= before[index].view.you.lane.car.charge + .001);
      assert.notEqual(player.snapshot.epoch, before[index].epoch);
      profile.persistenceAssertions = 'passed';
      await expect(player.page.locator('.tb-countdown')).toBeVisible();
      await expect(player.page.locator('.tb-countdown')).toContainText(label(player, 'Возвращаемся на трассу', 'Returning to the track'));
      profile.recoveryUi = { text: await player.page.locator('.tb-countdown').innerText(), countdown: Number(await player.page.locator('.tb-countdown strong').textContent()) };
      assert.ok(profile.recoveryUi.countdown >= 1, 'Recovery has a visible positive countdown');
      profile.recoveryScreenAssertions = 'passed';
    }
    for (const [index, player] of [alice, bob].entries()) {
      await waitView(player, current => current.phase === 'racing', 'resumed race after recovery', 8000);
      check.profiles[index].resumed = observedDriveState(player);
      await keys(player); await focusLane(player);
    }
    check.status = 'passed';
    return { realProcessRestart: true, persistedBuilds: true, noBatteryRefill: true, recoveryScreen: true, freshEpochs: true };
  } catch (error) { check.status = 'failed'; check.error = error.message; throw error; }
  finally {
    check.finishedAtMs = Date.now();
    for (const [index, player] of [alice, bob].entries()) check.profiles[index].lastObservation = observedDriveState(player);
    await emitEvidence('restart-check', check);
  }
}

async function driveStage(alice, bob, roomId, stage) {
  const saved = { stage, track: view(alice).track.id, mirrored: view(alice).track.mirrored, events: {}, disconnect: null, restart: null, reset: null };
  const trace = { scopeId: 'normalCup', roomId, matchId: view(alice).matchId, stage, track: saved.track, mirrored: saved.mirrored, mode: report.fullCupsMode, status: 'running', startedAtMs: Date.now(), observationMethod: 'Read-only own public snapshots and actual last sent input at driver-loop boundaries; first four and last 32 trajectory samples, at most twice per second except phase/epoch transitions', profiles: [alice, bob].map(player => ({ profile: player.name, participantId: view(player).you.participantId, renderer: report.onlineRenderers?.profiles.find(profile => profile.profile === player.name)?.renderer ?? null, readCount: 0, sampledSnapshotCount: 0, evictedTrajectorySamples: 0, firstObservations: [], trajectory: [] })) };
  report.driveStages.push(trace); captureDriveStage(trace, [alice, bob], true);
  try {
    const result = await exerciseDriveStage(alice, bob, roomId, stage, saved, trace);
    trace.status = 'passed'; return result;
  } catch (error) { trace.status = 'failed'; trace.error = error.message; throw error; }
  finally {
    captureDriveStage(trace, [alice, bob], true); trace.finishedAtMs = Date.now();
    const recoveryKeyReleases = await Promise.allSettled([alice, bob].filter(player => player.uprightKeyRecord).map(player => keys(player)));
    trace.recoveryKeyReleaseErrors = recoveryKeyReleases.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
    await Promise.allSettled([alice, bob].flatMap(player => [...player.actionReceiptReads]));
    for (const recovery of report.uprightStallRecoveries.filter(value => value.matchId === trace.matchId && value.stage === stage)) {
      recovery.finalObservation = observedDriveState(recovery.profile === alice.name ? alice : bob);
      recovery.outcome = recovery.resetObserved ? 'Reset observed; subsequent course completion is checked separately' : 'No reset observed';
      await emitEvidence('upright-stall-recovery', recovery);
    }
    for (const player of [alice, bob]) clearPrecisionProgress(player, 'Drive stage ended');
    trace.completedChecks = { disconnect: saved.disconnect, restart: saved.restart, reset: saved.reset, sameProtocol: saved.sameProtocol ?? null };
    trace.restartStatus = report.restartChecks.find(check => check.matchId === trace.matchId && check.stage === stage)?.status ?? 'not attempted';
    trace.committed = [alice, bob].map(player => {
      const current = view(player), record = current?.matchId === trace.matchId ? current.stages[stage] : null;
      return { profile: player.name, participantId: current?.you.participantId ?? null, results: record?.results ?? null, events: record ? Object.fromEntries(Object.entries(record.events).map(([participantId, events]) => [participantId, { count: events.length, finalEvents: events.slice(-12) }])) : null };
    });
    await emitEvidence('drive-stage', trace);
  }
}

async function exerciseDriveStage(alice, bob, roomId, stage, saved, trace) {
  const seen = new Map([alice, bob].map(player => [player.name, new Map()]));
  const maxCharge = {};
  if (stage === 0) {
    const check = { profile: alice.name, stage, status: 'running', requestedHoldMs: 740, startedAtMs: Date.now(), timingMethod: 'Runner key dispatch and acknowledgement times; browser DOM event times are not instrumented', inputFramesObserved: 0, inputFrames: [], snapshotsObserved: 0, snapshots: [] };
    report.restoreChecks.push(check); alice.activeRestoreCheck = check;
    const restoreUi = () => alice.page.locator('.tb-race').evaluate(node => {
      const button = node.querySelector('.tb-reset');
      return { capturedAtMs: Date.now(), enabled: !!button && !button.disabled, hold: button?.style.getPropertyValue('--hold') ?? null, countdown: !!node.querySelector('.tb-countdown'), paused: node.classList.contains('paused'), documentVisible: document.visibilityState, documentFocused: document.hasFocus(), activeElement: document.activeElement?.tagName ?? null, shownPenalty: node.querySelector('.tb-race-timer small')?.textContent ?? null };
    });
    try {
      await focusLane(alice); await expect(alice.page.locator('.tb-reset')).toBeEnabled();
      check.phaseBefore = { phase: view(alice).phase, phaseId: view(alice).phaseId, stage: view(alice).stage, tick: view(alice).you.lane?.tick, resets: view(alice).you.lane?.resets };
      check.uiBefore = await restoreUi(); assert.equal(check.phaseBefore.phase, 'racing'); assert.equal(check.uiBefore.countdown, false);
      check.keyDownDispatchedAtMs = Date.now(); await keys(alice, ['KeyR']); check.keyDownAcknowledgedAtMs = Date.now();
      const hold = async () => {
        await delay(740); check.keyUpDispatchedAtMs = Date.now(); await keys(alice); check.keyUpAcknowledgedAtMs = Date.now();
        check.runnerHoldAfterKeydownAckMs = check.keyUpDispatchedAtMs - check.keyDownAcknowledgedAtMs;
      };
      // Observe alongside the unchanged 740 ms hold. A delayed DOM read never
      // extends the runner's wait before it sends keyup.
      const sample = async () => { await delay(350); check.uiDuring = await restoreUi().catch(error => ({ unavailable: error.message })); };
      await Promise.all([hold(), sample()]);
      await waitView(alice, current => current.phase === 'racing' && current.you.lane?.resets === 1, 'held reset charges a real five-second penalty');
      await expect(alice.page.locator('.tb-race-timer small')).toContainText('+5');
      check.status = 'passed';
      saved.reset = { resets: view(alice).you.lane.resets, shownPenaltyText: await alice.page.locator('.tb-race-timer small').textContent() };
    } catch (error) { check.status = 'failed'; check.error = error.message; throw error; }
    finally {
      await keys(alice); await Promise.allSettled([...alice.actionReceiptReads]);
      check.uiAfter = await restoreUi().catch(error => ({ unavailable: error.message }));
      check.commands = report.restoreCommands.filter(command => command.profile === alice.name && command.observedRequestAtMs >= check.startedAtMs);
      delete alice.activeRestoreCheck;
      await emitEvidence('restore-check', check);
    }
  }
  const deadline = Date.now() + 115000;
  let disconnected = false, restarted = false, snapshots = false;
  while (Date.now() < deadline) {
    captureDriveStage(trace, [alice, bob]);
    const current = [alice, bob].map(player => view(player));
    if (current.every(state => state?.stage === stage && state.phase === 'debrief')) break;
    for (const player of [alice, bob]) {
      const lane = view(player)?.you.lane;
      if (lane) { for (const event of lane.events) seen.get(player.name).set(event.id, event); maxCharge[player.name] ??= lane.car.charge; }
    }
    if (!snapshots && current.every(state => state?.you.lane?.tick > 150)) {
      for (const player of [alice, bob]) await keys(player, ['Space']);
      for (const player of [alice, bob]) {
        const renderer = await player.page.locator('canvas.tb-scene-canvas').getAttribute('data-renderer');
        await inspect(player, `stage-${stage + 1}-race-${renderer}`, { race: true, low: true });
      }
      for (const player of [alice, bob]) await focusLane(player);
      snapshots = true;
    }
    if (stage === 0 && !disconnected && current[1]?.you.lane?.car.position.z > 5 && current[1]?.you.lane?.car.position.z < 20) {
      for (const player of [alice, bob]) await keys(player, ['Space']);
      saved.disconnect = await reconnect(bob, roomId); disconnected = true; await focusLane(alice);
    }
    if (stage === 1 && !restarted && current[0]?.you.lane?.gatesPassed >= 1 && current[0]?.you.lane?.gatesPassed < 3) {
      saved.restart = await restartDuringRace(alice, bob); restarted = true;
    }
    await Promise.all([alice, bob].map(keyboardDrive)); await delay(25);
  }
  for (const player of [alice, bob]) await keys(player);
  for (const player of [alice, bob]) await waitView(player, current => current.phase === 'debrief' && current.stage === stage, `stage ${stage + 1} completed`, 3000);
  const resultA = view(alice).stages[stage]; const resultB = view(bob).stages[stage];
  assert.deepEqual(resultA, resultB, 'Both browser profiles must see the same committed stage protocol');
  assert.equal(resultA.results.length, 4);
  for (const player of [alice, bob]) {
    const result = resultA.results.find(row => row.participantId === view(player).you.participantId);
    assert.equal(result.finished, true, `${player.name}: keyboard-driven ${saved.track} trial did not finish: ${JSON.stringify(result)}`);
    assert.ok(result.delivered > 0, `${player.name}: trial must deliver surviving cargo`);
    saved.events[player.name] = Object.fromEntries(['loaded', 'picked-up', 'damaged', 'lost', 'broken', 'gate', 'restored', 'delivered'].map(kind => [kind, (resultA.events[view(player).you.participantId] ?? []).filter(event => event.kind === kind).length]));
  }
  if (stage === 0) {
    assert.equal(disconnected, true, 'Online reconnect was exercised');
    const participantId = view(alice).you.participantId;
    const result = resultA.results.find(row => row.participantId === participantId);
    assert.equal(result.resets, 1);
    const delivered = resultA.events[participantId].find(event => event.kind === 'delivered'); assert.ok(delivered);
    assert.equal(result.elapsedTicks - delivered.tick, 300, 'Committed scoring adds 300 ticks for the one reset');
    saved.reset.penaltySeconds = (result.elapsedTicks - delivered.tick) / 60;
  }
  if (stage === 1) assert.equal(restarted, true, 'Online server restart was exercised');
  saved.results = resultA.results; saved.sameProtocol = true;
  for (const player of [alice, bob]) {
    await expect(player.page.locator('.tb-results')).toBeVisible();
    const detail = player.page.locator('.tb-stage-record details').first(); await detail.locator('summary').click(); await expect(detail).toHaveAttribute('open', '');
  }
  for (const player of [alice, bob]) await action(player, player.page.locator('.tb-results-footer').getByRole('button', { name: new RegExp(label(player, '^Дальше', '^Continue')) }), 'confirm');
  return saved;
}

async function cup(alice, bob) {
  const created = await scenario('Create four-seat room, invite/kick/reinvite, bots, ready and start through UI', () => createCup(alice, bob));
  const record = { ...created, mode: report.fullCupsMode, renderers: structuredClone(report.onlineRenderers.profiles), stages: [] }; report.cups.push(record);
  for (let stage = 0; stage < 3; stage++) {
    const builds = await scenario(`Cup stage ${stage + 1}: briefing and legal build controls`, () => buildStage(alice, bob, stage));
    const raced = await scenario(`Cup stage ${stage + 1}: two keyboard drivers and two bots`, () => driveStage(alice, bob, created.roomId, stage));
    record.stages.push({ ...raced, builds });
  }
  await Promise.all([alice, bob].map(player => waitView(player, current => current.phase === 'finished', 'committed final cup results')));
  assert.deepEqual(view(alice).standings, view(bob).standings);
  assert.equal(view(alice).stages.length, 3); assert.equal(view(alice).standings.length, 4);
  for (const player of [alice, bob]) {
    await expect(player.page.locator('.tb-results h1')).toHaveText(label(player, 'Кубок завершён', 'Cup complete'));
    const tabs = player.page.locator('.tb-stage-tabs button'); assert.equal(await tabs.count(), 3);
    for (let i = 0; i < 3; i++) { await tabs.nth(i).click(); await expect(tabs.nth(i)).toHaveAttribute('aria-pressed', 'true'); }
    await inspect(player, 'cup-results');
  }
  record.standings = view(alice).standings; record.status = 'completed'; report.fullCups++;
  return created;
}

async function assertVisibleStandings(player, standings) {
  const rows = player.page.locator('.tb-results .tb-table-wrap tbody tr');
  await expect(rows).toHaveCount(standings.length);
  for (let i = 0; i < standings.length; i++) {
    const standing = standings[i];
    const participant = view(player).players.find(value => value.participantId === standing.participantId);
    assert.ok(participant, 'Visible standing must refer to a current participant');
    const name = (participant.controller.kind === 'bot' ? label(player, 'Бот · ', 'Bot · ') : '') + participant.displayName;
    await expect(rows.nth(i).locator('th')).toHaveText(name);
    await expect(rows.nth(i).locator('td')).toHaveText([String(standing.place), String(standing.points), String(standing.delivered), String(standing.integrity), (standing.elapsedTicks / 60).toFixed(2)]);
  }
}

async function createTieRoom(alice, bob) {
  for (const player of [alice, bob]) await keys(player);
  await alice.page.goto(origin + '/games/test-bench');
  await alice.page.getByRole('button', { name: /^Создать комнату/ }).click();
  const creation = alice.page.getByRole('dialog', { name: 'Создать комнату' });
  await creation.getByLabel('Мест в комнате', { exact: true }).selectOption('2');
  let room = (await roomAction(alice, creation.getByRole('button', { name: /^Создать комнату/ }), '/rooms')).room;
  await expect(alice.page.locator('.tb-lobby')).toBeVisible();
  await alice.page.getByRole('button', { name: 'Настроить комнату', exact: true }).click();
  const options = alice.page.locator('dialog[open]');
  await options.getByLabel('Название', { exact: true }).fill('Targeted zero-score tie');
  room = (await roomAction(alice, options.getByRole('button', { name: 'Сохранить', exact: true }), '/settings')).room;
  await alice.page.getByRole('button', { name: /^Пригласить друга/ }).click();
  const friend = alice.page.locator('.tb-invite-row').filter({ hasText: bob.account.user.displayName });
  const invitation = (await roomAction(alice, friend.getByRole('button', { name: 'Пригласить', exact: true }), '/invitations')).invitation;
  await alice.page.locator('dialog[open]').getByRole('button', { name: 'Готово', exact: true }).click();
  // Same isolated recipient fixture as the baseline; all match actions use UI.
  await bob.account.request(`/invitations/${invitation.invitationId}/accept`, {});
  await bob.account.request(`/rooms/${room.roomId}/join`, {});
  await alice.page.reload(); await bob.page.goto(origin + '/rooms/' + room.roomId);
  await Promise.all([alice, bob].map(player => expect(player.page.locator('.tb-lobby')).toBeVisible()));
  await roomAction(alice, alice.page.getByRole('button', { name: /^Я готов/ }), '/ready');
  room = (await roomAction(bob, bob.page.getByRole('button', { name: /^I’m ready/ }), '/ready')).room;
  assert.equal(room.capacity, 2); assert.equal(room.members.length, 2);
  assert.ok(room.members.every(member => member.controller.kind === 'human'), 'The targeted tie room must contain zero bots');
  await expect(alice.page.getByRole('button', { name: /Начать кубок/ })).toBeEnabled();
  await roomAction(alice, alice.page.getByRole('button', { name: /Начать кубок/ }), '/start');
  await Promise.all([alice, bob].map(player => waitView(player, current => current.roomId === room.roomId, 'targeted two-account tie match starts')));
  assert.equal(view(alice).matchId, view(bob).matchId);
  assert.equal(view(alice).players.length, 2);
  assert.ok(view(alice).players.every(player => player.controller.kind === 'human'));
  return { roomId: room.roomId, matchId: view(alice).matchId };
}

async function zeroScoreTieCup(alice, bob) {
  const created = await createTieRoom(alice, bob);
  const record = { kind: 'Targeted zero-score tie cup; not a normal driven/bot cup', ...created, humans: 2, bots: 0, timerJumps: 0, unchangedPreset: 'universal', stages: [] };
  report.extendedCoverage.zeroScoreTieCup.progress = record;
  const beforeActions = Object.fromEntries(['blueprint', 'interact', 'restore'].map(type => [type, report.observedGameActions[type] ?? 0]));
  for (const player of [alice, bob]) player.neutralObservation = { matchId: created.matchId, count: 0, violationCount: 0, violations: [] };
  try {
    for (let stage = 0; stage < 3; stage++) {
      console.info(`[test-bench browser] Targeted zero-score tie: stage ${stage + 1}/3, real 65-second deadline`);
      for (const player of [alice, bob]) await waitView(player, current => current.matchId === created.matchId && current.stage === stage && ['briefing', 'building'].includes(current.phase), 'targeted tie briefing');
      for (const player of [alice, bob]) if (view(player).phase === 'briefing') await action(player, player.page.locator('.tb-briefing').getByRole('button', { name: new RegExp(label(player, '^К сборке', '^To the workshop')) }), 'confirm');
      await Promise.all([alice, bob].map(player => waitView(player, current => current.phase === 'building' && current.stage === stage, 'targeted tie workshop')));
      for (const player of [alice, bob]) {
        assert.deepEqual(view(player).you.build.blueprint, policy.PRESETS.universal, 'The tie keeps the untouched default legal build');
        assert.equal(view(player).you.build.revision, 0); assert.equal(view(player).you.edits, 0);
        await action(player, player.page.locator('.tb-builder-actions').getByRole('button', { name: new RegExp(label(player, '^Готов', '^Ready')) }), 'ready');
      }
      await Promise.all([alice, bob].map(player => waitView(player, current => current.stage === stage && current.phase === 'countdown', 'targeted tie real countdown')));
      await Promise.all([alice, bob].map(player => waitView(player, current => current.stage === stage && current.phase === 'racing', 'targeted tie real trial begins', 8000)));
      const started = performance.now();
      const initialTicks = [alice, bob].map(player => view(player).you.lane.tick);
      const progress = []; let lastProgressAt = -10000;
      for (const player of [alice, bob]) { await focusLane(player); await keys(player, ['Space']); }
      await until(() => {
        if (![alice, bob].every(fresh)) return false;
        const states = [alice, bob].map(player => view(player));
        if (states.every(current => current.phase === 'debrief' && current.stage === stage)) return true;
        for (const player of [alice, bob]) {
          const current = view(player);
          assert.equal(current.matchId, created.matchId); assert.equal(current.stage, stage);
          assert.ok(['racing', 'debrief'].includes(current.phase), 'A real tie trial must reach its normal debrief');
          assert.equal(player.neutralObservation.violationCount, 0, 'Only neutral/braking input frames are permitted in the targeted tie');
          if (current.phase === 'racing') {
            const lane = current.you.lane;
            assert.equal(lane.resets, 0); assert.equal(lane.gatesPassed, 0);
            assert.ok(lane.cargo.every(cargo => cargo.status === 'at-dock'), 'The zero-score fixture never loads cargo');
          }
        }
        const elapsed = performance.now() - started;
        if (elapsed - lastProgressAt >= 10000) {
          lastProgressAt = elapsed;
          const sample = { elapsedWallMs: Math.round(elapsed), ticks: states.map(current => current.you.lane?.tick ?? null) };
          progress.push(sample); console.info(`[test-bench browser] Tie stage ${stage + 1} awaiting normal timeout: ${JSON.stringify(sample)}`);
        }
        return false;
      }, `both real 65-second deadlines in targeted tie stage ${stage + 1}`, 100000, 100);
      const observedRaceWaitMs = Math.round(performance.now() - started);
      const expectedRemainingMs = (3900 - Math.max(...initialTicks)) / 60 * 1000;
      assert.ok(observedRaceWaitMs >= expectedRemainingMs - 500, 'The real race must consume its remaining 65-second duration; no accelerated clock');
      for (const player of [alice, bob]) await keys(player);
      const committed = view(alice).stages[stage];
      assert.deepEqual(committed, view(bob).stages[stage]); assert.equal(committed.results.length, 2);
      for (const result of committed.results) {
        assert.deepEqual({ finished: result.finished, points: result.points, delivered: result.delivered, integrity: result.integrity, elapsedTicks: result.elapsedTicks, resets: result.resets, place: result.place }, { finished: false, points: 0, delivered: 0, integrity: 0, elapsedTicks: 3900, resets: 0, place: 1 });
        assert.deepEqual(committed.blueprints[result.participantId], policy.PRESETS.universal);
        const events = committed.events[result.participantId];
        assert.ok(events.some(event => event.kind === 'timeout' && event.tick === 3900), 'The public protocol must record the actual 3900-tick timeout');
        assert.ok(!events.some(event => ['loaded', 'picked-up', 'restored', 'delivered'].includes(event.kind)));
      }
      for (const player of [alice, bob]) await assertVisibleStandings(player, view(player).standings);
      record.stages.push({ stage, trackId: committed.trackId, mirrored: committed.mirrored, deadlineSeconds: 65, initialTicks, observedRaceWaitMs, results: committed.results, progress });
      for (const player of [alice, bob]) await action(player, player.page.locator('.tb-results-footer').getByRole('button', { name: new RegExp(label(player, '^Дальше', '^Continue')) }), 'confirm');
    }
    await Promise.all([alice, bob].map(player => waitView(player, current => current.matchId === created.matchId && current.phase === 'finished', 'targeted zero-score tie cup finishes')));
    const standings = view(alice).standings;
    assert.deepEqual(standings, view(bob).standings); assert.equal(standings.length, 2); assert.equal(view(alice).stages.length, 3);
    for (const standing of standings) assert.deepEqual({ place: standing.place, points: standing.points, delivered: standing.delivered, integrity: standing.integrity, elapsedTicks: standing.elapsedTicks }, { place: 1, points: 0, delivered: 0, integrity: 0, elapsedTicks: 11700 });
    for (const player of [alice, bob]) {
      await expect(player.page.locator('.tb-results h1')).toHaveText(label(player, 'Кубок завершён', 'Cup complete'));
      await expect(player.page.locator('.tb-protocol-heading > p')).toContainText(alice.account.user.displayName);
      await expect(player.page.locator('.tb-protocol-heading > p')).toContainText(bob.account.user.displayName);
      await assertVisibleStandings(player, standings); await inspect(player, 'extended-zero-score-tie-results');
      assert.equal(player.neutralObservation.violationCount, 0); assert.ok(player.neutralObservation.count > 20);
    }
    for (const type of Object.keys(beforeActions)) assert.equal(report.observedGameActions[type] ?? 0, beforeActions[type], `The tie must issue no ${type} gameplay action`);
    record.standings = standings;
    record.inputObservations = [alice, bob].map(player => ({ profile: player.name, ...player.neutralObservation }));
    report.extendedCoverage.targetedZeroScoreTieCups++;
    return record;
  } finally { for (const player of [alice, bob]) { await keys(player); delete player.neutralObservation; } }
}

async function returnToOriginalCup(alice, bob, original) {
  const observations = [];
  for (const player of [alice, bob]) {
    const priorConnection = player.socketConnections;
    await keys(player); await player.page.goto(origin + '/rooms/' + original.roomId);
    await waitView(player, current => player.snapshotConnection > priorConnection && current.matchId === original.matchId && current.roomId === original.roomId && current.phase === 'finished', 'a new room connection restores the original finished four-seat cup');
    assert.deepEqual(view(player).standings, original.standings);
    assert.deepEqual(view(player).stages, original.stages);
    assert.equal(view(player).players.length, 4);
    assert.equal(view(player).players.filter(value => value.controller.kind === 'bot').length, 2);
    await expect(player.page.locator('.tb-results h1')).toHaveText(label(player, 'Кубок завершён', 'Cup complete'));
    await assertVisibleStandings(player, original.standings);
    observations.push({ profile: player.name, priorConnection, restoredSnapshotConnection: player.snapshotConnection, restoredEpoch: player.snapshot.epoch });
  }
  return { originalRoomId: original.roomId, originalMatchId: original.matchId, profiles: 2, observations, savedStandingsIdentical: true, savedStagesIdentical: true, normalFourSeatCup: true, readyForOriginalRematch: true };
}

async function rematch(alice, bob, prior) {
  const result = await roomAction(alice, alice.page.locator('.tb-results-footer').getByRole('button', { name: /^Реванш/ }), '/rooms');
  await expect(alice.page.locator('.tb-lobby')).toBeVisible();
  const roomId = result.room.roomId; assert.notEqual(roomId, prior.roomId);
  const room = (await alice.account.request('/rooms/' + roomId)).room;
  assert.equal(room.members.filter(member => member.controller.kind === 'bot').length, 2);
  const invitations = (await bob.account.request('/invitations')).invitations;
  const invitation = invitations.find(value => value.roomId === roomId && value.status === 'pending');
  assert.ok(invitation, 'The UI rematch must invite the human friend');
  await bob.account.request(`/invitations/${invitation.invitationId}/accept`, {}); await bob.account.request(`/rooms/${roomId}/join`, {});
  await bob.page.goto(origin + '/rooms/' + roomId); await alice.page.reload();
  await roomAction(alice, alice.page.getByRole('button', { name: /^Я готов/ }), '/ready');
  await roomAction(bob, bob.page.getByRole('button', { name: /^I’m ready/ }), '/ready');
  await expect(alice.page.getByRole('button', { name: /Начать кубок/ })).toBeEnabled();
  await roomAction(alice, alice.page.getByRole('button', { name: /Начать кубок/ }), '/start');
  await waitView(alice, current => current.roomId === roomId && current.matchId !== prior.matchId, 'new rematch begins');
  return { newRoom: true, newMatch: view(alice).matchId !== prior.matchId, botSeatsPreserved: 2, friendInvited: true, startedFromUi: true, fullRematchCupPlayed: false };
}

let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    let failure;
    try { for (const close of [() => browser?.close(), () => relay?.close(), stop]) { try { await close(); } catch (error) { failure ??= error; } } }
    finally { await rm(directory, { recursive: true, force: true }); if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true }); }
    if (failure) throw failure;
  })(); return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); });

let failure;
try {
  await mkdir(output, { recursive: true });
  for (const file of ['dist-platform/main.js', 'dist-platform/test-bench-worker.js', 'apps/portal/dist/index.html']) {
    assert.ok((await stat(join(root, file)).catch(() => null))?.isFile(), 'Run npm run build:foundation before browser acceptance');
  }
  report.builtMainSha256 = digest(await readFile(join(root, 'dist-platform/main.js')));
  report.builtWorkerSha256 = digest(await readFile(join(root, 'dist-platform/test-bench-worker.js')));
  report.builtIndexSha256 = digest(await readFile(join(root, 'apps/portal/dist/index.html')));
  report.runnerSha256 = digest(await readFile(fileURLToPath(import.meta.url)));
  report.qaDriverSha256 = digest(await readFile(join(root, 'games/test-bench/scripts/qa-driver.ts')));
  fixtureDirectory = await mkdtemp(join(root, '.qa', 'test-bench-driver-'));
  await build({ root, configFile: false, logLevel: 'error', build: { ssr: join(root, 'games/test-bench/scripts/qa-driver.ts'), target: 'node22', outDir: fixtureDirectory, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'qa-driver.mjs' } } } });
  policy = await import(pathToFileURL(join(fixtureDirectory, 'qa-driver.mjs')).href);
  port = await availablePort(); if (latencyMs) relay = await delayedLoopback(port, latencyMs);
  origin = `http://127.0.0.1:${relay?.port ?? port}`; await start();
  await requiredScope('nodeCalibration', 'Node direct/backend and configured-path calibration before launching Chromium', nodePathCalibration);
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ...(process.env.IVA_CHROMIUM_PATH ? { executablePath: process.env.IVA_CHROMIUM_PATH } : {}) });
  report.browserVersion = browser.version();
  await emitEvidence('identity', buildIdentity());
  const accountA = await new Account().register('bench_ui_alice'), accountB = await new Account().register('bench_ui_bob');
  assert.notEqual(accountA.cookie, accountB.cookie);
  const friendship = await accountA.request('/friend-requests', { playerId: accountB.user.playerId });
  await accountB.request(`/friend-requests/${friendship.requestId}/accept`, {});
  const alice = await makePlayer(accountA, 'alice', 'ru'), bob = await makePlayer(accountB, 'bob', 'ru', true);
  await requiredScope('coldHome', 'Capture the complete first-home browser transfer estimate before settings', async () => {
    for (const player of [alice, bob]) await player.page.goto(origin + '/games/test-bench');
    // Both fresh measurements must settle before any settings/navigation from
    // a later independent scope; one failure must not race the other capture.
    const captured = await Promise.allSettled([alice, bob].map(measureColdTransfer));
    const errors = captured.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'One or both cold-home measurements failed');
    await expect(alice.page.locator('canvas.tb-scene-canvas')).toHaveAttribute('data-renderer', '3d');
    await expect(bob.page.locator('canvas.tb-scene-canvas')).toHaveAttribute('data-renderer', '3d');
  });
  await requiredScope('preferences', 'Home scenes, RU/EN preferences, focus and settings errors', async () => scenario('Home scenes, RU/EN preferences, focus and settings errors', async () => {
    for (const player of [alice, bob]) {
      await player.page.goto(origin + '/games/test-bench');
      player.locale = await player.page.locator('main.tb-app').getAttribute('lang');
    }
    await settings(alice, { exhaustive: true, renderer: '3d', quality: 'low' });
    await settings(bob, { locale: 'en', renderer: '2d', quality: 'low', exhaustive: true });
    await inspect(alice, 'home-ru-3d', { low: true }); await inspect(bob, 'home-en-2d');
    return { independentContexts: 2, localizations: ['ru', 'en'], renderers: ['3d', '2d'], keyRebindAndReset: true, duplicateKeyError: true, text130: true };
  }));
  await requiredScope('practice', 'Independent practice: catalog, loaded comparison, pause, WebGL loss and short touch layout', async () => {
    await prepareProfile(alice, 'ru', '3d'); await prepareProfile(bob, 'en', '2d');
    await practiceChecks(alice, bob);
  });
  const lesson = await requiredScope('tutorial', 'Independent six-step tutorial with actual local physics', async () => {
    await prepareProfile(alice, 'ru', '3d');
    return scenario('Complete the six-step tutorial through visible HUD and real keys', () => tutorial(alice));
  });
  if (!lesson.ok) report.tutorial = 'failed';
  await requiredScope('onlinePreparation', 'Configure both online renderers through normal settings UI', async () => {
    const renderers = [await prepareProfile(alice, 'ru', '2d'), await prepareProfile(bob, 'en', '2d')];
    report.onlineRenderers = { mode: '2D protocol/controller diagnostic', reason: 'Both profiles use 2D after the observed candidate 7 Direct 3D Precision failure; separate 3D practice, tutorial and fault checks remain required', prior3dFailure: { candidate: 7, jobId: 141033750423, profile: 'alice', track: 'precision', result: 'Not finished at the real 3900-tick deadline', hardwarePerformanceAccepted: false }, profiles: renderers };
  });
  await requiredScope('browserNetwork', 'Resource Timing path interval and separate JavaScript completion after renderer settings', () => browserPathProbe(alice), ['onlinePreparation']);
  // A failed measurement/practice/tutorial still makes the overall run fail,
  // but does not suppress independent online evidence through normal UI.
  const finished = await requiredScope('normalCup', 'Automated 2D normal three-stage cup: two keyboard drivers and two explicit bots', () => cup(alice, bob), ['onlinePreparation']);
  const original = finished.ok ? { ...finished.value, standings: structuredClone(view(alice).standings), stages: structuredClone(view(alice).stages) } : null;
  if (extended) {
    const pickup = await requiredScope('looseCargoPickup', 'Independent extended surviving loose-cargo pickup after the normal cup attempt', async () => {
      await prepareProfile(bob, 'en', '2d');
      return extendedScenario('looseCargoPickup', 'Extended: survive a real cargo fall, collect it with E and retain all three cells', () => survivingLoosePickup(bob));
    });
    if (!pickup.ok && report.extendedCoverage.looseCargoPickup.status === 'not started') report.extendedCoverage.looseCargoPickup = { status: 'blocked', error: 'Normal UI preparation for this independent target failed' };
    const tie = await requiredScope('zeroScoreTieCup', 'Independent targeted zero-score tie with three real deadlines', async () => {
      await prepareProfile(alice, 'ru', '2d'); await prepareProfile(bob, 'en', '2d');
      return extendedScenario('zeroScoreTieCup', 'Extended: separate zero-score tie cup, two humans, no bots, three real deadlines', () => zeroScoreTieCup(alice, bob));
    });
    if (!tie.ok && report.extendedCoverage.zeroScoreTieCup.status === 'not started') report.extendedCoverage.zeroScoreTieCup = { status: 'blocked', error: 'Normal UI preparation for this independent target failed' };
    const restored = await requiredScope('originalFinishedCupReturn', 'Restore and verify the saved normal cup before its rematch', () => extendedScenario('originalFinishedCupReturn', 'Extended: both profiles return to the saved original four-seat cup before its rematch', () => returnToOriginalCup(alice, bob, original)), ['normalCup']);
    if (!restored.ok && report.extendedCoverage.originalFinishedCupReturn.status === 'not started') report.extendedCoverage.originalFinishedCupReturn = { status: 'blocked', error: 'The normal cup did not complete; there is no accepted saved final to restore' };
  }
  await requiredScope('rematch', 'Rematch of the completed normal cup', () => scenario('Rematch preserves explicit bots, invites the friend and starts a new cup', () => rematch(alice, bob, finished.value)), ['normalCup', ...(extended ? ['originalFinishedCupReturn'] : [])]);
  report.assetLoads = players.map(player => ({ profile: player.name, glbs: [...player.loadedAssets].filter(path => path.endsWith('.glb')).length, files: player.loadedAssets.size, receivedSnapshots: player.receivedFrames, sentInputFrames: player.sentInputs, socketConnections: player.socketConnections, socketCloses: player.socketCloses }));
  report.transport.inputToAcknowledgedSnapshotMs = players.map(player => ({ profile: player.name, ...timing(player.ackTimings) }));
  await requiredScope('observedErrors', 'All attempted scopes retain application, asset, action and transport errors', async () => {
    assert.deepEqual(report.browserErrors, [], 'Uncaught browser application errors');
    assert.deepEqual(report.failedAssets, [], 'Failed production game assets');
    assert.deepEqual(report.actionErrors, [], 'Unexpected rejected UI gameplay actions');
    for (const player of players) assert.deepEqual(player.transportErrors, [], `${player.name}: transport error frames`);
  });
  await requiredScope('completedCupEvidence', 'Completed-cup asset and input acknowledgement evidence', async () => {
    for (const player of players) assert.ok(player.ackTimings.length > 20, 'Actual browser input acknowledgements must be measured');
    assert.ok(report.assetLoads[0].glbs >= 30, 'The real renderer must load final exported GLBs across workshop and trials');
  }, ['normalCup']);
  if (report.requiredScopeFailures.length) throw new Error('Required browser scopes failed or were blocked: ' + report.requiredScopeFailures.map(scope => scope.id + ' (' + scope.status + ')').join(', '));
  report.status = 'passed automated scope';
} catch (error) {
  failure = error; report.status = 'failed'; report.error = error.stack ?? error.message;
  report.lastObserved = players.map(player => ({ profile: player.name, phase: view(player)?.phase, stage: view(player)?.stage, lane: view(player)?.you.lane ? { tick: view(player).you.lane.tick, position: view(player).you.lane.car.position, speed: view(player).you.lane.car.speed, yaw: view(player).you.lane.car.yaw, gates: view(player).you.lane.gatesPassed, cargo: view(player).you.lane.cargo.map(cargo => ({ status: cargo.status, health: cargo.health })) } : null }));
  report.failureScreens = [];
  for (const player of players) {
    // Keep the observed names and visible state in the console's final report:
    // CI deliberately uploads no screenshots, traces or report artifacts.
    report.failureScreens.push(await failureScreen(player).catch(problem => ({ profile: player.name, unavailable: problem.message })));
    await player.page.screenshot({ path: join(output, `${player.name}-failure.png`), fullPage: true }).catch(() => {});
    await writeFile(join(output, `${player.name}-failure.txt`), await player.page.locator('body').innerText().catch(() => 'Page unavailable'));
  }
} finally {
  const cargoEvents = report.cups.flatMap(value => value.stages).flatMap(value => Object.values(value.events ?? {}));
  if (!cargoEvents.some(value => value.lost > 0 && value['picked-up'] > 0) && report.extendedCoverage.looseCargoPickup.status !== 'passed') report.openCoverage.push('A surviving loose cargo pickup was not observed in this browser run; separate targeted exercise remains required');
  if (report.extendedCoverage.zeroScoreTieCup.status !== 'passed') report.openCoverage.push('An exact tied final result was not constructed by this real-input run; scoring tests are separate evidence');
  const incompleteColdProfiles = report.coldTransfers.filter(value => !value.budget.reliableCompleteMeasurement).map(value => value.profile);
  if (incompleteColdProfiles.length || report.coldTransfers.length < 2) report.openCoverage.push('A complete browser cold-transfer budget estimate remains unavailable for ' + (incompleteColdProfiles.join(', ') || 'one or both fresh profiles'));
  report.transport.inputToAcknowledgedSnapshotMs = players.map(player => ({ profile: player.name, ...timing(player.ackTimings) }));
  report.controller.profiles = players.map(player => {
    const { horizons, ...stats } = player.predictionStats;
    return { profile: player.name, ...stats, predictionHorizonMs: timing(horizons) };
  });
  await Promise.allSettled(players.flatMap(player => [...player.actionReceiptReads]));
  try { await cleanup(); } catch (error) { failure ??= error; report.status = 'failed'; report.cleanupError = error.message; }
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await emitEvidence('summary', compactFinalReport());
  for (const [kind, values] of [['browser-error', report.browserErrors], ['console-error', report.consoleErrors], ['failed-asset', report.failedAssets], ['action-error', report.actionErrors], ['expected-offline-asset', report.expectedOfflineAssetFailures]]) {
    for (const value of values.slice(0, 40)) await emitEvidence(kind, value);
    if (values.length > 40) await emitEvidence(kind + '-omitted', { count: values.length - 40, location: 'Ignored local report' });
  }
  for (const player of players) if (player.transportErrors.length) await emitEvidence('transport-errors', { profile: player.name, count: player.transportErrors.length, first: player.transportErrors.slice(0, 40) });
  for (const screen of report.failureScreens ?? []) await emitEvidence('final-screen', screen);
}
// Drain the awaited stdout writes before a nonzero exit. Candidate 6's final
// single records were truncated at exactly 65,536 UTF-8 bytes in CI logs.
if (failure) process.exitCode = 1;
