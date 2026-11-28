#!/usr/bin/env node
/** Local, isolated UI acceptance driver. Starts the real built services and
 * Chromium in one network namespace. No game-state injection or win shortcuts.
 * Commands operate ordinary UI; received WS views are read only evidence. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { chromium, webkit } from 'playwright';
import { tyagaQaConfig } from './tyaga-qa-config.mjs';
import { applyLoadChanges } from './realtime-load-view.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { qa, origin } = tyagaQaConfig(root);
const label = process.argv.find(a => a.startsWith('--round='))?.slice(8) ?? 'preflight';
if (!/^[a-zA-Z0-9-]+$/.test(label)) throw new Error('Invalid QA label');
const browserEngine=process.env.TYAGA_BROWSER??'chromium';
if(!['chromium','webkit'].includes(browserEngine))throw new Error('TYAGA_BROWSER must be chromium or webkit');
const directory = resolve(qa, label); await mkdir(directory, { recursive: true });
const runner = spawn(process.execPath, ['scripts/dev-tyaga.mjs', ...(process.argv.includes('--no-build') ? ['--no-build'] : [])], { cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
let browser, input, active = 0, stopping = false, counter = 0;
counter = Math.max(0, ...(await readdir(directory)).map(name=>Number(/^(\d+)-/.exec(name)?.[1]??0)));
const clients = [];
function serviceControl(command) {
  if(!['status','restart-realtime','crash-realtime','start-realtime'].includes(command))throw new Error('Unknown isolated service command');
  const id=crypto.randomUUID();
  return new Promise((accept,reject)=>{
    const cleanup=()=>{clearTimeout(timeout);runner.off('message',receive);};
    const receive=message=>{if(message?.type!=='tyaga-runner-result'||message.id!==id)return;cleanup();if(message.ok)accept(message.status);else reject(new Error(message.error));};
    const timeout=setTimeout(()=>{cleanup();reject(new Error('Isolated service command timed out'));},45000);
    runner.on('message',receive);runner.send({type:'tyaga-runner-control',id,command},error=>{if(error){cleanup();reject(error);}});
  });
}
async function stop() {
  if (stopping) return; stopping = true;
  input?.close(); process.stdin.pause();
  let browserTimer, browserCloseError;
  const browserStopStarted=performance.now();
  const browserClosed=await Promise.race([Promise.resolve(browser?.close()).then(()=>true,error=>{browserCloseError=error.message;return false;}),new Promise(done=>{browserTimer=setTimeout(()=>done(false),20000);})]).finally(()=>clearTimeout(browserTimer));
  const browserCloseWaitMs=performance.now()-browserStopStarted;
  runner.kill('SIGTERM');
  const runnerStopped=await new Promise(done => { if (runner.exitCode !== null) return done({code:runner.exitCode,forced:false}); const timeout = setTimeout(() => { runner.kill('SIGKILL'); done({code:null,forced:true}); }, 35000); runner.once('exit', code => { clearTimeout(timeout); done({code,forced:false}); }); });
  const result={browserClosed,browserCloseWaitMs,...(browserCloseError?{browserCloseError}:{}),runner:runnerStopped};
  await writeFile(resolve(directory,'shutdown.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({shutdown:result}));
  if(!browserClosed || runnerStopped.forced || runnerStopped.code!==0) process.exitCode=1;
}
process.once('SIGINT', () => { void stop().finally(() => process.exit()); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit()); });
async function ready() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (runner.exitCode !== null) throw new Error('Local server runner exited');
    try { const r = await fetch(origin + '/api/realtime/v1/health/tyaga'); if (r.ok) return r.json(); } catch { /* services build first */ }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('Services did not start');
}
async function addClient(viewport = { width:1366, height:768 }, mobile = false) {
  const context = await browser.newContext({ viewport, isMobile:mobile, hasTouch:mobile, deviceScaleFactor:1 });
  context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage(), client = { context, page, view:null, snapshot:null, bases:new Map(), serverBaseline:null, activeSocket:null, errors:[], console:[], failed:[], wire:{received:0,sent:0,sentTypes:{},errorCodes:{},actions:[],lastReceived:null,lastSent:null,lastSnapshotAt:null,closed:0} };
  clients.push(client); active = clients.length - 1;
  page.on('framenavigated',frame=>{if(frame===page.mainFrame()){client.view=null;client.snapshot=null;client.bases.clear();client.serverBaseline=null;client.activeSocket=null;}});
  page.on('pageerror', error => {
    const known=client.errors.find(item=>item.message===error.message);
    if(known) known.count++; else client.errors.push({message:error.message,stack:error.stack,count:1});
  });
  page.on('console', message => {
    if(!['error','warning'].includes(message.type()))return;
    const text=message.text().replace(/ticket=[^&\s]+/g,'ticket=REDACTED').slice(0,4000),known=client.console.find(item=>item.type===message.type()&&item.text===text);
    if(known)known.count++;else if(client.console.length<100)client.console.push({type:message.type(),text,count:1});
  });
  page.on('requestfailed', request => client.failed.push({ url:request.url().replace(/ticket=[^&]+/g,'ticket=REDACTED'), error:request.failure()?.errorText }));
  page.on('websocket', socket => {
    client.activeSocket=socket;
    socket.on('close',()=>{client.wire.closed++;});
    socket.on('framesent',frame=>{try{const message=JSON.parse(frame.payload.toString());client.wire.sent++;client.wire.sentTypes[message.type]=(client.wire.sentTypes[message.type]??0)+1;client.wire.lastSent={type:message.type,inputSeq:message.inputSeq,at:Date.now()};if(message.type==='input')client.wire.lastInput={inputSeq:message.inputSeq,payload:message.payload,at:Date.now()};}catch{/* diagnostic only */}});
    socket.on('framereceived', frame => {
      if(client.activeSocket!==socket)return;
      try {
        const message = JSON.parse(frame.payload.toString());
        client.wire.received++;client.wire.lastReceived={type:message.type,snapshotSeq:message.snapshotSeq,code:message.code,at:Date.now()};
        if(message.type==='error'&&typeof message.code==='string')client.wire.errorCodes[message.code]=(client.wire.errorCodes[message.code]??0)+1;
        if(message.type==='actionAck'||message.type==='error'&&message.actionId){client.wire.actions.push({type:message.type,actionId:message.actionId,epoch:message.epoch,result:message.result,code:message.code,at:Date.now()});if(client.wire.actions.length>32)client.wire.actions.shift();}
        if (message.type === 'full') {
          if(message.matchId!==client.snapshot?.matchId||message.epoch!==client.snapshot?.epoch||message.controllerGeneration!==client.snapshot?.controllerGeneration){client.bases.clear();client.serverBaseline=null;}
          client.view=message.view; client.snapshot=message; client.bases.set(message.snapshotSeq,message.view); client.wire.lastSnapshotAt=Date.now();
        }
        if (message.type === 'delta' && message.matchId===client.snapshot?.matchId && message.epoch===client.snapshot?.epoch && message.controllerGeneration===client.snapshot?.controllerGeneration && client.bases.has(message.baselineSnapshotSeq)) { client.serverBaseline=message.baselineSnapshotSeq;client.view=applyLoadChanges(client.bases.get(message.baselineSnapshotSeq),message.changes); client.snapshot={...message,view:client.view}; client.bases.set(message.snapshotSeq,client.view); client.wire.lastSnapshotAt=Date.now(); }
        while(client.bases.size>64)client.bases.delete([...client.bases.keys()].find(sequence=>sequence!==client.serverBaseline&&sequence!==client.snapshot?.snapshotSeq));
      } catch { /* Full/delta is separately covered by protocol tests. */ }
    });
  });
  await page.goto(origin + '/play/tyaga/');
  return client;
}
function locator(page, command) {
  if (command.label) return page.getByLabel(command.label,{exact:command.exact!==false});
  if (command.text) return page.getByText(command.text,{exact:command.exact!==false});
  if (command.css) return page.locator(command.css);
  return page.getByRole(command.role ?? 'button',{name:command.name,exact:command.exact!==false});
}
async function evidence(client, name) {
  const prefix=String(++counter).padStart(3,'0')+'-'+name.replace(/[^a-zA-Z0-9-]/g,'-');
  const file=resolve(directory,prefix+'.png'); await client.page.screenshot({path:file,fullPage:true,timeout:20000});
  const text=await client.page.locator('body').innerText(); await writeFile(resolve(directory,prefix+'.txt'),text);
  await writeFile(resolve(directory,prefix+'-diagnostics.json'),JSON.stringify({errors:client.errors,console:client.console,failed:client.failed,wire:client.wire},null,2));
  if(client.view) await writeFile(resolve(directory,prefix+'-view.json'),JSON.stringify(client.view));
  console.log(JSON.stringify({evidence:file, url:client.page.url(), text:text.slice(0,10000), errors:client.errors,console:client.console,failed:client.failed.slice(-8)}));
}
async function walkByKeyboard(client, command) {
  if (!Number.isFinite(command.x) || !Number.isFinite(command.z)) throw new Error('A finite walking target is required');
  if (await client.page.locator('dialog[open]').count()) throw new Error('Close the UI panel before walking');
  await client.page.locator('.ty-world canvas').focus();
  const started=Date.now(), trace=[], held=new Set(), tolerance=command.tolerance??.35;
  let reached=false, failure=null;
  try {
    while(Date.now()-started<Math.min(command.maxMs??12000,30000)) {
      const view=client.view, self=view?.participants.find(p=>p.participantId===view.participantId), actor=view?.entities.find(e=>e.id===self?.entityId);
      if(!actor || self.controlling || !client.snapshot?.hasControl || client.snapshot.phase!=='running') throw new Error('Walking requires an active character controller');
      if(Date.now()-(client.wire.lastSnapshotAt??0)>2500)throw new Error('No recent server world; walking stopped');
      const dx=command.x-actor.position.x,dz=command.z-actor.position.z,distance=Math.hypot(dx,dz);
      if(distance<=tolerance){reached=true;break;}
      const horizontal=(dx-dz)*Math.SQRT1_2,vertical=-(dx+dz)*Math.SQRT1_2,scale=Math.max(Math.abs(horizontal),Math.abs(vertical));
      const keys=[]; if(Math.abs(horizontal)>scale*.35)keys.push(horizontal>0?'d':'a');if(Math.abs(vertical)>scale*.35)keys.push(vertical>0?'w':'s');
      if(command.run)keys.push('Shift');
      for(const key of keys){await client.page.keyboard.down(key);held.add(key);}
      const duration=Math.min(180,Math.max(60,distance/3.2*450));
      await client.page.waitForTimeout(duration);
      for(const key of held)await client.page.keyboard.up(key);held.clear();
      trace.push({tick:view.tick,position:actor.position,keys,duration});
      await client.page.waitForTimeout(100);
    }
  } catch(error) { failure=error; }
  finally {
    for(const key of held)await client.page.keyboard.up(key);
    await appendFile(resolve(directory,'keyboard-navigation.jsonl'),JSON.stringify({target:{x:command.x,z:command.z},reached,error:failure?.message??null,trace})+'\n');
  }
  if(failure)throw failure;
  console.log(JSON.stringify({keyboardNavigation:true,reached,steps:trace.length,last:trace.at(-1)?.position}));
}
async function driveByKeyboard(client, command) {
  if (!Number.isFinite(command.x) || !Number.isFinite(command.z)) throw new Error('A finite driving target is required');
  if (await client.page.locator('dialog[open]').count()) throw new Error('Close the UI panel before driving');
  await client.page.locator('.ty-world canvas').focus();
  const started=Date.now(), trace=[], held=new Set(), tolerance=Math.max(.5,command.tolerance??1);
  let reached=false, failure=null;
  const changeKeys=async keys=>{for(const key of held)if(!keys.includes(key)){await client.page.keyboard.up(key);held.delete(key);}for(const key of keys)if(!held.has(key)){await client.page.keyboard.down(key);held.add(key);}};
  try {
    while(Date.now()-started<Math.min(command.maxMs??15000,30000)) {
      const view=client.view, self=view?.participants.find(p=>p.participantId===view.participantId), truck=view?.entities.find(e=>e.id==='truck');
      if(!truck||self?.controlling!=='truck'||!client.snapshot?.hasControl||client.snapshot.phase!=='running')throw new Error('Driving requires the active truck controller');
      if(Date.now()-(client.wire.lastSnapshotAt??0)>2500)throw new Error('No recent server world; driving stopped');
      const dx=command.x-truck.position.x,dz=command.z-truck.position.z,distance=Math.hypot(dx,dz),q=truck.rotation;
      const heading=Math.atan2(-2*(q.x*q.z-q.y*q.w),1-2*(q.y*q.y+q.z*q.z)),desired=-Math.atan2(dz,dx);
      const error=Math.atan2(Math.sin(desired-heading),Math.cos(desired-heading));
      const speed=view.truck.speed,limit=Math.min(command.speed??2.5,Math.abs(error)>.6?.8:Math.abs(error)>.25?1.4:2.5);
      const keys=[];
      if(distance<=tolerance){keys.push('Space');if(Math.abs(speed)<.12){reached=true;break;}}
      else {if(Math.abs(error)>.07)keys.push(error>0?'a':'d');if(speed>limit+.15||distance<1.8&&speed>.7)keys.push('Space');else if(speed<limit)keys.push('w');}
      await changeKeys(keys);trace.push({tick:view.tick,position:truck.position,rotation:q,speed,error,keys});
      await client.page.waitForTimeout(180);
    }
  } catch(error) { failure=error; }
  finally {
    try {
      await changeKeys([]);
      const settleUntil=Date.now()+6000;
      while(Date.now()<settleUntil&&['paused','recovering'].includes(client.snapshot?.phase))await client.page.waitForTimeout(100);
      if(client.view?.participants.find(p=>p.participantId===client.view.participantId)?.controlling==='truck'&&client.snapshot?.phase==='running'&&client.snapshot.hasControl){
        await changeKeys(['Space']);await client.page.waitForTimeout(650);await changeKeys([]);
        const parking=client.page.getByRole('button',{name:/^(Стояночный|Parking brake)$/});
        if(await parking.count()&&await parking.getAttribute('aria-pressed')==='false'&&await parking.isEnabled())await parking.click();
      }
    } catch(error) { failure??=error; }
    finally {
      await changeKeys([]);
      await appendFile(resolve(directory,'keyboard-driving.jsonl'),JSON.stringify({target:{x:command.x,z:command.z},reached,error:failure?.message??null,trace})+'\n');
    }
  }
  if(failure)throw failure;
  console.log(JSON.stringify({keyboardDriving:true,reached,steps:trace.length,last:trace.at(-1)?.position}));
}
async function execute(command) {
  const client=clients[active], page=client?.page;
  await appendFile(resolve(directory,'commands.jsonl'),JSON.stringify({...command, ...(command.cmd==='fill'?{value:'[UI test value]'}:{})})+'\n');
  switch(command.cmd){
    case 'new': await addClient(command.viewport,command.mobile); break;
    case 'client': if(!clients[command.index]) throw new Error('Unknown client'); active=command.index; break;
    case 'login': {
      const accounts=JSON.parse(await readFile(resolve(qa,'accounts.json'),'utf8')),account=accounts[command.index??active];
      if(!account)throw new Error('Unknown QA account');
      await page.goto(origin+'/login?returnTo=%2Fplay%2Ftyaga%2F');
      await page.locator('input[type=email]').fill(account.email); await page.locator('input[type=password]').fill(account.password);
      await page.locator('form').getByRole('button',{name:'Войти',exact:true}).click();
      await page.waitForURL(origin+'/play/tyaga/'); break;
    }
    case 'goto': if(!command.path?.startsWith('/')||command.path.startsWith('//'))throw new Error('Local path required'); await page.goto(origin+command.path); break;
    case 'click': await locator(page,command).click(); break;
    case 'select': await locator(page,command).selectOption(command.value); break;
    case 'fill': await locator(page,command).fill(command.value); break;
    case 'check': await locator(page,command).setChecked(command.checked); break;
    case 'press': if(command.name||command.label||command.css) await locator(page,command).press(command.key); else await page.keyboard.press(command.key); break;
    case 'walk': await walkByKeyboard(client,command);break;
    case 'drive': await driveByKeyboard(client,command);break;
    case 'hover': await locator(page,command).hover();break;
    case 'focus-element': await locator(page,command).focus();break;
    case 'key': try{for(const key of command.keys)await page.keyboard.down(key); await page.waitForTimeout(Math.min(command.ms??500,15000));}finally{for(const key of command.keys)await page.keyboard.up(key);} break;
    case 'keydown': for(const key of command.keys)await page.keyboard.down(key); break;
    case 'keyup': for(const key of command.keys)await page.keyboard.up(key); break;
    case 'tap': await page.touchscreen.tap(command.x,command.y); break;
    case 'touch': {
      if (!['touchStart','touchMove','touchEnd','touchCancel'].includes(command.type)) throw new Error('Invalid touch phase');
      client.cdp ??= await client.context.newCDPSession(page);
      await client.cdp.send('Input.dispatchTouchEvent',{type:command.type,touchPoints:(command.points??[]).map(p=>({x:p.x,y:p.y,id:p.id??0,radiusX:5,radiusY:5,force:1}))}); break;
    }
    case 'rotate': {
      client.cdp ??= await client.context.newCDPSession(page);
      await client.cdp.send('Emulation.setDeviceMetricsOverride',{width:command.width,height:command.height,deviceScaleFactor:1,mobile:true,screenOrientation:{type:command.width>command.height?'landscapePrimary':'portraitPrimary',angle:command.width>command.height?90:0}}); break;
    }
    case 'focus': await page.bringToFront(); break;
    case 'point': await page.mouse.click(command.x,command.y); break;
    case 'wait': await page.waitForTimeout(Math.min(command.ms??500,15000)); break;
    case 'viewport': await page.setViewportSize({width:command.width,height:command.height}); break;
    case 'offline': await client.context.setOffline(command.enabled); break;
    case 'reload': await page.reload(); break;
    case 'service': {const status=await serviceControl(command.action);await appendFile(resolve(directory,'service-events.jsonl'),JSON.stringify({command:command.action,status})+'\n');console.log(JSON.stringify({service:status}));break;}
    case 'diagnostics': console.log(JSON.stringify({wire:client.wire,errors:client.errors,console:client.console,failed:client.failed.slice(-8),dom:await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus(),active:document.activeElement?.tagName,scale:getComputedStyle(document.documentElement).getPropertyValue('--ty-text-scale'),viewport:{width:innerWidth,height:innerHeight},dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>e.getAttribute('aria-label'))})),snapshot:client.snapshot?{tick:client.view?.tick,seq:client.snapshot.snapshotSeq,phase:client.snapshot.phase,hasControl:client.snapshot.hasControl,generation:client.snapshot.controllerGeneration,epoch:client.snapshot.epoch}:null}));break;
    case 'performance': {
      const duration=Math.max(1000,Math.min(command.ms??5000,15000));
      const measurement=await page.evaluate(ms=>new Promise(done=>{
        const start=performance.now(),intervals=[];let previous=start;
        function sample(now){intervals.push(now-previous);previous=now;if(now-start<ms){requestAnimationFrame(sample);return;}const sorted=intervals.slice(1).sort((a,b)=>a-b);done({elapsedMs:now-start,frames:sorted.length,fps:sorted.length/((now-start)/1000),frameP50Ms:sorted[Math.floor(sorted.length*.5)]??null,frameP95Ms:sorted[Math.floor(sorted.length*.95)]??null,heapUsedBytes:performance.memory?.usedJSHeapSize??null,visibility:document.visibilityState,viewport:{width:innerWidth,height:innerHeight}});}
        requestAnimationFrame(sample);
      }),duration);
      const result={renderer:'Chromium software WebGL / SwiftShader',client:active,tick:client.view?.tick,...measurement};
      await appendFile(resolve(directory,'performance.jsonl'),JSON.stringify(result)+'\n');console.log(JSON.stringify({performance:result}));break;
    }
    case 'wire-sample': {
      const start=Date.now(),before=structuredClone(client.wire),tickBefore=client.view?.tick;
      await page.waitForTimeout(Math.max(1000,Math.min(command.ms??10000,15000)));
      const elapsedMs=Date.now()-start,sentByType=Object.fromEntries(Object.entries(client.wire.sentTypes).map(([kind,count])=>[kind,count-(before.sentTypes[kind]??0)]));
      const errorDelta=Object.fromEntries(Object.entries(client.wire.errorCodes).map(([code,count])=>[code,count-(before.errorCodes[code]??0)]));
      const result={elapsedMs,sentByType,inputHz:(sentByType.input??0)*1000/elapsedMs,errorCodes:client.wire.errorCodes,errorDelta,tickBefore,tickAfter:client.view?.tick,phase:client.snapshot?.phase};
      await appendFile(resolve(directory,'wire-samples.jsonl'),JSON.stringify(result)+'\n');console.log(JSON.stringify({wireSample:result}));break;
    }
    case 'state': {
      const visibleText=(await page.locator('body').innerText()).slice(0,14000),view=client.view; console.log(JSON.stringify({client:active,url:page.url(),text:visibleText, errors:client.errors,wire:view?{phase:view.phase,tick:view.tick,epoch:client.snapshot.epoch,hasControl:client.snapshot.hasControl,participants:view.participants,truck:view.truck,checkpoint:view.checkpoint,tutorial:view.tutorial,interactions:view.interactions,objects:view.entities.filter(e=>e.kind==='truck'||e.kind==='character'||e.required).map(e=>({id:e.id,position:e.position,integrity:e.integrity,velocity:e.velocity})),events:view.events.slice(-8)}:null})); break;
    }
    case 'inspect': console.log(JSON.stringify(await page.locator('button,input,select,a').evaluateAll(elements=>elements.map(e=>{const b=e.getBoundingClientRect();return{text:e.textContent?.trim().slice(0,80),aria:e.getAttribute('aria-label'),type:e.tagName,disabled:e.disabled,selected:e.getAttribute('aria-pressed'),x:b.x,y:b.y,width:b.width,height:b.height,visible:b.width>0&&b.height>0}})))); break;
    case 'audit-ui': {
      const report=await page.locator('button,input,select,a,[tabindex]').evaluateAll(elements=>elements.map(e=>{
        const b=e.getBoundingClientRect(),s=getComputedStyle(e),label=e.getAttribute('aria-label')||e.labels?.[0]?.textContent?.trim()||e.textContent?.trim();
        const ids=(e.getAttribute('aria-describedby')??'').split(/\s+/).filter(Boolean);
        const inViewport=b.right>0&&b.bottom>0&&b.left<innerWidth&&b.top<innerHeight,centerX=b.left+b.width/2,centerY=b.top+b.height/2;
        const hit=inViewport?document.elementFromPoint(centerX,centerY):null;
        return {tag:e.tagName,label:label?.slice(0,200),disabled:!!e.disabled,reason:e.title||ids.map(id=>document.getElementById(id)?.textContent).filter(Boolean).join(' '),tabIndex:e.tabIndex,pressed:e.getAttribute('aria-pressed'),expanded:e.getAttribute('aria-expanded'),visible:b.width>0&&b.height>0&&s.visibility!=='hidden'&&s.display!=='none',inViewport,centerHitTarget:!!hit&&(hit===e||e.contains(hit)),rect:{x:b.x,y:b.y,width:b.width,height:b.height},fontSize:s.fontSize,color:s.color,background:s.backgroundColor,clipped:e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1};
      }));
      const result={client:active,url:page.url(),viewport:page.viewportSize(),elements:report};
      await appendFile(resolve(directory,'ui-audit.jsonl'),JSON.stringify(result)+'\n');
      console.log(JSON.stringify({uiAudit:{visible:report.filter(e=>e.visible),hiddenCount:report.filter(e=>!e.visible).length}}));break;
    }
    case 'audit-states': {
      const describe=element=>{const s=getComputedStyle(element),r=element.getBoundingClientRect();return {tag:element.tagName,label:element.getAttribute('aria-label')||element.labels?.[0]?.textContent?.trim()||element.textContent?.trim().slice(0,120),disabled:!!element.disabled,outline:s.outline,boxShadow:s.boxShadow,color:s.color,background:s.backgroundColor,rect:{x:r.x,y:r.y,width:r.width,height:r.height},focused:document.activeElement===element,hovered:element.matches(':hover')};};
      const modal=page.locator('dialog[open]'),scope=await modal.count()?modal:page;
      const controls=scope.locator('button,input,select,a,[tabindex="0"]'),count=await controls.count(),hovers=[],tabs=[];
      for(let i=0;i<count;i++){const control=controls.nth(i);if(!await control.isVisible())continue;await control.hover();hovers.push(await control.evaluate(describe));}
      const tabCount=Math.min(count+2,100);
      for(let i=0;i<tabCount;i++){await page.keyboard.press('Tab');tabs.push(await page.locator(':focus').evaluate(describe).catch(()=>null));}
      const result={client:active,url:page.url(),kind:'Actual hover and keyboard Tab only; activation states are tested separately',hovers,tabs};
      await appendFile(resolve(directory,'ui-states.jsonl'),JSON.stringify(result)+'\n');console.log(JSON.stringify({uiStates:{hovers:hovers.length,tabs:tabs.length,labels:hovers.map(item=>item.label)}}));break;
    }
    case 'screenshot': await evidence(client,command.name??'screen'); break;
    case 'quit': await stop(); return false;
    default:throw new Error('Unknown QA command');
  }
  return true;
}
try{
  const health=await ready();
  if(browserEngine==='chromium'){
    let executablePath=process.env.TYAGA_CHROMIUM;
    const packaged=resolve(root,'.qa/tyaga/browser-runtime/node_modules/@sparticuz/chromium/build/index.js');
    if(!executablePath && existsSync(packaged)) {
      process.env.TMPDIR=resolve(qa,'browser-runtime/tmp'); await mkdir(process.env.TMPDIR,{recursive:true});
      const packagedChromium=(await import(packaged)).default; executablePath=await packagedChromium.executablePath();
    }
    // Keep normal browser origin/security checks. Only software WebGL is enabled
    // inside this disposable QA context; do not use the package's insecure args.
    browser=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  }else{
    browser=await webkit.launch({headless:true,...(process.env.TYAGA_WEBKIT_EXECUTABLE?{executablePath:process.env.TYAGA_WEBKIT_EXECUTABLE}:{})});
  }
  await addClient();
  const build=JSON.parse(await readFile(resolve(qa,'build.json'),'utf8'));
  const webgl=await clients[0].page.locator('canvas').evaluateAll(canvases=>canvases.map(canvas=>{
    const gl=canvas.getContext('webgl2')??canvas.getContext('webgl');if(!gl)return null;
    const debug=gl.getExtension('WEBGL_debug_renderer_info');return{version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(gl.RENDERER),vendor:gl.getParameter(gl.VENDOR),unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null};
  }).filter(Boolean));
  await writeFile(resolve(directory,'build.json'),JSON.stringify({...build,health,browser:browser.version(),browserEngine,hostPlatform:process.platform,hostArch:process.arch,webgl,renderer:webgl.map(info=>info.unmaskedRenderer??info.renderer).join('; ')||'Not observed',rendererSource:'WebGL-reported strings; not physical GPU or device identification',kind:'automated UI browser'},null,2));
  console.log(JSON.stringify({ready:true,round:label,buildId:build.buildId,browser:browser.version(),browserEngine,webgl,clients:clients.length}));
  await evidence(clients[0],'menu');
  input=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input){
    if(!line.trim())continue;
    const startedAt=Date.now(),before=clients[active]?.snapshot;
    let command,error,keepGoing=true;
    try{command=JSON.parse(line);keepGoing=await execute(command);}catch(caught){error=caught.message;console.log(JSON.stringify({commandError:error}));}
    const client=clients[active],after=client?.snapshot;
    const cursor=snapshot=>snapshot?{matchId:snapshot.matchId,epoch:snapshot.epoch,generation:snapshot.controllerGeneration,seq:snapshot.snapshotSeq,tick:snapshot.view?.tick,phase:snapshot.phase}:null;
    await appendFile(resolve(directory,'command-outcomes.jsonl'),JSON.stringify({id:crypto.randomUUID(),startedAt,finishedAt:Date.now(),client:active,command:command?{...command,...(command.cmd==='fill'?{value:'[UI test value]'}:{})}:null,
      uiDispatch:error?'error':'completed',error:error??null,before:cursor(before),after:cursor(after),evidenceCounter:counter,
      receivedActionReplies:client?.wire.actions.filter(reply=>reply.at>=startedAt)??[],kind:'UI dispatch record; server success and gameplay consequences require the recorded replies, views and screenshots'})+'\n');
    if(!keepGoing)break;
  }
}catch(error){console.error(error);process.exitCode=1;}finally{await stop();process.exit(process.exitCode??0);}
