// 数据安全回归：node tests/data-safety.cjs
// Node 22+、已安装Edge（可用EDGE_PATH指定）；无第三方依赖，不下载浏览器。
// 独立临时浏览器目录和127.0.0.1来源；成功自动清理，失败保留测试证据。
const fs=require('fs'),http=require('http'),cp=require('child_process'),path=require('path');
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(require('os').tmpdir(),'jizhang-data-safety-')),out=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));let edge,server;const pageErrors=[];
class CDP{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);this.pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else {this.events.push(m);if(m.method==='Runtime.exceptionThrown')pageErrors.push(m);}};}
 static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return new CDP(ws);}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
async function main(){
 server=http.createServer((req,res)=>{let name=new URL(req.url,'http://localhost').pathname;if(name==='/')name='/index.html';const file=path.join(root,name);if(!file.startsWith(root)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':'image/png');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 try{fs.unlinkSync(path.join(scratch,'profile/DevToolsActivePort'));}catch{}
 edge=cp.spawn(process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(scratch,'profile'),'about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=Number(fs.readFileSync(path.join(scratch,'profile/DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{}await sleep(100);}if(!port)throw Error('Edge startup failed');
 async function tab(){const t=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();const c=await CDP.connect(t.webSocketDebuggerUrl);await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};'});await c.send('Page.navigate',{url:origin});await sleep(180);return c;}
 let a=await tab();
 async function reset(seed={}){await a.eval('localStorage.clear();'+Object.entries(seed).map(([k,v])=>'localStorage.setItem('+JSON.stringify(k)+','+JSON.stringify(typeof v==='string'?v:JSON.stringify(v))+');').join(''));await a.send('Page.reload');await sleep(120);}
 const O='dual_table_orders_v6',L='dual_table_purchase_logs_v6',M='dual_table_product_meta_v6';
 const helper="window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};window.add=(customer,product,qty,price=20,location='店A')=>{for(const [id,val] of Object.entries({'customer':customer,'product':product,'qty':qty,'price':price,'location':location}))document.getElementById('input-confirm-'+id).value=val;confirmAddOrder();return orders.at(-1)?.id;};window.buy=(product,qty,price=10,location='店B')=>{pendingAlloc=allocatePurchase(product,qty,price,location,true);confirmAllocation();};window.edit=(id,field,val)=>{openEditFieldModal(id,field);document.getElementById('input-edit-field').value=val;confirmEditField();};window.total=(product,n)=>{openEditPurchasedModal(product,'',0);document.getElementById('input-edit-purchased').value=n;confirmEditPurchased();};window.price=(product,n)=>{openEditProductPriceModal(product);document.getElementById('input-edit-product-price').value=n;confirmEditProductPrice();};window.state=()=>({orders,purchaseLogs,productMeta,spend:document.getElementById('finance-total').dataset.raw,sales:document.getElementById('finance-sales').dataset.raw,toast:document.getElementById('toast').textContent});";
 async function fresh(seed={}){await reset(seed);await a.eval(helper);}
 async function record(name,fn){try{out.push({name,result:await fn()});}catch(e){out.push({name,error:String(e)});}console.log(JSON.stringify(out.at(-1)));fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify(out,null,2));}

 const assert=require('assert');
 const rawExpr="JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])))";
 const sample={version:2,orders:[{id:'o1',customer:'客户A',product:'X',qty:3,purchased:2,sellingPrice:20,isPaid:false,location:'店A'}],purchaseLogs:[{id:'l1',product:'X',qty:2,unitPrice:10,totalCost:20,location:'店B',timestamp:1}],productMeta:{X:{lastLocation:'店B',lastPrice:10,note:''}}};
 const clone=x=>JSON.parse(JSON.stringify(x));
 const seedOf=b=>({[O]:b.orders,[L]:b.purchaseLogs,[M]:b.productMeta});
 const legacy={'dual_table_orders_v5':sample.orders,'dual_table_purchase_logs_v5':sample.purchaseLogs,'dual_table_product_meta_v5':sample.productMeta};
 async function waitFor(expression,expected){
   const until=Date.now()+6000;
   while(Date.now()<until){if(await a.eval(expression)===expected)return;await sleep(100);}
   assert.equal(await a.eval(expression),expected,'等待状态超时：'+expression);
 }
 async function imp(value,raw=false){
   await a.eval('handleImportFile({target:{files:[new File(['+JSON.stringify(raw?value:JSON.stringify(value))+"],'test.json')],value:''}})");
   await sleep(80);
 }
 async function inject(source){return(await a.send('Page.addScriptToEvaluateOnNewDocument',{source})).identifier;}
 async function reload(){await a.send('Page.reload');await sleep(140);}
 async function removeInject(id){await a.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:id});}
 async function protectedUnchanged(before){
   assert.equal(await a.eval(rawExpr),before);
   assert.equal(await a.eval('!!dataProtection'),true);
 }
 async function downloadRecovery(folder,commands){
   const dir=path.join(scratch,folder);fs.mkdirSync(dir,{recursive:true});
   await a.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});
   await a.eval(commands);await sleep(250);
   return fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(fs.readFileSync(path.join(dir,x),'utf8')));
 }
 // 正常业务及真实下载、恢复。
 await record('normal-business-refresh-reopen',async()=>{
   await fresh();
   const r=await a.eval("var first=add('A','X',3);buy('X',5,10);var initial=getCurrentStock('X');deleteOrder(first);var afterDelete=getCurrentStock('X');var next=add('B','X',4);edit(next,'qty',2);togglePaid(next);({initial,afterDelete,stock:getCurrentStock('X'),qty:orders[0].qty,paid:orders[0].isPaid,cost:state().spend})");
   assert.deepEqual(r,{initial:2,afterDelete:5,stock:3,qty:2,paid:true,cost:'50.00'});
   const before=await a.eval('JSON.stringify(validateDataState(captureDataState()))');
   await reload();assert.equal(await a.eval('JSON.stringify(captureDataState())'),before);
   await a.send('Page.close');a.ws.close();a=await tab();
   assert.equal(await a.eval('JSON.stringify(captureDataState())'),before);
   return r;
 });
 await record('normal-download-import',async()=>{
   const [backup]=await downloadRecovery('normal-download','doExportFile()');
   assert.equal(backup.version,2);await fresh();await imp(backup);
   assert.equal(await a.eval('!!dataProtection'),false);
   assert.equal(await a.eval('orders[0].isPaid'),true);
   assert.equal(await a.eval("getCurrentStock('X')"),3);
   return{downloadedAndRestored:true};
 });
 const invalid=[
   ['orders-null',x=>x.orders=[null]],['qty-string',x=>x.orders[0].qty='3'],
   ['price-string',x=>x.orders[0].sellingPrice='20'],['paid-string',x=>x.orders[0].isPaid='false'],
   ['negative-qty',x=>x.orders[0].qty=-1],['zero-qty',x=>x.orders[0].qty=0],
   ['fraction-qty',x=>x.orders[0].qty=1.5],['unsafe-qty',x=>x.orders[0].qty=9007199254740992],
   ['purchased-too-large',x=>x.orders[0].purchased=4],['duplicate-id',x=>x.orders.push(clone(x.orders[0]))],
   ['empty-id',x=>x.orders[0].id=''],['bad-id',x=>x.orders[0].id='x" onclick="bad'],
   ['empty-customer',x=>x.orders[0].customer=' '],['product-null',x=>x.orders[0].product=null],
   ['bad-location',x=>x.orders[0].location=[]],['bad-note',x=>x.orders[0].note=42],
   ['name-control',x=>x.orders[0].customer='A\nB'],
   ['logs-null',x=>x.purchaseLogs=[null]],['logs-object',x=>x.purchaseLogs={}],
   ['log-qty-string',x=>x.purchaseLogs[0].qty='2'],['log-zero',x=>x.purchaseLogs[0].qty=0],
   ['log-cost-mismatch',x=>x.purchaseLogs[0].totalCost=1],['log-timestamp',x=>x.purchaseLogs[0].timestamp='1'],
   ['log-duplicate-id',x=>x.purchaseLogs.push(clone(x.purchaseLogs[0]))],
   ['meta-array',x=>x.productMeta=[]],['meta-null',x=>x.productMeta=null],
   ['meta-value-array',x=>x.productMeta.X=[]],['meta-price-string',x=>x.productMeta.X.lastPrice='10'],
   ['meta-prototype',x=>x.productMeta=JSON.parse('{"__proto__":{"polluted":true}}')],
   ['allocated-over-purchase',x=>{x.purchaseLogs[0].qty=1;x.purchaseLogs[0].totalCost=10;}],
   ['stock-with-gap',x=>{x.purchaseLogs[0].qty=4;x.purchaseLogs[0].totalCost=40;}],
   ['unknown-version',x=>x.version=999],['missing-version',x=>delete x.version],
   ['oversize-money',x=>x.orders[0].sellingPrice=1e308]
 ];
 for(const [name,change] of invalid)await record('import-reject-'+name,async()=>{
   await fresh(seedOf(sample));const before=await a.eval(rawExpr),mem=await a.eval('JSON.stringify(captureDataState())');
   const data=clone(sample);change(data);await imp(data);
   assert.equal(await a.eval(rawExpr),before);
   assert.equal(await a.eval('JSON.stringify(captureDataState())'),mem);
   assert((await a.eval('window.lastAlert')).includes('导入已拒绝'));
   return{unchanged:true,error:await a.eval('window.lastAlert')};
 });
 for(const [name,value] of [['syntax','{broken'],['top-null','null']])await record('import-reject-'+name,async()=>{
   await fresh(seedOf(sample));const before=await a.eval(rawExpr);await imp(value,true);
   assert.equal(await a.eval(rawExpr),before);return{unchanged:true};
 });
 await record('import-default-note-and-zero-price',async()=>{
   await fresh();const data=clone(sample);data.orders[0].sellingPrice=0;
   data.purchaseLogs[0].unitPrice=0;data.purchaseLogs[0].totalCost=0;data.productMeta.X.lastPrice=null;
   await imp(data);assert.equal(await a.eval('orders[0].note'),'');
   assert.equal(await a.eval('productMeta.X.lastPrice'),null);assert.equal(await a.eval('!!dataProtection'),false);
   return{valid:true};
 });
 const corrupt=[
   ['syntax',{[O]:'{broken',[L]:[],[M]:{}}],['null',{[O]:'null',[L]:[],[M]:{}}],
   ['orders-object',{[O]:{},[L]:[],[M]:{}}],['logs-object',{[O]:[],[L]:{},[M]:{}}],
   ['constraint',{...seedOf(sample),[L]:[]}],['meta-bad',{[O]:[],[L]:[],[M]:{X:42}}]
 ];
 for(const [name,seed] of corrupt)await record('storage-protection-'+name,async()=>{
   await fresh(seed);assert.equal(await a.eval('!!dataProtection'),true);
   const before=await a.eval(rawExpr);
   await a.eval("add('New','X',1);buy('X',3);deleteOrder('o1');togglePaid('o1');clearAllData()");
   await protectedUnchanged(before);await reload();await protectedUnchanged(before);
   return{unchanged:true,reason:await a.eval('dataProtection.message')};
 });
 await record('absent-and-explicit-empty',async()=>{
   await fresh();assert.equal(await a.eval('!!dataProtection'),false);
   assert.equal(await a.eval('localStorage.getItem(ORDERS_KEY)'),null);
   await fresh({[O]:[],[L]:[],[M]:{}});assert.equal(await a.eval('!!dataProtection'),false);
   assert.equal(await a.eval('localStorage.getItem(ORDERS_KEY)'),'[]');return{valid:true};
 });
 await record('storage-read-denied',async()=>{
   await fresh(seedOf(sample));const before=await a.eval(rawExpr);
   const inj=await inject("var nativeGet=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='dual_table_orders_v6')throw Error('read denied');return nativeGet.call(this,k)}");
   await reload();assert.equal(await a.eval('!!dataProtection'),true);
   assert((await a.eval('dataProtection.message')).includes('无法读取'));
   await a.eval('Storage.prototype.getItem=nativeGet');assert.equal(await a.eval(rawExpr),before);
   await removeInject(inj);return{protected:true,unchanged:true};
 });
 await record('valid-v6-not-rewritten',async()=>{
   await fresh(seedOf(sample));const before=await a.eval('JSON.stringify(DATA_KEYS.map(k=>localStorage.getItem(k)))');
   await reload();assert.equal(await a.eval('JSON.stringify(DATA_KEYS.map(k=>localStorage.getItem(k)))'),before);
   return{unchanged:true};
 });
 // 迁移正常、故障、重试、主动清空与冲突保护。
 await record('migration-three-refresh-and-clear',async()=>{
   await fresh(legacy);assert.equal(await a.eval('!!dataProtection'),false);const before=await a.eval(rawExpr);
   for(let i=0;i<3;i++){await reload();assert.equal(await a.eval(rawExpr),before);}
   await a.eval('clearAllData()');
   for(let i=0;i<3;i++){await reload();assert.equal(await a.eval('orders.length'),0);assert.equal(await a.eval('purchaseLogs.length'),0);}
   for(const key of Object.keys(legacy))assert.equal(await a.eval('localStorage.getItem('+JSON.stringify(key)+')'),JSON.stringify(legacy[key]));
   return{stable:true,clearStaysEmpty:true,v5Unchanged:true};
 });
 for(const [i,key] of [O,L,M].entries())await record('migration-fail-key-'+(i+1),async()=>{
   const inj=await inject("var nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==="+JSON.stringify(key)+")throw Error('migration injected');return nativeSet.call(this,k,v)}");
   await fresh(legacy);assert.equal(await a.eval('!!dataProtection'),true);
   assert.equal(await a.eval("JSON.parse(localStorage.getItem(MIGRATION_KEY)).status"),'pending');
   await removeInject(inj);await reload();assert.equal(await a.eval('!!dataProtection'),false);
   assert.equal(await a.eval('orders.length'),1);assert.equal(await a.eval('purchaseLogs.length'),1);
   const before=await a.eval(rawExpr);await reload();assert.equal(await a.eval(rawExpr),before);return{protected:true,retried:true};
 });
 for(const status of ['pending','complete'])await record('migration-marker-failure-'+status,async()=>{
   const inj=await inject("var nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='dual_table_migration_v6'&&JSON.parse(v).status==="+JSON.stringify(status)+")throw Error('marker injected');return nativeSet.call(this,k,v)}");
   await fresh(legacy);assert.equal(await a.eval('!!dataProtection'),true);
   if(status==='pending')for(const key of [O,L,M])assert.equal(await a.eval('localStorage.getItem('+JSON.stringify(key)+')'),null);
   await removeInject(inj);await reload();assert.equal(await a.eval('!!dataProtection'),false);return{retried:true};
 });
 await record('empty-v6-never-resurrects',async()=>{
   await fresh({...legacy,[O]:[],[L]:[],[M]:{}});assert.equal(await a.eval('orders.length'),0);
   assert.equal(await a.eval('!!dataProtection'),false);await reload();assert.equal(await a.eval('orders.length'),0);
   return{empty:true};
 });
 await record('old-ambiguous-half-migration',async()=>{
   await fresh({...legacy,[O]:sample.orders,[M]:sample.productMeta});assert.equal(await a.eval('!!dataProtection'),true);
   const before=await a.eval(rawExpr);await reload();assert.equal(await a.eval(rawExpr),before);return{unchanged:true};
 });
 await record('migration-conflict-preserves-data',async()=>{
   const inj=await inject("var nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='dual_table_purchase_logs_v6')throw Error('injected');return nativeSet.call(this,k,v)}");
   await fresh(legacy);await removeInject(inj);await a.eval("localStorage.setItem(ORDERS_KEY,'[]')");
   const before=await a.eval(rawExpr);await reload();await protectedUnchanged(before);return{conflictProtected:true};
 });
 // 普通保存失败及回滚本身失败。
 for(const failure of [1,2,3])await record('save-single-failure-'+failure,async()=>{
   await fresh(seedOf(sample));const before=await a.eval(rawExpr),mem=await a.eval('JSON.stringify(captureDataState())');
   await a.eval("var nativeSet=Storage.prototype.setItem;var calls=0;Storage.prototype.setItem=function(k,v){if(++calls==="+failure+")throw Error('injected');return nativeSet.call(this,k,v)}");
   await imp({version:2,orders:[],purchaseLogs:[],productMeta:{}});
   assert.equal(await a.eval(rawExpr),before);assert.equal(await a.eval('JSON.stringify(captureDataState())'),mem);
   assert.equal(await a.eval('!!dataProtection'),false);await a.eval('Storage.prototype.setItem=nativeSet');return{rolledBack:true};
 });
 for(const failure of [1,2,3])await record('save-continuous-failure-'+failure,async()=>{
   await fresh(seedOf(sample));const before=await a.eval(rawExpr),mem=await a.eval('JSON.stringify(captureDataState())');
   await a.eval("var nativeSet=Storage.prototype.setItem;var calls=0;Storage.prototype.setItem=function(k,v){if(++calls>="+failure+")throw Error('injected continuous');return nativeSet.call(this,k,v)}");
   await imp({version:2,orders:[],purchaseLogs:[],productMeta:{}});
   assert.equal(await a.eval('JSON.stringify(captureDataState())'),mem);
   if(failure===1){assert.equal(await a.eval(rawExpr),before);assert.equal(await a.eval('!!dataProtection'),false);}
   else{
     assert.equal(await a.eval('!!dataProtection'),true);assert.equal(await a.eval('JSON.stringify(dataProtection.snapshot)'),mem);
     const partial=await a.eval(rawExpr);await a.eval("add('Blocked','X',1);clearAllData()");assert.equal(await a.eval(rawExpr),partial);
     assert((await a.eval('dataProtection.message')).includes('部分改变'));
   }
   await a.eval('Storage.prototype.setItem=nativeSet');return{memoryPreserved:true,protected:failure>1};
 });
 await record('raw-snapshot-download-and-restore',async()=>{
   await fresh(seedOf(sample));const mem=await a.eval('JSON.stringify(captureDataState())');
   await a.eval("var nativeSet=Storage.prototype.setItem;var calls=0;Storage.prototype.setItem=function(k,v){if(++calls>=2)throw Error('injected');return nativeSet.call(this,k,v)}");
   await imp({version:2,orders:[],purchaseLogs:[],productMeta:{}});await a.eval('Storage.prototype.setItem=nativeSet');
   const values=await downloadRecovery('recovery-download','exportRecoveryRaw();exportRecoverySnapshot()');
   assert.equal(values.length,2);const backup=values.find(x=>x.version===2),raw=values.find(x=>x.recoveryFormat===1);
   assert(backup&&raw);assert.equal(JSON.stringify({orders:backup.orders,purchaseLogs:backup.purchaseLogs,productMeta:backup.productMeta}),mem);
   assert.equal(raw.raw[O],'[]');await imp(backup);assert.equal(await a.eval('!!dataProtection'),false);
   assert.equal(await a.eval('JSON.stringify(captureDataState())'),mem);await reload();assert.equal(await a.eval('!!dataProtection'),false);
   return{downloadsVerified:true,restored:true};
 });
 await record('corrupt-raw-download-and-restore',async()=>{
   await fresh({[O]:'{broken',[L]:[],[M]:{}});
   const [raw]=await downloadRecovery('corrupt-download','exportRecoveryRaw()');assert.equal(raw.raw[O],'{broken');
   await imp(sample);assert.equal(await a.eval('!!dataProtection'),false);assert.equal(await a.eval('orders.length'),1);
   return{rawPreserved:true,restored:true};
 });
 for(const continuous of [false,true])await record('recovery-fails-'+(continuous?'rollback':'single'),async()=>{
   await fresh({[O]:'{broken',[L]:[],[M]:{}});const before=await a.eval(rawExpr),raw=await a.eval('JSON.stringify(dataProtection.raw)');
   await a.eval("var nativeSet=Storage.prototype.setItem;var calls=0;Storage.prototype.setItem=function(k,v){if(++calls"+(continuous?'>=2':'===2')+")throw Error('recovery injected');return nativeSet.call(this,k,v)}");
   await imp(sample);assert.equal(await a.eval('!!dataProtection'),true);
   assert.equal(await a.eval('JSON.stringify(dataProtection.raw)'),raw);
   if(continuous)assert((await a.eval('dataProtection.message')).includes('严重保存错误'));
   else assert.equal(await a.eval(rawExpr),before);
   await a.eval('Storage.prototype.setItem=nativeSet');return{originalRawRetained:true};
 });
 // 多窗口：等待跨键写完；持续损坏则保留上次完整快照。
 await record('storage-event-preserves-snapshot',async()=>{
   await fresh(seedOf(sample));const before=await a.eval('JSON.stringify(captureDataState())');const b=await tab();
   try{
     await b.eval("localStorage.setItem('dual_table_orders_v6','{broken')");await a.send('Page.bringToFront');await waitFor('!!dataProtection',true);
     assert.equal(await a.eval('!!dataProtection'),true);assert.equal(await a.eval('JSON.stringify(dataProtection.snapshot)'),before);
     await b.eval("localStorage.setItem('dual_table_orders_v6','[]')");await sleep(80);
     assert.equal(await a.eval('JSON.stringify(dataProtection.snapshot)'),before);
   }finally{await b.send('Page.close');b.ws.close();}
   return{snapshotRetained:true};
 });
 await record('normal-two-tabs-purchases',async()=>{
   await fresh();await a.eval("add('A','X',20)");const b=await tab();await b.eval(helper);
   try{
     for(let i=0;i<10;i++){await b.eval("buy('X',1,10)");await sleep(30);}await a.send('Page.bringToFront');await waitFor('storageSyncPending',false);
     assert.equal(await a.eval('!!dataProtection'),false,await a.eval('dataProtection&&dataProtection.message'));
     assert.equal(await a.eval('orders[0].purchased'),10);assert.equal(await a.eval('purchaseLogs.length'),10);
   }finally{await b.send('Page.close');b.ws.close();}
   return{synced:true};
 });
 await record('sync-intermediate-state-pauses-writes',async()=>{
   await fresh();await a.eval("add('A','X',3)");const b=await tab();await a.send('Page.bringToFront');
   try{
     await b.eval("localStorage.setItem('dual_table_purchase_logs_v6',JSON.stringify([{id:'p',product:'X',qty:1,unitPrice:10,totalCost:10,location:'',timestamp:1}]))");
     await sleep(80);assert.equal(await a.eval('!!dataProtection'),false);assert.equal(await a.eval('storageSyncPending'),true);
     const before=await a.eval(rawExpr);await a.eval("add('Blocked','Y',2)");assert.equal(await a.eval(rawExpr),before);
     await b.eval("var rows=JSON.parse(localStorage.getItem('dual_table_orders_v6'));rows[0].purchased=1;localStorage.setItem('dual_table_orders_v6',JSON.stringify(rows))");
     await waitFor('storageSyncPending',false);assert.equal(await a.eval('!!dataProtection'),false);assert.equal(await a.eval('orders[0].purchased'),1);
   }finally{await b.send('Page.close');b.ws.close();}
   return{pausedUntilStable:true};
 });
 async function restartBrowser(){
   await a.send('Browser.close');a.ws.close();await sleep(400);
   try{fs.unlinkSync(path.join(scratch,'profile/DevToolsActivePort'));}catch{}
   edge=cp.spawn(process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(scratch,'profile'),'about:blank'],{windowsHide:true,stdio:'ignore'});
   for(let i=0;i<100;i++){try{port=Number(fs.readFileSync(path.join(scratch,'profile/DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{}await sleep(100);}
   a=await tab();
 }
 await record('migration-half-state-process-restart',async()=>{
   await inject("var nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='dual_table_product_meta_v6')throw Error('injected');return nativeSet.call(this,k,v)}");
   await fresh(legacy);assert.equal(await a.eval('!!dataProtection'),true);
   await restartBrowser();assert.equal(await a.eval('!!dataProtection'),false);
   assert.equal(await a.eval('orders[0].purchased'),2);assert.equal(await a.eval('purchaseLogs.length'),1);
   return{retriedAfterRestart:true};
 });
 await record('normal-process-restart',async()=>{
   await fresh(seedOf(sample));const before=await a.eval('JSON.stringify(captureDataState())');
   await restartBrowser();assert.equal(await a.eval('JSON.stringify(captureDataState())'),before);
   assert.equal(await a.eval('!!dataProtection'),false);return{unchanged:true};
 });
 await record('normal-ui-buttons',async()=>{
   await fresh();await a.eval("document.querySelector('.btn-add').click();document.getElementById('input-raw-order').value='张三 面膜 3 35 店A';document.querySelector('#add-step1 .btn-primary').click();document.querySelector('#add-step2 .btn-primary').click();document.querySelector('.btn-stock').click();document.getElementById('input-raw-stock').value='面膜 5 12 店B';document.querySelector('#stock-step1 .btn-warn').click();document.getElementById('btn-confirm-alloc').click();document.querySelector('.paid-check').click()");
   assert.equal(await a.eval('orders[0].isPaid'),true);assert.equal(await a.eval("getCurrentStock('面膜')"),2);return{uiPassed:true};
 });
 await record('protection-mobile-ui',async()=>{
   await fresh({[O]:'{broken',[L]:[],[M]:{}});await a.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
   const ui=await a.eval("({visible:!document.getElementById('data-protection').hidden,inert:document.querySelector('.bottom-bar').inert,width:document.documentElement.scrollWidth})");
   assert.equal(ui.visible,true);assert.equal(ui.inert,true);assert.equal(ui.width,390);
   fs.writeFileSync(path.join(scratch,'protection-mobile.png'),Buffer.from((await a.send('Page.captureScreenshot')).data,'base64'));
   await a.send('Emulation.clearDeviceMetricsOverride');return ui;
 });
 await record('no-page-exceptions',async()=>{
   assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));return{count:0};
 });



 for(const failure of [1,2,3])await record('purchase-save-failure-'+failure,async()=>{
   await fresh(seedOf(sample));const before=await a.eval(rawExpr),mem=await a.eval('JSON.stringify(captureDataState())');
   await a.eval("var nativeSet=Storage.prototype.setItem;var calls=0;Storage.prototype.setItem=function(k,v){if(++calls==="+failure+")throw Error('purchase injected');return nativeSet.call(this,k,v)};buy('X',2,10)");
   assert.equal(await a.eval(rawExpr),before);assert.equal(await a.eval('JSON.stringify(captureDataState())'),mem);
   assert.equal(await a.eval('!!dataProtection'),false);await a.eval('Storage.prototype.setItem=nativeSet');return{rolledBack:true};
 });
 await record('final-no-page-exceptions',async()=>{assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));return{count:0};});

 if(out.some(x=>x.error))process.exitCode=1;
 console.log(JSON.stringify({summary:{total:out.length,failed:out.filter(x=>x.error).length}}));
 await a.send('Browser.close').catch(()=>{});a.ws.close();server.close();await sleep(500);
 if(!out.some(x=>x.error)){fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
 else console.error('测试失败，临时证据保留于：'+scratch);
}
main().catch(e=>{console.error(e);if(edge)edge.kill();if(server)server.close();process.exitCode=1;});
