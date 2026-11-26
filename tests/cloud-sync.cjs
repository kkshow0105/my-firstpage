// Isolated Edge tests. Every run uses fresh directories and random loopback origins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-m5-test-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const servers = [];
const browsers = [];
const exceptions = [];
let passed = 0;
let failed = false;

class Tab {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else waiter.resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        void this.send('Page.handleJavaScriptDialog', { accept: true });
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async wait(expression, timeout = 12000) {
    for (const end = Date.now() + timeout; Date.now() < end; ) {
      try { if (await this.eval(expression)) return; } catch (e) {
        if (!/Execution context was destroyed|Cannot find context/.test(e.message)) throw e;
      }
      await delay(75);
    }
    throw new Error('Timed out waiting for ' + expression);
  }
  async reload() {
    const before = await this.eval('performance.timeOrigin');
    await this.send('Page.reload');
    await this.wait("document.readyState==='complete' && typeof tripBook!=='undefined' && performance.timeOrigin!==" + before);
  }
  async offline(value) {
    // Change navigator.onLine and deliver the real browser online/offline event.
    await this.send('Network.enable');
    await this.send('Network.emulateNetworkConditions', { offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
  async click(selector) {
    await this.send('Page.bringToFront');
    const {x, y} = await this.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await this.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
    await this.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
  }
}

async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

async function startBrowser(name) {
  const profile = path.join(scratch, name);
  const portFile = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  const child = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  browsers.push(child);
  let port;
  for (let i = 0; i < 120; i++) {
    try { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); } catch {}
    if (port) break;
    await delay(100);
  }
  assert.ok(port, 'isolated Edge started');
  return {
    async tab(url, onBeforeNavigate) {
      const entry = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
      const socket = new WebSocket(entry.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const tab = new Tab(socket);
      await tab.send('Runtime.enable');
      await tab.send('Page.enable');
      if (onBeforeNavigate) await onBeforeNavigate(tab);
      await tab.send('Page.navigate', { url });
      await tab.wait("document.readyState==='complete' && typeof tripBook!=='undefined'");
      return tab;
    },
    async stop() {
      await fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.json()).then(async version => {
        const socket = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
      });
    }
  };
}

function staticResponse(req, res, { worker, html, offline = false, cloudOrigin } = {}) {
  if (offline) { req.socket.destroy(); return; }
  const url = new URL(req.url, 'http://local.test');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (name === 'sw.js' && worker !== undefined) {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(worker);
    return;
  }
  if (name === 'index.html' && html !== undefined) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (name.startsWith('test-private/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"private":true}');
    return;
  }
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  const extension = path.extname(file);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png' };
  res.writeHead(200, { 'Content-Type': mime[extension] || 'application/octet-stream', 'Cache-Control':'no-store' });
  const bytes = fs.readFileSync(file);
  res.end(extension === '.js' && name === 'cloud.js' && cloudOrigin
    ? bytes.toString().replace('https://xhknatnpardduwzbvrih.supabase.co', cloudOrigin) : bytes);
}

async function check(name, operation) {
  await operation();
  passed++;
  console.log('PASS ' + name);
}

const workerSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const oldWorker = [
  "const name='shuangbiao-v8';",
  "self.addEventListener('install',e=>e.waitUntil(caches.open(name).then(c=>c.addAll(['./','./index.html','./manifest.json']))));",
  "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",
  "self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')e.waitUntil(self.skipWaiting());});",
  "self.addEventListener('fetch',e=>{if(e.request.method==='GET')e.respondWith(caches.open(name).then(async c=>{const old=await c.match(e.request);if(old)return old;const newValue=await fetch(e.request);if(newValue.ok)await c.put(e.request,newValue.clone());return newValue;}));});"
].join('\n');
const verifyWorker = '(async()=>{const c=navigator.serviceWorker.controller;if(!c)return false;return new Promise(resolve=>{const m=new MessageChannel();const t=setTimeout(()=>{m.port1.close();resolve(false)},350);m.port1.onmessage=e=>{clearTimeout(t);m.port1.close();resolve(e.data==="ledger-static-only-v1")};c.postMessage({type:"LEDGER_CHECK_NETWORK_POLICY"},[m.port2])})})()';
const marker = 'dual_table_m5_worker_test_pending';

async function workerTests() {
  const previous = process.env.LEDGER_M6_PREVIOUS_REF;
  const priorFile = name => execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'show', previous + ':' + name], { cwd: root, encoding: 'utf8' });
  let source = previous ? priorFile('sw.js') : oldWorker;
  let html = previous ? priorFile('index.html') : undefined;
  if (previous) assert.match(source, /CACHE_PREFIX \+ 'v8'/, 'Previous release must use the v8 Worker');
  let offline = false;
  const api = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end('{"private":true}');
  });
  const site = await serve((req,res) => staticResponse(req,res,{ worker: source, html, offline, cloudOrigin: api }));
  const browser = await startBrowser('worker');
  const tab = await browser.tab(site);

  await check('old worker is distinguishable and can have previously cached a cross-origin response', async () => {
    await tab.wait('!!navigator.serviceWorker.controller');
    assert.equal(await tab.eval(verifyWorker), false);
    if (previous) {
      assert.equal(await tab.eval("document.querySelector('.dropdown-version').textContent"), 'v2.0.2');
      assert.ok(await addOrder(tab, 'SyntheticBeforeUpdate'));
      await tab.eval("localStorage.setItem(ACTIVE_TRIP_KEY,activeTripId);localStorage.setItem(RESTORE_SAFETY_KEY,'{}');localStorage.setItem(V5_KEYS[0],'[]')");
    } else {
      assert.equal(await tab.eval('cloudSync.workerReady'), false);
      assert.match(await tab.eval("cloudSync.signIn('m5@example.com','test-password').catch(e=>e.message)"), /更新 PWA/);
    }
    assert.equal(await tab.eval("fetch("+JSON.stringify(api+'/old-response')+").then(r=>r.status)"), 200);
    assert.equal(await tab.eval("(async()=>!!(await caches.match("+JSON.stringify(api+'/old-response')+")))()"), true);
    await tab.eval("localStorage.setItem("+JSON.stringify(marker)+",'keep');window.oldLedger="+localSnapshot);
  });
  await check('new worker waits, takes control only after update, and cleans old app cache', async () => {
    source = workerSource;
    html = undefined;
    await tab.eval('pwaRegistration.update()');
    await tab.wait('!!pwaRegistration.waiting && !document.getElementById("update-banner").hidden');
    assert.equal(await tab.eval(verifyWorker), false);
    await tab.eval("sessionStorage.setItem('sw-test-original',oldLedger)");
    await tab.reload();
    await tab.wait('!!pwaRegistration.waiting && !document.getElementById("update-banner").hidden');
    await tab.click('#btn-update-now');
    await delay(500);
    try { await tab.wait(verifyWorker); }
    catch (error) {
      console.error(await tab.eval("(async()=>({controller:navigator.serviceWorker.controller?.state,version:await caches.keys(),waiting:pwaRegistration?.waiting?.state,updateRequested,updateReloaded,banner:document.getElementById('update-banner').hidden}))()"));
      throw error;
    }
    await tab.wait("document.readyState==='complete'&&!pwaRegistration?.waiting");
    await tab.wait('cloudSync.workerReady');
    assert.equal(await tab.eval(localSnapshot+"===sessionStorage.getItem('sw-test-original')"), true);
    if (previous) {
      assert.equal(await tab.eval("document.querySelector('.dropdown-version').textContent"), 'v3.0.0');
      assert.equal(await tab.eval("orders.length===1&&orders[0].customer==='SyntheticBeforeUpdate'"), true);
      assert.equal(await tab.eval('cloudSync.context===null'), true);
    }
    assert.equal(await tab.eval("localStorage.getItem("+JSON.stringify(marker)+")"), 'keep');
    assert.equal(await tab.eval("caches.keys().then(k=>!k.includes('shuangbiao-v8'))"), true);
  });
  await check('cross-origin Auth, REST and RPC, and non-static same-origin reads do not enter cache', async () => {
    const urls = [api+'/auth/v1/user',api+'/rest/v1/ledger_orders',api+'/rest/v1/rpc/read_ledger',site+'/test-private/record'];
    assert.deepEqual(await tab.eval('Promise.all('+JSON.stringify(urls)+'.map(url=>fetch(url).then(r=>r.status)))'), [200,200,200,200]);
    assert.equal(await tab.eval("caches.keys().then(async names=>{const keys=(await Promise.all(names.map(async n=>(await caches.open(n)).keys()))).flat();return keys.every(k=>new URL(k.url).origin===location.origin&&!/auth|rest|test-private|old-response/.test(k.url))})"), true);
  });
  await check('PWA opens offline with the existing ledger and new worker', async () => {
    offline = true;
    await tab.reload();
    assert.equal(await tab.eval(verifyWorker), true);
    assert.equal(await tab.eval(localSnapshot+"===sessionStorage.getItem('sw-test-original')"), true);
  });
  await browser.stop();
}

