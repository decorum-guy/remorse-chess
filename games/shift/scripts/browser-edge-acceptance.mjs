/** Controlled checkpoint fixtures, real built UI, authenticated HTTP/WS, real server decisions.
 * Existing in-process advanceTicks controls the clock. These are NOT ordinary matches.
 * Everything, including local accounts/mail/DB/browser state, remains under ignored .qa.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import { build } from 'vite';

// This script is runnable both from its reviewed staging location and after promotion.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8',
}).trim();
const { ShiftDemoClient, createShiftDemoRoom } = await import(pathToFileURL(join(ROOT, 'games/shift/scripts/demo.mjs')).href);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  assert.ok(index < 0 || (args[index + 1] && !args[index + 1].startsWith('--')), `Value required for ${name}`);
  return index < 0 ? fallback : args[index + 1];
};
if (args.includes('--help')) {
  process.stdout.write('Usage: node games/shift/scripts/browser-edge-acceptance.mjs [--cycle LABEL] [--browser PATH] [--port 4418]\nRuns three controlled edge fixtures, four role/key recap cases, and rematch readiness. Requires build:foundation and Playwright Chromium.\n');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) assert.ok(['--cycle', '--browser', '--port'].includes(args[i]), `Unknown option ${args[i]}`);
const cycle = option('--cycle', 'ci');
assert.match(cycle, /^[a-zA-Z0-9_-]{1,40}$/, 'Cycle is a short safe report label');
const port = Number(option('--port', '4418'));
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, 'Use an isolated unprivileged loopback port');
const browserPath = option('--browser', process.env.SHIFT_EDGE_BROWSER_PATH || null);
const QA = join(ROOT, '.qa/shift-browser-edge');
await mkdir(QA, { recursive: true, mode: 0o700 });
const runDirectory = await mkdtemp(join(QA, `cycle-${cycle}-`));
const portal = join(runDirectory, 'portal');
await cp(join(ROOT, 'apps/portal/dist'), portal, { recursive: true, dereference: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  classification: 'Controlled checkpoint fixtures in actual built UI over authenticated local HTTP/WS. Three edges, four role/key recap cases, and rematch readiness. Zero ordinary matches, personal full matches, physical devices or real audio listening.',
  cycle, ordinaryMatches: 0, personallyPlayedFullMatches: 0,
  method: 'Existing autoTick:false/advanceTicks drives authoritative ticks. A private entry point compiles unchanged production runtime source; it is not dist-platform/main.js. Checkpoints are prepared with the runtime closed. No production endpoint, altered rule, fake view or forced result.',
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  dirtyWorktree: !!execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  platformBuildSha256: hash(await readFile(join(ROOT, 'dist-platform/main.js'))),
  portalFiles: {}, sourceHashes: {}, fixtures: [], errors: [], passed: false,
};
async function hashFiles(directory, prefix, target) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await hashFiles(path,key,target); else if(entry.isFile()) target[key]=hash(await readFile(path));
  }
}
await hashFiles(portal,'',report.portalFiles);
for (const path of ['games/shift/src','apps/platform/src','packages/session-kit/src']) await hashFiles(join(ROOT,path),path,report.sourceHashes);
report.portalTreeSha256=hash(JSON.stringify(report.portalFiles));
report.sourceTreeSha256=hash(JSON.stringify(report.sourceHashes));
report.harnessSha256=hash(await readFile(fileURLToPath(import.meta.url)));
// Generated under ignored QA, never imported by the production application.
const fixtureEntry = join(runDirectory, 'runtime-entry.ts');
const from = path => JSON.stringify(join(ROOT, path));
await writeFile(fixtureEntry, `
import { PlatformService } from ${from('apps/platform/src/service.ts')};
import { createPlatformHttpServer } from ${from('apps/platform/src/http.ts')};
import { loadPlatformConfig } from ${from('apps/platform/src/config.ts')};
import { createShiftRegistration } from ${from('games/shift/src/server/runtime.ts')};
export { stepMatch, TIMING, worldPosition, WIRE_VERSION, RULES_VERSION, CONTENT_VERSION } from ${from('games/shift/src/core/index.ts')};
export { LIVE_PROTOCOL, parseLiveClientFrame } from ${from('packages/session-kit/src/index.ts')};
export async function startControlledServer(directory: string, port: number, portal: string) {
  const origin = 'http://127.0.0.1:' + port;
  const config = loadPlatformConfig({ NODE_ENV: 'development', PLATFORM_HOST: '127.0.0.1', PLATFORM_PORT: String(port),
    PORTAL_ORIGIN: origin, PLATFORM_DATABASE_PATH: directory + '/platform.sqlite',
    PLATFORM_LAB_DATABASE_PATH: directory + '/runtime.sqlite', MAIL_MODE: 'file', MAIL_FILE_DIRECTORY: directory + '/mail',
    TELEGRAM_ENABLED: 'false', TELEGRAM_AUTH_ENABLED: 'false', PORTAL_DIST_DIRECTORY: portal });
  const shift = createShiftRegistration({ databasePath: config.runtimeDatabasePath, autoTick: false });
  const platform = new PlatformService({ databasePath: config.databasePath, publicOrigin: config.publicOrigin, mail: config.mail, games: [shift] });
  await platform.ready;
  const server = createPlatformHttpServer(platform, { publicOrigin: config.publicOrigin, allowedOrigins: config.allowedOrigins,
    allowedHosts: config.allowedHosts, trustedProxyIps: config.trustedProxyIps, secureCookies: false, serveDirectory: portal });
  const timer = setInterval(() => { void platform.reconcile(); }, 1000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    clearInterval(timer); platform.stopReconciliation(); await platform.settle(); platform.close(); shift.close(); throw error;
  }
  return { runtime: shift.runtime, platform, origin,
    async pauseReconciliation() { clearInterval(timer); await platform.settle(); },
    async close() { clearInterval(timer); platform.stopReconciliation(); await server.shutdown(); await platform.settle(); platform.close(); shift.close(); } };
}
`);
await build({ root: ROOT, configFile: join(ROOT,'vite.platform.config.ts'), logLevel:'silent', build:{ssr:fixtureEntry,outDir:join(runDirectory,'runtime'),emptyOutDir:true,minify:false,rollupOptions:{output:{entryFileNames:'runtime.mjs'}}}});
const {startControlledServer,stepMatch,TIMING,worldPosition,WIRE_VERSION,RULES_VERSION,CONTENT_VERSION,LIVE_PROTOCOL,parseLiveClientFrame}=await import(pathToFileURL(join(runDirectory,'runtime/runtime.mjs')).href);
report.fixtureRuntimeSha256=hash(await readFile(join(runDirectory,'runtime/runtime.mjs')));
const log=value=>process.stdout.write(JSON.stringify(value)+'\n');
async function until(test,label,ms=12000){const end=Date.now()+ms;while(Date.now()<end){const result=await test();if(result)return result;await delay(25);}throw new Error('Timeout: '+label);}
async function bounded(promise,label,ms=6000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
const stopInput={moveX:0,moveZ:0,aim:0,fireHeld:false};

function checkpoint(file,matchId,room,hostId,guestId,kind){
  const db=new Database(file);const row=db.prepare('SELECT state FROM shift_matches WHERE match_id=?').get(matchId);assert.ok(row);
  const s=JSON.parse(row.state),host=room.members.find(m=>m.playerId===hostId).participantId,guest=room.members.find(m=>m.playerId===guestId).participantId;
  let initial;
  if(kind==='draw'||kind==='rematch'){
    // Build the preceding idle timeouts using actual rules, not invented result rows.
    for(const actor of Object.values(s.actors)){actor.connected=true;actor.disconnectedAtTick=null;actor.input={...stopInput};}
    let ticks=0;while(!(s.round===6&&s.phase==='active'&&s.phaseEndsAtTick-s.tick===1)){stepMatch(s);if(++ticks>20000)throw new Error('Draw seed did not reach last tiebreak tick');}
    initial={preparation:'Five real core timeout rounds and all but the last tiebreak tick advanced without controller input; controlled fixture history, not browser matches.',preparedTicks:ticks};
  }else{
    s.phase='active';s.tick=TIMING.preparation+TIMING.round-20;s.phaseEndsAtTick=TIMING.preparation+TIMING.round;s.roundStartedAtTick=TIMING.preparation;
    for(const actor of Object.values(s.actors)){actor.hp=3;actor.shieldUntilTick=0;actor.respawnAtTick=null;actor.nextShotTick=0;actor.chargeTicks=0;actor.input={...stopInput};actor.lastInputTick=s.tick;actor.connected=true;actor.disconnectedAtTick=null;}
    if(kind==='threshold'||kind==='keyboard'){
      const enemy=Object.values(s.actors).find(a=>a.team==='amber'&&a.role==='pilot');
      Object.assign(s.actors[guest],{spaceId:'O',x:-4,z:0});Object.assign(enemy,{spaceId:'A',x:3.95,z:0});
      s.phaseEndsAtTick=s.tick+(kind==='keyboard'?2:1000);stepMatch(s);
      initial={pilotId:guest,enemyId:enemy.seatId,pilotPose:{spaceId:'O',x:-4,z:0},enemyPose:{spaceId:'A',x:3.95,z:0},preparation:'Persisted last confirmed threshold poses; one ordinary no-input core tick computes permitted visibility.'};
    }else{
      Object.assign(s.actors[host],{spaceId:'west',x:-.7,z:0,hp:1});Object.assign(s.actors[guest],{spaceId:'west',x:.7,z:0,aim:Math.PI});
      s.battery={mode:'carried',carrierId:host,spaceId:'west',x:-.7,z:0,returnAtTick:null};
      for(let i=0;i<19;i++)stepMatch(s);
      assert.equal(s.actors[host].chargeTicks,19);assert.equal(s.phaseEndsAtTick-s.tick,1);
      initial={carrierId:host,shooterId:guest,carrierHP:1,chargeTicks:19,ticksToTimeout:1,preparation:'Starting poses and possession seeded; gate charge 19/20 produced by nineteen actual no-input core ticks.'};
    }
  }
  // Keep fixture navigator bots in their existing scheduled-decision wait; pilots retain normal policy.
  for(const seat of s.seats)if(seat.bot&&s.actors[seat.seatId].role==='navigator')s.botMemory[seat.seatId]={seq:0,counter:0,nextDecisionTick:s.tick+10000,recentRooms:[]};
  db.prepare('UPDATE shift_matches SET state=?,finished=0 WHERE match_id=?').run(JSON.stringify(s),matchId);db.close();
  return {kind,host,guest,...initial,tick:s.tick,round:s.round,phase:s.phase,score:s.score,board:s.board,priorRounds:s.rounds};
}
async function seedRoom(service,host,guest,kind){
  let room=await createShiftDemoRoom(host,guest,{teamSize:2,arena:'foundry',sameTeam:kind==='threshold'||kind==='keyboard',hostRole:kind==='threshold'||kind==='keyboard'?'navigator':'pilot',rotateRoles:false,difficulty:'easy'});
  if(kind!=='threshold'&&kind!=='keyboard'){
    const initialNavigators={};for(const team of ['teal','amber'])initialNavigators[team]=room.members.find(m=>room.settings.teams[m.participantId]===team&&m.controller.kind==='bot').participantId;
    room=(await host.request(`/rooms/${room.roomId}/settings`,{expectedRevision:room.revision,settings:{...room.settings,initialNavigators}})).room;
  }
  await host.request(`/rooms/${room.roomId}/ready`,{expectedRevision:room.revision,ready:true});
  await guest.request(`/rooms/${room.roomId}/ready`,{expectedRevision:room.revision,ready:true});
  room=(await host.request(`/rooms/${room.roomId}/start`,{expectedRevision:room.revision})).room;
  await service.platform.reconcile();
  return until(async()=>{const r=(await host.request(`/rooms/${room.roomId}`)).room;return r.state==='playing'&&r.matchId?r:null;},'normal room start');
}
const scopeOf = ({ protocol, wireVersion, roomId, matchId, epoch }) => ({ protocol, wireVersion, roomId, matchId, epoch });
function immutableJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutableJson(child);
    Object.freeze(value);
  }
  return value;
}
function auditServerFrame(frame, roomId, previousScope) {
  assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame));
  assert.equal(frame.protocol, LIVE_PROTOCOL); assert.equal(frame.wireVersion, WIRE_VERSION);
  assert.equal(frame.roomId, roomId); assert.equal(frame.gameId, 'shift');
  assert.equal(frame.rulesVersion, RULES_VERSION); assert.equal(frame.contentVersion, CONTENT_VERSION);
  assert.equal(typeof frame.matchId, 'string'); assert.ok(frame.matchId.length > 0);
  assert.equal(typeof frame.epoch, 'string'); assert.ok(frame.epoch.length > 0);
  const scope = scopeOf(frame);
  if (previousScope) assert.deepEqual(scope, previousScope, 'A socket keeps its authenticated shared scope');
  const fields = ['protocol', 'wireVersion', 'roomId', 'matchId', 'epoch', 'gameId', 'rulesVersion', 'contentVersion', 'type'];
  if (frame.type === 'snapshot') {
    fields.push('tick', 'serverTime', 'lastAcceptedSeq', 'view');
    assert.ok(Number.isSafeInteger(frame.tick) && frame.tick >= 0);
    assert.ok(Number.isFinite(frame.serverTime));
    assert.ok(Number.isSafeInteger(frame.lastAcceptedSeq) && frame.lastAcceptedSeq >= -1);
    assert.equal(frame.tick, frame.view.tick); assert.equal(frame.lastAcceptedSeq, frame.view.self.lastAcceptedSeq);
    assert.equal(frame.rulesVersion, frame.view.rulesVersion); assert.equal(frame.contentVersion, frame.view.contentVersion);
    assert.equal(frame.wireVersion, frame.view.wireVersion);
  } else if (frame.type === 'receipt') {
    fields.push('actionId', 'tick', 'result');
    assert.ok(Number.isSafeInteger(frame.tick) && frame.tick >= 0);
    assert.equal(frame.actionId, frame.result?.actionId);
    assert.equal(typeof frame.result?.accepted, 'boolean');
  } else {
    assert.equal(frame.type, 'error'); fields.push('code', 'message');
    if (Object.hasOwn(frame, 'actionId')) fields.push('actionId');
  }
  assert.deepEqual(Object.keys(frame).sort(), fields.sort(), 'Only the documented shared server fields cross the wire');
  return scope;
}

async function openPeer(browser,client,room,language,errors){
  const context=await browser.newContext({viewport:{width:1366,height:950},storageState:client.storageState()});
  await context.addInitScript(({language})=>{
    localStorage.setItem('iva-shift.preferences.v1',JSON.stringify({lang:language,mode:'2d',quality:'low',reducedMotion:false,effects:true,volume:0,ambience:0}));
    const NativeWebSocket=window.WebSocket;window.__shiftEdgeSocketLifecycles=[];
    window.WebSocket=class extends NativeWebSocket{
      constructor(url,protocols){
        super(url,protocols);
        if(!/\/api\/platform\/v1\/rooms\/[^/]+\/live$/.test(new URL(String(url),location.href).pathname))return;
        const lifecycle={matchId:null,epoch:null,phase:null,closed:false,closeCode:null};window.__shiftEdgeSocketLifecycles.push(lifecycle);
        this.addEventListener('message',event=>{try{const frame=JSON.parse(String(event.data));if(frame.type==='snapshot'&&frame.protocol==='iva-live@1'){lifecycle.matchId=frame.matchId;lifecycle.epoch=frame.epoch;lifecycle.phase=frame.view?.phase;}}catch{/* The wire observer validates payloads. */}});
        this.addEventListener('close',event=>{lifecycle.closed=true;lifecycle.closeCode=event.code;});
      }
    };
  },{language});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const peer={context,page,view:null,frames:0,commands:[],inputs:[],receipts:[],errors:[],language,scopeChecks:0,staleSocketFramesIgnored:0,wireCommandEnvelopes:new Map(),wireErrors:[],expectedLifecycleEvents:[]};
  page.on('pageerror',error=>{peer.errors.push(safeError(error));errors.push(safeError(error));});
  page.on('websocket',socket=>{
    const url=new URL(socket.url());
    if(!/\/api\/platform\/v1\/rooms\/[^/]+\/live$/.test(url.pathname))return;
    const fail=error=>{const message=safeError(error);peer.errors.push(message);errors.push(message);};
    try{
      assert.equal(url.pathname,`/api/platform/v1/rooms/${encodeURIComponent(room.roomId)}/live`);
      assert.equal(url.search,'');assert.equal(url.hash,'');assert.equal(url.username,'');assert.equal(url.password,'');
    }catch(error){fail(error);return;}
    peer.activeSocket=socket;let connectionScope=null,connectionPhase=null;
    socket.on('framereceived',({payload})=>{try{
      const f=JSON.parse(String(payload)),scope=auditServerFrame(f,room.roomId,connectionScope);
      if(!connectionScope)assert.equal(f.type,'snapshot','First shared frame is a full personalized snapshot');
      connectionScope=scope;peer.scopeChecks++;
      if(f.type==='snapshot')connectionPhase=f.view.phase;
      if(f.type==='error'){
        const message='wire:'+f.code;peer.errors.push(message);errors.push(message);
        peer.wireErrors.push({code:f.code,scope,phase:connectionPhase,at:performance.now(),message});return;
      }
      if(peer.activeSocket!==socket){peer.staleSocketFramesIgnored++;return;}
      if(f.type==='snapshot'){peer.liveScope=scope;peer.view=immutableJson(f.view);peer.frames++;}
      else if(f.type==='receipt'){assert.equal(f.result.seatId,peer.view.self.seatId);peer.receipts.push(immutableJson(f));}
    }catch(error){fail(error);}});
    socket.on('framesent',({payload})=>{try{
      assert.ok(connectionScope,'Client waits for its shared scope');
      const f=parseLiveClientFrame(JSON.parse(String(payload)),connectionScope);peer.scopeChecks++;
      if(f.type==='command'){
        assert.equal(f.actionId,f.payload.actionId);
        if(f.payload.type==='shift')assert.equal(f.expectedRevision,f.payload.expectedBoardRevision);
        const key=`${f.matchId}:${f.actionId}`,envelope={actionId:f.actionId,expectedRevision:f.expectedRevision,payload:f.payload};
        const prior=peer.wireCommandEnvelopes.get(key);
        if(prior)assert.deepEqual(envelope,prior,'UI retries preserve payload and revision across sockets');
        else peer.wireCommandEnvelopes.set(key,immutableJson(envelope));
        peer.commands.push(immutableJson(f));
      }
      if(f.type==='input'){
        assert.equal(f.seq,f.payload.seq);
        peer.inputs.push(immutableJson({...f.payload,seq:f.seq}));if(peer.inputs.length>150)peer.inputs.shift();
      }
    }catch(error){fail(error);}});
  });
  await page.goto(client.origin+'/rooms/'+room.roomId);await page.locator('.shift-match').waitFor();await until(()=>peer.view,'first genuine WS snapshot');return peer;
}
async function capture(peer,folder,label){
  const evidence=await peer.page.evaluate(()=>{const el=document.querySelector('.shift-scene [data-shift-renderer]'),canvas=el?.querySelector('canvas');return{mode:el?.getAttribute('data-shift-renderer'),image:canvas?.toDataURL('image/png'),text:document.querySelector('.shift-match')?.innerText,charge:document.querySelector('.shift-pilot-status progress')?.getAttribute('value'),hp:document.querySelector('.shift-hp')?.getAttribute('aria-label'),result:document.querySelector('.shift-result h1')?.textContent,focusedResult:!!document.activeElement?.closest('.shift-result')};});
  if(evidence.image){await writeFile(join(folder,label+'.png'),Buffer.from(evidence.image.split(',')[1],'base64'));delete evidence.image;}
  await writeFile(join(folder,label+'-dom.json'),JSON.stringify(evidence,null,2));
  const safe = { ...evidence }; delete safe.text;
  return {label,method:'Actual Canvas2D PNG export plus actual DOM values/text; not compositor screenshot',...safe};
}
async function syncView(service,peers,room){const v=await service.runtime.viewForPlayer(room.matchId,peers[0].playerId);await until(()=>peers.every(p=>p.view?.tick===v.tick&&p.view?.recoveryTicksRemaining===v.recoveryTicksRemaining&&p.view?.phase===v.phase),'both browser authoritative views');await delay(70);return v;}
async function aimAt(page,point){const box=await page.locator('.shift-scene [data-shift-renderer]').boundingBox();assert.ok(box);const scale=Math.min((box.width-20)/33,(box.height-20)/25);await page.mouse.move(box.x+box.width/2+(point.x-8)*scale,box.y+box.height/2+(point.z-8)*scale);}

