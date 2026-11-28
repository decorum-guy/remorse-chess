/** Isolated automated visual inspection of the real production bundle. No API mocking. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const built = path.join(repo, 'apps/portal/dist');
const output = path.join(repo, '.qa/test-bench-visual', process.env.IVA_VISUAL_RUN ?? 'initial');
await mkdir(output, { recursive: true });
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.glb':'model/gltf-binary', '.wav':'audio/wav', '.wasm':'application/wasm', '.json':'application/json' };
const server = createServer(async (request, response) => {
  try {
    const uri = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    let target = path.resolve(built, '.' + uri);
    if (!target.startsWith(built + path.sep)) target = path.join(built, 'index.html');
    try { if (!(await stat(target)).isFile()) target = path.join(built, 'index.html'); }
    catch { if (path.extname(uri)) { response.writeHead(404).end(); return; } target = path.join(built, 'index.html'); }
    const buffer = await readFile(target); response.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control':'no-store' }); response.end(buffer);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(4393, '127.0.0.1', resolve));
const launchOptions = { headless:true, args:['--disable-dev-shm-usage', '--enable-unsafe-swiftshader'], ...(process.env.IVA_CHROMIUM_PATH ? {executablePath:process.env.IVA_CHROMIUM_PATH} : {}) };
let browser;
try { browser = await chromium.launch(launchOptions); }
catch (error) { await new Promise(resolve=>server.close(resolve)); throw error; }
const observed = { method:'Automated Playwright against production files; no human/physical-device/listening claim', scope:'Static practice and presentation only; no online/account API', performance:'Observed high-quality renderer metrics, not a physical-device or low-quality performance gate', sha:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(), workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(), productionIndexSha256:createHash('sha256').update(await readFile(path.join(built,'index.html'))).digest('hex'), screenshots:[], errors:[], failedRequests:[], metrics:[], layout:[] };
try {
  const context = await browser.newContext({viewport:{width:1366,height:768}});const page = await context.newPage();
  page.on('pageerror',error=>observed.errors.push(error.message));
  const isAsset = url => { const pathname=new URL(url).pathname;return !pathname.startsWith('/api/') && (pathname.startsWith('/test-bench/')||pathname.startsWith('/assets/')||/\.(?:glb|wasm|woff2|wav|png|svg|css|js)$/.test(pathname)); };
  page.on('requestfailed',request=>{if(isAsset(request.url()))observed.failedRequests.push({url:request.url(),failure:request.failure()?.errorText});});
  page.on('response',response=>{if(response.status()>=400&&isAsset(response.url()))observed.failedRequests.push({url:response.url(),status:response.status()});});
  const shot = async name => {
    const file=path.join(output,name+'.png'); await page.screenshot({path:file,fullPage:false});observed.screenshots.push(file);
    observed.metrics.push({name,...await page.locator('canvas.tb-scene-canvas').first().evaluate(canvas=>({renderer:canvas.dataset.renderer,drawCalls:Number(canvas.dataset.drawCalls||0),frameP95Ms:Number(canvas.dataset.frameP95||0),width:canvas.clientWidth,height:canvas.clientHeight})).catch(()=>({renderer:'absent'}))});
    observed.layout.push({name,...await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,controls:[...document.querySelectorAll('.tb-race button,.tb-builder-actions button')].map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent?.trim(),x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0,inViewport:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};})}))});
  };
  await page.goto('http://127.0.0.1:4393/games/test-bench',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>Number(document.querySelector('canvas.tb-scene-canvas')?.dataset.drawCalls)>0,{},{timeout:15000});
  await shot('desktop-home-3d');
  await page.goto('http://127.0.0.1:4393/games/test-bench?mode=practice',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>Number(document.querySelector('canvas.tb-scene-canvas')?.dataset.drawCalls)>0,{},{timeout:15000});
  await page.getByRole('button',{name:/Бережная/}).click();
  await page.waitForTimeout(500);await shot('desktop-builder-gentle-3d');
  await page.getByRole('button',{name:/Проверить/}).click();
  await page.waitForFunction(()=>Number(document.querySelector('canvas.tb-scene-canvas')?.dataset.drawCalls)>0,{},{timeout:15000});
  await shot('desktop-race-3d');
  await page.keyboard.down('KeyW');await page.waitForTimeout(900);await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS');await page.waitForTimeout(350);await page.keyboard.up('KeyS');
  await shot('desktop-race-at-dock-3d');
  const load=page.getByRole('button',{name:/Загрузить груз/});if(await load.count()&&await load.isEnabled())await load.click();
  await page.keyboard.down('KeyW');await page.keyboard.down('KeyD');await page.waitForTimeout(700);await page.keyboard.up('KeyD');await page.keyboard.up('KeyW');
  await page.getByRole('button',{name:/Пауза/}).click();await shot('desktop-steer-right-3d');
  await page.setViewportSize({width:844,height:390});await page.waitForTimeout(250);await shot('landscape-race-3d');
  await page.getByRole('button',{name:/В мастерскую/}).click();await page.waitForTimeout(500);await shot('landscape-builder-3d');
  await page.goto('http://127.0.0.1:4393/games/test-bench');
  await page.getByRole('button',{name:/Настройки/}).click();
  await page.getByLabel('Язык',{exact:true}).selectOption('en');
  await page.getByLabel('View',{exact:true}).selectOption('2d');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.goto('http://127.0.0.1:4393/games/test-bench?mode=practice',{waitUntil:'networkidle'});await shot('landscape-builder-en-2d');
  await page.getByRole('button',{name:/Test drive/}).click();await page.waitForTimeout(500);await shot('landscape-race-en-2d');
  assert.deepEqual(observed.errors, [], 'Uncaught page errors');
  assert.deepEqual(observed.failedRequests, [], 'Failed game asset requests');
  for (const layout of observed.layout) {
    assert.ok(layout.scrollWidth <= layout.width + 1, `${layout.name}: horizontal page overflow`);
    if (layout.name.includes('race')) assert.deepEqual(layout.controls.filter(control=>control.visible&&!control.inViewport), [], `${layout.name}: race buttons outside the short viewport`);
  }
  await context.close();
} finally {
  const fs = await import('node:fs/promises');await fs.writeFile(path.join(output,'observations.json'),JSON.stringify(observed,null,2)+'\n');
  await browser.close();await new Promise(resolve=>server.close(resolve));
  console.log(JSON.stringify({output,errors:observed.errors,failedRequests:observed.failedRequests,metrics:observed.metrics,layout:observed.layout.map(({name,width,height,scrollWidth,scrollHeight,controls})=>({name,width,height,scrollWidth,scrollHeight,offscreenControls:controls.filter(c=>c.visible&&!c.inViewport)}))},null,2));
}