const alice = { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', email: 'm5-alice@example.com' };
const bob = { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', email: 'm5-bob@example.com' };
const testPassword = 'fake-test-password';
const localSnapshot = "JSON.stringify(Object.fromEntries([BOOK_KEY,ACTIVE_TRIP_KEY,RESTORE_SAFETY_KEY,...WATCH_KEYS].map(k=>[k,localStorage.getItem(k)])))";
const synced = "document.getElementById('cloud-status').textContent==='已同步' && !!cloudSync.context?.record";
const conflict = "document.getElementById('cloud-status').textContent==='同步冲突'";

async function mockCloud() {
  const users = [alice, bob];
  const states = new Map(users.map(user => [user.id, { version: 0, trips: [], deletedTripIds: [], receipts: new Map() }]));
  const requests = [];
  const controls = { pause: null, failNext: false, loseNext: false, refreshes: 0, offline: false };
  const origin = await serve(async (req, res) => {
    if (controls.offline) { req.socket.destroy(); return; }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'apikey, authorization, content-type');
    res.setHeader('Content-Type', 'application/json');
    const reply = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.method === 'OPTIONS') return reply(204);
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); }
    catch (error) { if (req.aborted) return; throw error; }
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    if (req.url.startsWith('/auth/v1/token')) {
      const refreshing = req.url.endsWith('refresh_token');
      const user = refreshing ? users.find(u => body.refresh_token === 'refresh-' + u.id)
        : users.find(u => u.email === body.email && body.password === testPassword);
      if (!user) return reply(400, { error_code: 'invalid_credentials' });
      if (refreshing) controls.refreshes++;
      return reply(200, { user, expires_in: 3600, access_token: 'access-' + user.id, refresh_token: 'refresh-' + user.id });
    }
    const user = users.find(u => req.headers.authorization === 'Bearer access-' + u.id);
    if (!user) return reply(401, { code: 'invalid_session' });
    const state = states.get(user.id);
    if (req.url.startsWith('/auth/v1/logout?')) return reply(204);
    if (req.url === '/rest/v1/rpc/read_ledger') return reply(200, { schemaVersion: 1, ...state });
    if (req.url !== '/rest/v1/rpc/commit_ledger' || req.method !== 'POST') return reply(404);
    requests.push({ userId: user.id, raw, ...body });
    if (controls.pause) await controls.pause;
    if (controls.failNext) { controls.failNext = false; return reply(503, { code: 'test_failure' }); }
    const receipt = state.receipts.get(body.p_commit_id);
    if (receipt) {
      return receipt.raw === raw ? reply(200, { status: 'replayed', appliedVersion: receipt.version, currentVersion: state.version })
        : reply(409, { code: 'ledger_commit_id_reused' });
    }
    if (state.version !== body.p_base_version) return reply(409, { code: 'ledger_version_conflict' });
    const ids = new Set(body.p_trips.map(t => t.id));
    const removed = state.trips.filter(t => !ids.has(t.id)).map(t => t.id);
    const deleted = new Set([...state.deletedTripIds, ...removed]);
    body.p_restore_trip_ids.forEach(id => deleted.delete(id));
    if ([...ids].some(id => deleted.has(id))) return reply(409, { code: 'ledger_trip_deleted' });
    state.deletedTripIds = [...deleted];
    state.trips = body.p_trips;
    state.version++;
    state.receipts.set(body.p_commit_id, { raw, version: state.version });
    if (controls.loseNext) { controls.loseNext = false; req.socket.destroy(); return; }
    return reply(200, { status: 'applied', appliedVersion: state.version, currentVersion: state.version });
  });
  return { origin, states, requests, controls };
}