async function runCase(kind){
  const directory=await mkdtemp(join(runDirectory,`${kind}-`));
  let service=null,browserServer=null;const errors=[];
  const result={kind,cycle,controlledClock:true,ordinaryMatches:0,errors,captures:[],passed:false};
  report.fixtures.push(result);
  try{
    service=await startControlledServer(directory,port,portal);
    const host=new ShiftDemoClient(service.origin,join(directory,'mail')),guest=new ShiftDemoClient(service.origin,join(directory,'mail'));
    await host.register('edge_host','Лис');await guest.register('edge_guest','Сова');const friendship=await host.request('/friend-requests',{playerId:guest.user.playerId});await guest.request(`/friend-requests/${friendship.requestId}/accept`,{});
    const room=await seedRoom(service,host,guest,kind);await service.close();service=null;
    const initial=checkpoint(join(directory,'runtime.sqlite'),room.matchId,room,host.user.playerId,guest.user.playerId,kind);
    result.initial={tick:initial.tick,round:initial.round,phase:initial.phase,score:initial.score,preparation:initial.preparation,preparedTicks:initial.preparedTicks,chargeTicks:initial.chargeTicks,carrierHP:initial.carrierHP,ticksToTimeout:initial.ticksToTimeout};
    service=await startControlledServer(directory,port,portal);
    browserServer=await chromium.launchServer({...(browserPath?{executablePath:resolve(ROOT,browserPath)}:{}),headless:true,args:['--disable-dev-shm-usage']});
    const browser=await chromium.connect(browserServer.wsEndpoint());result.browser=await browser.version();
    const first=await openPeer(browser,host,room,'ru',errors),second=await openPeer(browser,guest,room,'en',errors);
    first.playerId=host.user.playerId;second.playerId=guest.user.playerId;const peers=[first,second];
    assert.equal(first.view.recoveryTicksRemaining,150);service.runtime.advanceTicks(TIMING.recovery);await syncView(service,peers,room);
    result.captures.push(await capture(first,directory,'before-ru'),await capture(second,directory,'before-en'));
    const resident=()=>service.runtime.matches.get(room.matchId); // Read-only admission observation; actions remain ordinary browser frames.
    if(kind==='keyboard'){
      assert.equal(first.view.self.role,'navigator');assert.equal(second.view.self.role,'pilot');
      await first.page.locator('.shift-room-keys').getByRole('button',{name:'O',exact:true}).click();
      assert.equal(first.view.phaseEndsAtTick-first.view.tick,1);
      service.runtime.advanceTicks();await syncView(service,peers,room);
      assert.equal(first.view.phase,'intermission');
      result.keyboardCases=[];
      for(const peer of peers){
        const summary=peer.page.locator('.shift-round-recap--compact > summary');
        await summary.waitFor();
        await peer.page.evaluate(()=>{
          window.__shiftEdgeKeys=[];
          window.addEventListener('keydown',event=>{queueMicrotask(()=>window.__shiftEdgeKeys.push({code:event.code,target:event.target.tagName,defaultPrevented:event.defaultPrevented}));});
        });
        for(const key of ['Enter','Space']){
          if(await summary.evaluate(e=>e.parentElement.open))await summary.click();
          assert.equal(await summary.evaluate(e=>e.parentElement.open),false);
          await summary.focus();
          const commandsBefore=peer.commands.length,lastSeq=peer.inputs.at(-1)?.seq??-1;
          await peer.page.keyboard.down(key);await delay(160);
          const heldInputs=peer.inputs.filter(input=>input.seq>lastSeq);
          await peer.page.keyboard.up(key);await delay(80);
          service.runtime.advanceTicks();await syncView(service,peers,room);await delay(80);
          const observation={role:peer.view.self.role,key,target:await summary.evaluate(()=>document.activeElement?.tagName),opened:await summary.evaluate(e=>e.parentElement.open),openKeyEvent:await peer.page.evaluate(()=>window.__shiftEdgeKeys.at(-1)),commandTypes:peer.commands.slice(commandsBefore).map(command=>command.payload.type),fireHeldWireObserved:heldInputs.some(input=>input.fireHeld)};
          result.keyboardCases.push(observation);
          assert.equal(observation.opened,true,`${observation.role} ${key}: native recap must open`);
          assert.equal(observation.openKeyEvent.defaultPrevented,false,`${observation.role} ${key}: native default must remain available`);
          assert.deepEqual(observation.commandTypes,[],`${observation.role} ${key}: no game command from SUMMARY`);
          assert.equal(observation.fireHeldWireObserved,false,`${observation.role} ${key}: no held-fire wire input from SUMMARY`);
          await peer.page.keyboard.press(key);await delay(80);
          observation.closedOnRepeat=!(await summary.evaluate(e=>e.parentElement.open));
          observation.closeKeyEvent=await peer.page.evaluate(()=>window.__shiftEdgeKeys.at(-1));
          observation.closeCommandTypes=peer.commands.slice(commandsBefore).map(command=>command.payload.type);
          assert.equal(observation.closedOnRepeat,true,`${observation.role} ${key}: native recap must close`);
          assert.equal(observation.closeKeyEvent.defaultPrevented,false);
          assert.deepEqual(observation.closeCommandTypes,[]);
        }
      }
      result.after={tick:first.view.tick,phase:first.view.phase};
      result.captures.push(await capture(first,directory,'recap-navigator'),await capture(second,directory,'recap-pilot'));
    }else if(kind==='threshold'){
      assert.equal(first.view.self.role,'navigator');assert.equal(second.view.self.role,'pilot');
      await first.page.locator('.shift-room-keys').getByRole('button',{name:'O',exact:true}).click();
      await first.page.locator('.shift-order button').first().click();
      await until(()=>resident()?.queue.some(p=>p.command.type==='shift'&&p.command.roomId==='O'),'real UI shift admitted');
      service.runtime.advanceTicks();await syncView(service,peers,room);await until(()=>first.receipts.some(r=>r.result.accepted),'durable shift receipt');
      const atSeal=structuredClone(second.view),own=atSeal.actors.find(a=>a.seatId===second.view.self.seatId);
      assert.equal(atSeal.motion?.roomId,'O');assert.equal(own.spaceId,'O');assert.ok(Math.abs(own.x+3.72)<1e-8);
      const doors=atSeal.doors.filter(door=>door.spaceId==='O');assert.equal(doors.length,4);assert.ok(doors.every(door=>!door.open));
      const db=new Database(join(directory,'runtime.sqlite'),{readonly:true});const persisted=JSON.parse(db.prepare('SELECT state FROM shift_matches WHERE match_id=?').get(room.matchId).state);db.close();
      const enemy=persisted.actors[initial.enemyId];assert.equal(enemy.spaceId,'A');assert.ok(Math.abs(enemy.x-3.72)<1e-8);
      result.atSeal={tick:atSeal.tick,motion:{roomId:atSeal.motion.roomId,from:atSeal.motion.from,to:atSeal.motion.to,startTick:atSeal.motion.startTick,endTick:atSeal.motion.endTick},pilot:pose(own),enemyAuthoritativeCheckpoint:pose(enemy),closedDoors:doors.length,accepted:first.receipts.some(receipt=>receipt.result.accepted)};
      result.captures.push(await capture(second,directory,'sealed-pilot-en'));
      await second.page.locator('.shift-scene [data-shift-renderer]').focus();await second.page.keyboard.down('a');
      await until(()=>resident()?.inputs.get(initial.guest)?.moveX===-1,'UI crossing attempt admitted');service.runtime.advanceTicks();await second.page.keyboard.up('a');await syncView(service,peers,room);
      const blocked=second.view.actors.find(a=>a.seatId===initial.guest);assert.equal(blocked.spaceId,'O');assert.ok(Math.abs(blocked.x+3.72)<1e-8);
      await until(()=>resident()?.inputs.get(initial.guest)?.moveX===0,'UI movement released');service.runtime.advanceTicks(TIMING.shift);await syncView(service,peers,room);
      assert.equal(second.view.motion,null);assert.equal(second.view.board[7],'O');assert.equal(second.view.board[4],null);assert.equal(second.view.actors.find(a=>a.seatId===initial.guest).spaceId,'O');
      result.after={blockedPose:pose(blocked),board:second.view.board,pilot:pose(second.view.actors.find(a=>a.seatId===initial.guest)),shiftEvents:second.view.events.filter(event=>event.kind.startsWith('shift-')).map(event=>({kind:event.kind,tick:event.tick,roomId:event.roomId}))};
      result.captures.push(await capture(second,directory,'docked-pilot-en'));
    }else if(kind==='knockout'){
      assert.equal(first.view.self.role,'pilot');assert.equal(second.view.self.role,'pilot');
      const carrier=first.view.actors.find(a=>a.seatId===first.view.self.seatId);assert.equal(carrier.chargeTicks,19);assert.equal(carrier.hp,1);assert.equal(await first.page.locator('.shift-pilot-status progress').getAttribute('value'),'19');
      await second.page.locator('.shift-scene [data-shift-renderer]').focus();await aimAt(second.page,worldPosition(second.view.board,carrier,second.view.motion,second.view.tick));await second.page.keyboard.down('Space');
      await until(()=>{const input=resident()?.inputs.get(initial.guest);return input?.fireHeld&&Math.abs(Math.abs(input.aim)-Math.PI)<.02;},'real UI lethal aim/fire admitted');
      const firing=resident().inputs.get(initial.guest);result.actualFiringInput={aim:firing.aim,fireHeld:firing.fireHeld};service.runtime.advanceTicks();await second.page.keyboard.up('Space');await syncView(service,peers,room);
      const v=first.view,dead=v.actors.find(a=>a.seatId===initial.host);assert.equal(dead.hp,0);assert.equal(v.battery.mode,'floor');assert.equal(v.score.teal,0);assert.equal(v.rounds.at(-1).reason,'timeout');assert.equal(v.rounds.at(-1).winner,null);assert.equal(v.phase,'intermission');assert.ok(!v.events.some(e=>e.kind==='delivered'));
      const text=await first.page.locator('.shift-match').innerText();assert.match(text,/Время вышло/);assert.match(text,/Возвращение через/);assert.equal(await first.page.locator('.shift-hp').getAttribute('aria-label'),'0 / 3 HP');
      result.after={tick:v.tick,phase:v.phase,score:v.score,battery:v.battery,carrier:{...pose(dead),hp:dead.hp,chargeTicks:dead.chargeTicks,carrying:dead.carrying},round:v.rounds.at(-1),events:v.events.filter(e=>['shot','hit','down','drop','delivered','round-end'].includes(e.kind)).map(event=>({kind:event.kind,tick:event.tick,reason:event.reason})),shooterStats:second.view.stats[second.view.self.seatId]};
      result.captures.push(await capture(first,directory,'knockout-timeout-ru'),await capture(second,directory,'knockout-timeout-en'));
    }else if(kind==='rematch'){
      // Pause only this fixture's scheduler; manual reconcile remains the ordinary platform method.
      await service.pauseReconciliation();
      assert.equal((await host.request(`/rooms/${room.roomId}`)).room.state,'playing');
      assert.equal(first.view.phaseEndsAtTick-first.view.tick,1);
      service.runtime.advanceTicks();await syncView(service,peers,room);
      assert.equal(first.view.phase,'finished');
      assert.equal((await host.request(`/rooms/${room.roomId}`)).room.state,'playing');
      await first.page.locator('.shift-result.draw').waitFor();
      const rematchPosts=[],rematchStatuses=[];
      const observeRematch=peer=>{
        peer.page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===`/api/platform/v1/rooms/${room.roomId}/rematch`)rematchPosts.push(true);});
        peer.page.on('response',response=>{if(response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/platform/v1/rooms/${room.roomId}/rematch`)rematchStatuses.push(response.status());});
      };
      observeRematch(first);
      const ruButton=first.page.locator('.shift-result').getByRole('button',{name:/^Реванш/});
      assert.equal(await ruButton.isDisabled(),true,'Final WS before room reconciliation must not enable rematch');
      const reasonRu=await first.page.locator('.shift-result > [role="status"]').innerText();
      assert.equal(reasonRu,'Подготавливаем комнату к реваншу…');
      const disabledBox=await ruButton.boundingBox();assert.ok(disabledBox);
      await first.page.mouse.click(disabledBox.x+disabledBox.width/2,disabledBox.y+disabledBox.height/2);await delay(80);
      assert.equal(rematchPosts.length,0,'Native disabled button must not issue a premature POST');
      result.captures.push(await capture(first,directory,'rematch-waiting-ru'));
      // Reopen the same local host account with EN preferences; the RU context closes first.
      await bounded(first.context.close(),'RU host context closure',10000);
      const hostPeer=await openPeer(browser,host,room,'en',errors);hostPeer.playerId=host.user.playerId;peers[0]=hostPeer;
      observeRematch(hostPeer);
      await hostPeer.page.locator('.shift-result.draw').waitFor();
      const enButton=hostPeer.page.locator('.shift-result').getByRole('button',{name:/^Rematch/});
      assert.equal(await enButton.isDisabled(),true);
      const reasonEn=await hostPeer.page.locator('.shift-result > [role="status"]').innerText();
      assert.equal(reasonEn,'Preparing the room for a rematch…');
      assert.equal((await host.request(`/rooms/${room.roomId}`)).room.state,'playing');
      result.waiting={runtimePhase:hostPeer.view.phase,roomState:'playing',buttonDisabledRu:true,buttonDisabledEn:true,reasonRu,reasonEn,prematurePosts:rematchPosts.length};
      result.captures.push(await capture(hostPeer,directory,'rematch-waiting-en'));
      await service.platform.reconcile();
      assert.equal((await host.request(`/rooms/${room.roomId}`)).room.state,'finished');
      // The existing portal polling must propagate readiness without a forced refresh.
      await until(()=>enButton.isEnabled(),'Ordinary room polling enables reconciled rematch');
      assert.equal(await hostPeer.page.locator('.shift-result > [role="status"]').count(),0);
      const priorScopes=peers.map(peer=>{assert.equal(peer.view.phase,'finished');assert.equal(peer.liveScope.matchId,room.matchId);return {...peer.liveScope};});
      const requestedAt=performance.now();
      await enButton.click();
      await until(()=>rematchStatuses.length===1,'Actual rematch POST response');
      assert.deepEqual(rematchStatuses,[200]);assert.equal(rematchPosts.length,1);
      await hostPeer.page.locator('.shift-lobby').waitFor();await second.page.locator('.shift-lobby').waitFor();
      const lobby=(await host.request(`/rooms/${room.roomId}`)).room;
      assert.equal(lobby.state,'lobby');assert.equal(lobby.matchId,null);
      assert.deepEqual(lobby.members.map(member=>member.participantId).sort(),room.members.map(member=>member.participantId).sort());
      assert.deepEqual(lobby.settings,room.settings);
      assert.ok(lobby.members.filter(member=>member.controller.kind==='human').every(member=>!member.ready));
      assert.ok(lobby.members.filter(member=>member.controller.kind==='bot').every(member=>member.ready));
      result.lobby={sameRoom:lobby.roomId===room.roomId,rosterPreserved:true,settingsPreserved:true,memberCount:lobby.members.length,userAccountReadinessReset:true,botReadinessRetained:true,rematchStatus:200};
      await hostPeer.page.getByRole('button',{name:/I’m ready/}).click();
      await until(async()=>(await host.request(`/rooms/${room.roomId}`)).room.members.find(member=>member.playerId===host.user.playerId)?.ready,'Host ready after rematch');
      await second.page.getByRole('button',{name:/I’m ready/}).click();
      const startButton=hostPeer.page.getByRole('button',{name:/Start match/});
      await until(()=>startButton.isEnabled(),'Both local user accounts ready for rematch');
      await startButton.click();
      const nextRoom=await until(async()=>{const next=(await host.request(`/rooms/${room.roomId}`)).room;return next.state==='playing'&&next.matchId&&next.matchId!==room.matchId?next:null;},'Distinct authoritative rematch starts');
      await until(()=>peers.every(peer=>peer.view?.phase==='prepare'&&peer.view.round===1&&peer.view.rounds.length===0),'Both clients receive fresh match');
      service.runtime.advanceTicks(TIMING.preparation);await syncView(service,peers,nextRoom);
      assert.ok(peers.every(peer=>peer.view.phase==='active'&&peer.view.round===1));
      assert.deepEqual(hostPeer.view.score,{teal:0,amber:0});
      result.after={tick:hostPeer.view.tick,phase:hostPeer.view.phase,round:hostPeer.view.round,score:hostPeer.view.score,distinctMatch:true,sameRoom:nextRoom.roomId===room.roomId};
      assert.ok(peers.every(peer=>peer.liveScope.matchId===nextRoom.matchId),'Both active views have the new authenticated match scope');
      result.expectedLifecycleEvents=[];
      // Classify after the complete real POST200 -> lobby -> new-active proof,
      // independently of whether WS error/close precedes the HTTP callback.
      for(const [index,peer] of peers.entries()){
        const prior=priorScopes[index];
        for(const event of peer.wireErrors){
          if(event.expectedLifecycle||event.code!=='LIVE_SCOPE_MISMATCH'||event.at<requestedAt||event.phase!=='finished'
            ||event.scope.matchId!==room.matchId||event.scope.epoch!==prior.epoch)continue;
          const closed=await until(()=>peer.page.evaluate(({matchId,epoch})=>window.__shiftEdgeSocketLifecycles.find(item=>item.matchId===matchId&&item.epoch===epoch&&item.closed),prior),'Old finished rematch socket actually closes');
          assert.equal(closed.closeCode,4003,'Scope retirement requires the actual old socket CloseEvent');assert.equal(closed.phase,'finished');
          const peerIndex=peer.errors.indexOf(event.message),sharedIndex=errors.indexOf(event.message);assert.ok(peerIndex>=0&&sharedIndex>=0);
          peer.errors.splice(peerIndex,1);errors.splice(sharedIndex,1);event.expectedLifecycle=true;
          const observation={code:event.code,closeCode:closed.closeCode,previousPhase:event.phase,postStatus:200,newMatchActive:true};
          peer.expectedLifecycleEvents.push(observation);result.expectedLifecycleEvents.push(observation);
        }
        assert.deepEqual(peer.errors,[],'Every other browser/wire error remains fatal during rematch');
      }
      result.expectedLifecycleEventCount=result.expectedLifecycleEvents.length;
      result.captures.push(await capture(hostPeer,directory,'rematch-active-en'));
    }else{
      assert.equal(first.view.round,6);assert.equal(first.view.phaseEndsAtTick-first.view.tick,1);assert.deepEqual(first.view.score,{teal:0,amber:0});
      service.runtime.advanceTicks();await syncView(service,peers,room);assert.equal(first.view.phase,'finished');assert.equal(first.view.winner,null);assert.equal(first.view.rounds.length,6);
      for(const peer of peers){await peer.page.locator('.shift-result.draw').waitFor();assert.equal(await peer.page.locator('.shift-result h1').innerText(),peer.language==='ru'?'Ничья':'Draw');assert.equal(await peer.page.locator('.shift-rounds > div').count(),6);assert.deepEqual(peer.view.rounds,first.view.rounds);assert.equal(await peer.page.evaluate(()=>!!document.activeElement?.closest('.shift-result')),true);}
      result.after={tick:first.view.tick,phase:first.view.phase,winner:first.view.winner,score:first.view.score,rounds:first.view.rounds,matchEndReason:first.view.events.find(e=>e.kind==='match-end')?.reason};
      result.captures.push(await capture(first,directory,'draw-result-ru'),await capture(second,directory,'draw-result-en'));
      // The final view must survive normal authenticated HTTP recovery after reload.
      await first.page.reload();await first.page.locator('.shift-result.draw').waitFor();assert.equal(await first.page.locator('.shift-result h1').innerText(),'Ничья');result.reloadPreserved=true;
    }
    assert.deepEqual(errors,[]);result.passed=true;result.authenticatedBrowserContexts=kind==='rematch'?3:2;result.maxConcurrentAuthenticatedBrowserContexts=2;result.frames=peers.map(p=>p.frames);result.uiCommands=peers.map(p=>p.commands.length);result.sharedTransport={protocol:LIVE_PROTOCOL,wireVersion:WIRE_VERSION,scopeChecks:peers.map(p=>p.scopeChecks),staleSocketFramesIgnored:peers.map(p=>p.staleSocketFramesIgnored)};
    log({fixture:kind,cycle,passed:true,tick:result.after?.tick??second.view.tick,method:'checkpoint + controlled authoritative clock + real built UI and authenticated WS'});
    return result;
  }catch(error){result.errors.push(safeError(error));throw error;}finally{
    if(browserServer)await bounded(browserServer.kill(),'BrowserServer.kill cleanup timeout',10000).catch(e=>{errors.push(safeError(e));});
    if(service)await bounded(service.close(),'Fixture HTTP/runtime cleanup timeout',10000);
  }
}

function safeError(error){return String(error?.message??error).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'<local-id>');}
function pose(actor){return {spaceId:actor.spaceId,x:actor.x,z:actor.z};}
try{
  for(const kind of ['threshold','knockout','draw','keyboard','rematch'])await runCase(kind);
  report.passed=report.fixtures.length===5&&report.fixtures.every(fixture=>fixture.passed&&fixture.errors.length===0);
  assert.equal(report.passed,true,'Every controlled fixture and cleanup must pass');
  log({completed:true,cycle,edgeFixtures:3,keyboardCases:4,rematchReadinessCases:1,ordinaryMatches:0,report:join(runDirectory,'evidence.json')});
}catch(error){report.errors.push(safeError(error));report.passed=false;log({failure:safeError(error),cycle});process.exitCode=1;}
finally{
  // Only these sanitized JSON files are suitable for promotion; never upload the QA directory.
  const evidence=JSON.stringify(report,null,2)+'\n';
  await writeFile(join(runDirectory,'evidence.json'),evidence,{mode:0o600});
  await writeFile(join(QA,`cycle-${cycle}-evidence.json`),evidence,{mode:0o600});
}