async function login(tab, email, password = testPassword) {
  await tab.eval('openCloudPanel()');
  await tab.wait('cloudSync.workerReady && navigator.onLine', 25000);
  await tab.eval(`openCloudPanel();document.getElementById('cloud-email').value=${JSON.stringify(email)};
    document.getElementById('cloud-password').value=${JSON.stringify(password)};document.getElementById('cloud-login').requestSubmit();`);
  await tab.wait('!cloudLoginBusy');
}

async function logout(tab) {
  await tab.eval("openCloudPanel();document.getElementById('cloud-logout').click()");
  await tab.wait("!cloudSync.context && document.getElementById('cloud-status').textContent==='本地模式'");
}

function addOrder(tab, customer, product = 'TEST', qty = 3) {
  const fields = { customer, product, qty, price: 25.51, location: '测试店' };
  return tab.eval(`(()=>{openAddModal();showAddStep(2);for(const [id,value] of Object.entries(${JSON.stringify(fields)}))
    document.getElementById('input-confirm-'+id).value=value;confirmAddOrder();return orders.at(-1)?.id})()`);
}

async function restoreFixture(tab, version, approve = true) {
  const data = fs.readFileSync(path.join(root, 'tests/fixtures/legacy-v' + version + '-backup.json'), 'utf8');
  await tab.eval(`(()=>{openImportModal();const file=new File([${JSON.stringify(data)}],'test.json');
    handleImportFile({target:{files:[file],value:''}});})()`);
  await tab.wait('!!pendingImport');
  await tab.eval(`document.getElementById('import-trip-target').value='__new__';
    document.getElementById('import-trip-name').value='测试备份';updateImportSummary();
    window.confirm=message=>{window.restoreConfirmation=message;return ${approve}};confirmImportBackup()`);
}

async function syncTests() {
  const { origin, states, requests, controls } = await mockCloud();
  const site = await serve((req, res) => staticResponse(req, res, { cloudOrigin: origin, offline: controls.offline }));
  let browser = await startBrowser('account'), tab = await browser.tab(site);
  const cloudA = states.get(alice.id), cloudB = states.get(bob.id);
  let original, orderId;
  await check('unsigned local entry and historical keys are independent from cloud', async () => {
    assert.equal(await tab.eval("document.getElementById('cloud-status').textContent"), '本地模式');
    assert.ok(await addOrder(tab, 'LegacyLocal'));
    await tab.eval("localStorage.setItem(ACTIVE_TRIP_KEY,activeTripId);localStorage.setItem(RESTORE_SAFETY_KEY,'{}');localStorage.setItem(V5_KEYS[0],'[]')");
    await tab.reload();
    original = await tab.eval(localSnapshot);
    assert.equal(await tab.eval('orders[0].customer'), 'LegacyLocal');
    assert.equal(requests.length, 0);
  });
  await check('invalid login is explained and password field is cleared', async () => {
    await login(tab, alice.email, 'wrong-test-password');
    assert.match(await tab.eval("document.getElementById('cloud-detail').textContent"), /邮箱或密码不正确/);
    assert.equal(await tab.eval("document.getElementById('cloud-password').value"), '');
    assert.equal(await tab.eval('!!cloudSync.context'), false);
  });
  await check('signed-in empty cloud never imports or replaces legacy book', async () => {
    await login(tab, alice.email);
    await tab.wait(synced);
    assert.equal(await tab.eval('orders.length'), 0);
    assert.equal(await tab.eval(localSnapshot), original);
    assert.equal(cloudA.version, 0);
    await tab.eval('openCloudPanel()');
    assert.match(await tab.eval("document.getElementById('cloud-legacy').textContent"), /尚未迁移/);
    await tab.eval('closeCloudPanel()');
  });
  await check('offline order persists locally first', async () => {
    await tab.offline(true);
    await tab.wait("document.getElementById('cloud-status').textContent==='离线'");
    orderId = await addOrder(tab, 'OfflineAlice');
    assert.ok(orderId);
    assert.equal(await tab.eval('cloudSync.context.record.dirty'), true);
    assert.equal(cloudA.version, 0);
  });
  await check('offline payment persists', async () => {
    await tab.eval(`togglePaid(${JSON.stringify(orderId)})`);
    assert.equal(await tab.eval('cloudSync.context.record.book.trips[0].orders[0].isPaid'), true);
  });
  await check('offline purchase persists with partial allocation', async () => {
    await tab.eval("pendingAlloc=allocatePurchase('TEST',2,10.55,'测试采购点',true);confirmAllocation()");
    assert.equal(await tab.eval('orders[0].purchased'), 2);
    assert.equal(await tab.eval('purchaseLogs[0].totalCost'), 21.1);
    assert.equal(await tab.eval(localSnapshot), original);
  });
  await check('offline refresh retains session, purchased state and pending snapshot', async () => {
    await tab.reload();
    await tab.wait('cloudSync.context?.record?.dirty === true');
    assert.equal(await tab.eval('orders[0].id'), orderId);
    assert.equal(await tab.eval('orders[0].isPaid && orders[0].purchased===2'), true);
    assert.equal(cloudA.version, 0);
  });
  await check('browser restart with same isolated profile retains pending snapshot', async () => {
    controls.offline = true;
    await browser.stop();
    browser = await startBrowser('account');
    tab = await browser.tab(site, t => t.offline(true));
    await tab.offline(true);
    try { await tab.wait('cloudSync.pending()', 25000); }
    catch (error) {
      console.error(await tab.eval(`({online:navigator.onLine,worker:cloudSync.workerReady,status:document.getElementById('cloud-status').textContent,
        session:!!cloudSync.context,record:!!cloudSync.context?.record,writer:cloudSync.context?.writer,
        keys:Object.keys(localStorage).filter(k=>k.startsWith('dual_table_cloud')).length})`));
      throw error;
    }
    assert.equal(await tab.eval('orders[0].id'), orderId);
    assert.equal(cloudA.version, 0);
  });
  await check('network recovery automatically submits and acknowledges the snapshot', async () => {
    controls.offline = false;
    await tab.offline(false);
    await tab.wait(synced);
    assert.equal(cloudA.version, 1);
    assert.equal(cloudA.trips[0].orders[0].id, orderId);
    assert.equal(cloudA.trips[0].orders[0].purchased, 2);
    assert.equal(cloudA.trips[0].orders[0].isPaid, true);
    assert.equal(await tab.eval(localSnapshot), original);
  });
  await check('storage write failure keeps the previous book and avoids queuing an unsaved edit', async () => {
    const before = await tab.eval('cloudSync.context.raw');
    await tab.eval(`window.nativeM5Set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
      if(key.startsWith(LEDGER_ACCOUNT))throw new DOMException('test quota','QuotaExceededError');return nativeM5Set.call(this,key,value);}`);
    try { await addOrder(tab, 'RejectedByStorage'); }
    finally { await tab.eval('Storage.prototype.setItem=nativeM5Set'); }
    assert.equal(await tab.eval('cloudSync.context.raw'), before);
    assert.equal(await tab.eval('orders.length'), 1);
    assert.equal(await tab.eval('cloudSync.pending()'), false);
    assert.equal(cloudA.version, 1);
  });
  let release;
  await check('new edits during a failed in-flight commit do not alter that submission', async () => {
    controls.pause = new Promise(resolve => { release = resolve; });
    controls.failNext = true;
    await addOrder(tab, 'FirstFlight');
    await tab.wait('!!cloudSync.context?.record?.flight');
    assert.equal(await tab.eval("document.getElementById('cloud-status').textContent"), '正在同步');
    const flight = await tab.eval('cloudSync.context.record.flight');
    await addOrder(tab, 'NewerEdit');
    assert.equal(await tab.eval('cloudSync.context.record.flight'), flight);
    assert.equal(await tab.eval('cloudSync.context.record.dirty'), true);
    release(); controls.pause = null;
    await tab.wait("document.getElementById('cloud-status').textContent==='同步失败'");
    assert.equal(await tab.eval('orders.at(-1).customer'), 'NewerEdit');
    assert.equal(cloudA.version, 1);
  });
  await check('failed submission retries unchanged before a new commit', async () => {
    await tab.wait(synced);
    assert.equal(requests[1].raw, requests[2].raw);
    assert.notEqual(requests[2].p_commit_id, requests[3].p_commit_id);
    assert.equal(cloudA.version, 3);
    assert.deepEqual(cloudA.trips[0].orders.map(o => o.customer), ['OfflineAlice','FirstFlight','NewerEdit']);
  });
  await check('lost server acknowledgment replays the same commit exactly once', async () => {
    controls.loseNext = true;
    await addOrder(tab, 'LostResponse');
    await tab.wait(synced);
    assert.equal(cloudA.version, 4);
    assert.equal(requests[4].raw, requests[5].raw);
    assert.equal(cloudA.trips[0].orders.filter(o => o.customer === 'LostResponse').length, 1);
  });
  await check('logout with pending data immediately returns to independent local ledger', async () => {
    await tab.offline(true);
    await addOrder(tab, 'PendingAlice');
    await logout(tab);
    assert.equal(await tab.eval('orders[0].customer'), 'LegacyLocal');
    assert.equal(await tab.eval(localSnapshot), original);
    assert.equal(await tab.eval(`JSON.parse(localStorage.getItem(LEDGER_ACCOUNT+${JSON.stringify(alice.id)})).dirty`), true);
    assert.equal(cloudA.version, 4);
  });
  await check('different account cannot see or upload first account cache', async () => {
    await tab.offline(false);
    await login(tab, bob.email);
    await tab.wait(synced);
    assert.equal(await tab.eval('orders.length'), 0);
    assert.equal(await tab.eval('cloudSync.context.session.userId'), bob.id);
    assert.ok(!await tab.eval("document.body.textContent.includes('PendingAlice')"));
    await addOrder(tab, 'OnlyBob');
    await tab.wait(synced);
    assert.deepEqual(cloudB.trips[0].orders.map(o => o.customer), ['OnlyBob']);
    assert.equal(cloudA.version, 4);
  });
  await check('returning to original account continues its pending work', async () => {
    await logout(tab);
    await login(tab, alice.email);
    await tab.wait(synced);
    assert.equal(cloudA.version, 5);
    assert.equal(cloudA.trips[0].orders.at(-1).customer, 'PendingAlice');
    assert.equal(await tab.eval(localSnapshot), original);
  });
  await check('stored session refresh uses a normal token refresh without losing the account', async () => {
    await tab.eval("const expired=JSON.parse(localStorage.getItem(LEDGER_SESSION));expired.expiresAt=0;localStorage.setItem(LEDGER_SESSION,JSON.stringify(expired));cloudSync.schedule()");
    await tab.wait('JSON.parse(localStorage.getItem(LEDGER_SESSION)).expiresAt>Date.now()');
    assert.equal(controls.refreshes, 1);
    assert.equal(await tab.eval('cloudSync.context.session.userId'), alice.id);
  });
  await check('real browser cache contains no login or ledger responses after auth and commits', async () => {
    const urls = await tab.eval(`caches.keys().then(async names=>(await Promise.all(names.map(async name=>
      (await caches.open(name)).keys()))).flat().map(request=>new URL(request.url).pathname).sort())`);
    assert.deepEqual(urls, ['/', '/cloud.js', '/icon-192.png', '/icon-512.png', '/index.html', '/manifest.json']);
  });
  await check('same-profile second tab cannot race the active writer', async () => {
    const otherTab = await browser.tab(site);
    await otherTab.wait('!!cloudSync.context?.record');
    assert.equal(await otherTab.eval('cloudSync.canWrite'), false);
    assert.equal(await otherTab.eval('orders.at(-1).customer'), 'PendingAlice');
    await otherTab.eval("createTrip('must-not-write')");
    assert.equal(cloudA.version, 5);
  });
  await check('old v5 and v6 backups require account-specific confirmation', async () => {
    await tab.wait('cloudSync.canRestore');
    await restoreFixture(tab, 5, false);
    assert.match(await tab.eval('restoreConfirmation'), /当前云端账号.*校验版本/);
    assert.equal(cloudA.version, 5);
    await tab.eval('closeImportModal()');
    await restoreFixture(tab, 6);
    await tab.wait(synced);
    assert.equal(cloudA.version, 6);
    assert.equal(await tab.eval('orders.length'), 5);
    assert.equal(await tab.eval('purchaseLogs.length'), 3);
    assert.equal(await tab.eval('cloudSync.context.record.safety.trips[0].orders.at(-1).customer'), 'PendingAlice');
    assert.equal(await tab.eval(localSnapshot), original);
  });
  const second = await startBrowser('second-device');
  const device = await second.tab(site);
  await check('fresh device reads original account with stable IDs', async () => {
    await login(device, alice.email);
    await device.wait(synced);
    assert.equal(await device.eval('tripBook.trips.length'), 2);
    assert.equal(await device.eval('tripBook.trips[0].orders[0].id'), orderId);
  });
  await check('two devices editing concurrently keep both sides on version conflict', async () => {
    await Promise.all([tab.offline(true), device.offline(true)]);
    await device.eval("window.confirm=()=>true;deleteTrip(tripBook.trips[0].id)");
    await addOrder(tab, 'DeviceLocal', 'OTHER');
    await device.offline(false);
    await device.wait(synced);
    assert.equal(cloudA.version, 7);
    assert.equal(cloudA.trips.length, 1);
    await tab.offline(false);
    await tab.wait(conflict);
    assert.equal(await tab.eval('orders.at(-1).customer'), 'DeviceLocal');
    assert.equal(await tab.eval('tripBook.trips[0].orders[0].id'), orderId);
    assert.equal(cloudA.trips.some(t=>t.orders.some(o=>o.id===orderId)), false);
  });
  await check('conflict persists after reload and offers read-only cloud preview and local export', async () => {
    const requestsBefore = requests.length;
    await tab.reload();
    await tab.wait(conflict);
    await tab.eval("openCloudPanel();document.getElementById('cloud-show-remote').click()");
    await tab.wait("document.getElementById('cloud-preview').textContent.includes('云端版本 7')");
    assert.ok(!await tab.eval("document.getElementById('cloud-preview').textContent.includes('DeviceLocal')"));
    await tab.eval("window.downloadRecoveryFile=value=>window.exported=value;document.getElementById('cloud-export').click()");
    assert.equal(await tab.eval('exported.trips.length'), 2);
    assert.equal(await tab.eval("exported.trips.some(t=>t.orders.at(-1)?.customer==='DeviceLocal')"), true);
    assert.equal(await tab.eval("openImportModal();document.getElementById('modal-import').classList.contains('show')"), false);
    assert.equal(requests.length, requestsBefore);
  });
  await check('iPhone narrow layout fits status, login and conflict controls', async () => {
    for (const width of [320, 390]) {
      for (const [testTab, buttons] of [[tab, ['#cloud-show-remote','#cloud-export','#cloud-logout']], [device, ['#cloud-email','#cloud-password','#cloud-login-submit']]]) {
        if (testTab === device && await testTab.eval('!!cloudSync.context')) await logout(testTab);
        await testTab.send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: true });
        await testTab.eval('openCloudPanel()');
        await delay(300);
        const dimensions = await testTab.eval(`(()=>({ viewport:document.documentElement.clientWidth, buttons:
          ${JSON.stringify([...buttons,'#cloud-status'])}.map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.left,r.right,r.height]})}))()`);
        assert.equal(dimensions.viewport, width);
        assert.ok(dimensions.buttons.every(([left,right,height])=>left>=0&&right<=width&&height>=32));
        const screenshots = process.env.LEDGER_M5_SCREENSHOTS;
        if (screenshots && width === 390) {
          fs.mkdirSync(screenshots, { recursive: true });
          const output = path.join(screenshots, testTab === tab ? 'conflict.png' : 'login.png');
          fs.writeFileSync(output, Buffer.from((await testTab.send('Page.captureScreenshot')).data, 'base64'));
        }
      }
    }
  });
  await second.stop();
  await browser.stop();
}

async function main() {
  if (process.argv.includes('--real-api')) await realApiTests();
  else {
    await workerTests();
    await syncTests();
  }
  await check('no browser JavaScript exceptions', () => assert.deepEqual(exceptions, []));
}

async function realApiTests() {
  const ref = 'xhknatnpardduwzbvrih';
  assert.equal(process.env.LEDGER_M5_PROJECT_REF, ref, 'Explicitly select the M5 test project');
  const secret = process.env.LEDGER_M5_SECRET_KEY;
  delete process.env.LEDGER_M5_SECRET_KEY;
  assert.ok(secret?.startsWith('sb_secret_'), 'Test lifecycle requires a Supabase secret key');
  const origin = 'https://' + ref + '.supabase.co';
  const run = randomUUID();
  const accounts = ['a', 'b'].map(letter => ({ email: `ledger-m5-${run}-${letter}@example.com`,
    password: randomBytes(28).toString('base64url') + '!Az7' }));
  async function usersApi(method, suffix = '', body) {
    const response = await fetch(origin + '/auth/v1/admin/users' + suffix, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { apikey: secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 404 && suffix.startsWith('/')) return null;
    assert.ok(response.ok, 'Temporary user lifecycle HTTP ' + response.status);
    return response.json();
  }
  try {
    for (const account of accounts) {
      const user = await usersApi('POST', '', { email: account.email, password: account.password, email_confirm: true });
      assert.equal(user.email, account.email);
      assert.match(user.id, /^[0-9a-f-]{36}$/);
      account.id = user.id;
    }
    const site = await serve(staticResponse);
    const browser = await startBrowser('real-a'), tab = await browser.tab(site);
    let id;
    await check('real Supabase Auth and RPC accept only signed-in synthetic account data', async () => {
      await login(tab, accounts[0].email, accounts[0].password);
      await tab.wait(synced, 35000);
      assert.equal(await tab.eval('cloudSync.context.record.base'), 0);
      await tab.offline(true);
      id = await addOrder(tab, 'M5 Test Customer', 'M5TestItem');
      await tab.eval(`togglePaid(${JSON.stringify(id)});pendingAlloc=allocatePurchase('M5TestItem',2,10.55,'Test',true);confirmAllocation()`);
      await tab.offline(false);
      await tab.wait(synced, 35000);
      assert.equal(await tab.eval('cloudSync.context.record.base'), 1);
    });
    const independent = await startBrowser('real-device'), device = await independent.tab(site);
    await check('fresh isolated browser reads real persisted payment, procurement and same record ID', async () => {
      await login(device, accounts[0].email, accounts[0].password);
      await device.wait(synced, 35000);
      assert.deepEqual(await device.eval('({ id:orders[0].id,paid:orders[0].isPaid,purchased:orders[0].purchased,cost:purchaseLogs[0].totalCost })'),
        { id, paid: true, purchased: 2, cost: 21.1 });
    });
    await check('real multi-device version conflict protects remote and pending snapshots', async () => {
      await tab.offline(true);
      await addOrder(tab, 'LocalVersion', 'M5TestItem');
      await addOrder(device, 'RemoteVersion', 'M5TestItem');
      await device.wait(synced, 35000);
      assert.equal(await device.eval('cloudSync.context.record.base'), 2);
      await tab.offline(false);
      await tab.wait(conflict, 35000);
      const remote = await tab.eval("cloudSync.preview().then(data=>data.trips[0].orders.map(o=>o.customer))");
      assert.deepEqual(remote, ['M5 Test Customer', 'RemoteVersion']);
      assert.equal(await tab.eval('orders.at(-1).customer'), 'LocalVersion');
    });
    await check('real second account on the first browser cannot see the pending first account', async () => {
      await logout(tab);
      await login(tab, accounts[1].email, accounts[1].password);
      await tab.wait(synced, 35000);
      assert.equal(await tab.eval('cloudSync.context.record.base'), 0);
      assert.equal(await tab.eval('cloudSync.context.session.userId'), accounts[1].id);
      assert.equal(await tab.eval('orders.length'), 0);
      await logout(tab);
      await logout(device);
    });
    await independent.stop();
    await browser.stop();
  } finally {
    // Bound cleanup to exact generated emails, including a response lost during creation.
    const { users } = await usersApi('GET', '?page=1&per_page=1000');
    for (const account of accounts) {
      const id = account.id || users.find(user => user.email === account.email)?.id;
      if (!id) continue;
      assert.match(id, /^[0-9a-f-]{36}$/);
      await usersApi('DELETE', '/' + id);
      assert.equal(await usersApi('GET', '/' + id), null);
    }
    console.log('CLEANUP temporary M5 test users verified removed');
  }
}

main().catch(error => {
  failed = true;
  process.exitCode = 1;
  console.error(error.stack);
}).finally(() => {
  for (const child of browsers) if (child.exitCode === null) child.kill();
  for (const server of servers) server.close();
  console.log(JSON.stringify({ passed, failed }));
  if (failed) console.error('Evidence directory: ' + scratch);
  else {
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
});
