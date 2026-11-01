// 多行程/迁移/备份安全回归：node tests/multi-trips.cjs
// Node 22+、已安装Edge（可用EDGE_PATH指定）；无第三方依赖，不下载浏览器。
// 独立临时浏览器目录和127.0.0.1来源；成功自动清理，失败保留测试证据。
const fs=require('fs'),http=require('http'),cp=require('child_process'),path=require('path');
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(require('os').tmpdir(),'jizhang-trips-')),out=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));let edge,server;const pageErrors=[];
class CDP{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);this.pending.delete(m.id);if(!p)return;m.error?p.reject(m.error):p.resolve(m.result);}else {this.events.push(m);if(m.method==='Page.javascriptDialogOpening')this.send('Page.handleJavaScriptDialog',{accept:this.dialogAccept??false});if(m.method==='Runtime.exceptionThrown')pageErrors.push(m);}};}
 static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return new CDP(ws);}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP超时: '+method));},15000);this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
async function main(){
 let offline=false;
 server=http.createServer((req,res)=>{if(offline){req.socket.destroy();return;}let name=new URL(req.url,'http://localhost').pathname;if(name==='/')name='/index.html';const file=path.join(root,name);if(!file.startsWith(root)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':'image/png');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 try{fs.unlinkSync(path.join(scratch,'profile/DevToolsActivePort'));}catch{}
 edge=cp.spawn(process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(scratch,'profile'),'about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=Number(fs.readFileSync(path.join(scratch,'profile/DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{}await sleep(100);}if(!port)throw Error('Edge startup failed');
 async function tab(){const t=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();const c=await CDP.connect(t.webSocketDebuggerUrl);await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.nativeConfirm=window.confirm;window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};'});await c.send('Page.navigate',{url:origin});await sleep(180);return c;}
 let a=await tab();
 async function reset(seed={}){await a.eval('localStorage.clear();'+Object.entries(seed).map(([k,v])=>'localStorage.setItem('+JSON.stringify(k)+','+JSON.stringify(typeof v==='string'?v:JSON.stringify(v))+');').join(''));await a.send('Page.reload');await sleep(120);}
 const helper="window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};window.add=(customer,product,qty,price=20,location='店A')=>{openAddModal();showAddStep(2);for(const [id,val] of Object.entries({'customer':customer,'product':product,'qty':qty,'price':price,'location':location}))document.getElementById('input-confirm-'+id).value=val;confirmAddOrder();return orders.at(-1)?.id;};window.buy=(product,qty,price=10,location='店B')=>{pendingAlloc=allocatePurchase(product,qty,price,location,true);confirmAllocation();};window.edit=(id,field,val)=>{openEditFieldModal(id,field);document.getElementById('input-edit-field').value=val;confirmEditField();};window.total=(product,n)=>{openEditPurchasedModal(product,'',0);document.getElementById('input-edit-purchased').value=n;confirmEditPurchased();};window.price=(product,n)=>{openEditProductPriceModal(product);document.getElementById('input-edit-product-price').value=n;confirmEditProductPrice();};window.state=()=>({orders,purchaseLogs,productMeta,spend:document.getElementById('finance-total').dataset.raw,sales:document.getElementById('finance-sales').dataset.raw,toast:document.getElementById('toast').textContent});";
 async function fresh(seed={}){await a.send('Page.bringToFront');await reset(seed);await a.eval(helper);}
 async function record(name,fn){try{out.push({name,result:await fn()});}catch(e){out.push({name,error:String(e)});}console.log(JSON.stringify(out.at(-1)));fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify(out,null,2));}

 const assert=require('assert');
 const rawExpr="JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])))";
 async function waitFor(expression,expected){
   const until=Date.now()+6000;
   while(Date.now()<until){if(await a.eval(expression)===expected)return;await sleep(100);}
   assert.equal(await a.eval(expression),expected,'等待状态超时：'+expression);
 }
 async function reload(){await a.send('Page.reload');await sleep(140);}

 function checkState(r){assert(r.orders.every(o=>Number.isSafeInteger(o.purchased)&&o.purchased>=0&&o.purchased<=o.qty));for(const p of new Set([...r.orders,...r.purchaseLogs].map(x=>x.product))){const allocated=r.orders.filter(o=>o.product===p).reduce((s,o)=>s+o.purchased,0),bought=r.purchaseLogs.filter(l=>l.product===p).reduce((s,l)=>s+l.qty,0),demand=r.orders.filter(o=>o.product===p).reduce((s,o)=>s+o.qty,0);assert.equal(allocated,Math.min(bought,demand));}}
 async function state(){const r=await a.eval('captureDataState()');checkState(r);return r;}
 async function point(selector,index=0){await a.send('Page.bringToFront');await sleep(300);return a.eval(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);}
 async function down(pos,mobile){if(mobile)await a.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...pos,radiusX:1,radiusY:1}]});else await a.send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});}
 async function up(pos,mobile){if(mobile)await a.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await a.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});}
 async function click(selector,index=0,mobile=false){const p=await point(selector,index);await down(p,mobile);await up(p,mobile);await sleep(50);}
 const O='dual_table_orders_v6',L='dual_table_purchase_logs_v6',M='dual_table_product_meta_v6';
 const sample={version:2,orders:[{id:'order1',customer:'甲',product:'苹果',qty:4,purchased:4,sellingPrice:20,isPaid:false,location:'东京',note:'预订'}],purchaseLogs:[{id:'purchase1',product:'苹果',qty:5,unitPrice:10,totalCost:50,location:'大阪',timestamp:1}],productMeta:{'苹果':{lastLocation:'大阪',lastPrice:10,note:'水果'}}};
 const seed={[O]:sample.orders,[L]:sample.purchaseLogs,[M]:sample.productMeta},clone=x=>JSON.parse(JSON.stringify(x));
 const bookRaw=()=>a.eval('localStorage.getItem(BOOK_KEY)');
 async function selectFile(value,raw=false){
   await a.eval('handleImportFile({target:{files:[new File(['+JSON.stringify(raw?value:JSON.stringify(value))+"],'test.json')],value:''}})");
   await sleep(150);
 }
 async function restore(value,{target,name}={}){
   await selectFile(value);
   if(target!==undefined)await a.eval('document.getElementById("import-trip-target").value='+JSON.stringify(target)+';document.getElementById("import-trip-name").value='+JSON.stringify(name||'旧备份')+';updateImportSummary()');
   await a.eval('confirmImportBackup()');
 }
 async function downloads(folder,command){
   const dir=path.join(scratch,folder);fs.mkdirSync(dir,{recursive:true});await a.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});await a.eval(command);
   await sleep(200);return fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>({name:f,data:JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))}));
 }
 await record('migration-v6-summary-raw-preserved-id-stable',async()=>{
   await fresh(seed);const r=await a.eval("({trip:currentTrip(),summary:stateSummary(captureDataState()),marker:tripBook.migration})");
   assert.equal(r.trip.name,'历史账本');assert.equal(r.trip.status,'planned');assert.equal(r.summary.orders,1);assert.equal(r.summary.purchaseLogs,1);assert.equal(r.summary.cost,50);assert.equal(r.summary.receivable,80);assert.equal(r.summary.unpaid,80);assert.deepEqual(r.summary.inventory,[{product:'苹果',bought:5,allocated:4}]);assert.deepEqual(r.marker.summary,r.summary);
   const before=await bookRaw();for(let i=0;i<3;i++){await reload();assert.equal(await bookRaw(),before);}
   for(const [k,v]of Object.entries(seed))assert.equal(await a.eval('localStorage.getItem('+JSON.stringify(k)+')'),JSON.stringify(v));
   return{orderCount:1,purchases:1,stock:1,originalKeysUnchanged:true};
 });
 await record('two-trips-isolate-orders-stock-meta-finance-and-delete',async()=>{
   await fresh();const ids=await a.eval("var A=activeTripId;add('甲','苹果',4,20);buy('苹果',5,10);var B=createTrip('日本行');add('乙','苹果',2,30);({A,B})");
   assert.equal(await a.eval("getCurrentStock('苹果')"),0);assert.equal(await a.eval('orders[0].purchased'),0);assert.equal(await a.eval('getPurchaseCost()'),0);assert.equal(await a.eval("productMeta['苹果'].lastPrice"),0);
   await a.eval("price('苹果',99);switchTrip("+JSON.stringify(ids.A)+")");assert.equal(await a.eval("getLatestPrice('苹果')"),10);assert.equal(await a.eval("getCurrentStock('苹果')"),1);
   await a.eval('deleteOrder(orders[0].id)');assert.equal(await a.eval("getCurrentStock('苹果')"),5);assert.equal(await a.eval('purchaseLogs.length'),1);
   await a.eval('switchTrip('+JSON.stringify(ids.B)+')');assert.equal(await a.eval('orders[0].customer'),'乙');assert.equal(await a.eval("getLatestPrice('苹果')"),99);assert.equal(await a.eval('currentTrip().status'),'planned');
   return{independent:true,deletedOrderRestoresStock:5,preorders:true};
 });
 await record('switch-refresh-close-reopen-remembers-trip',async()=>{
   const id=await a.eval('activeTripId'),before=await a.eval('JSON.stringify(captureDataState())');await reload();assert.equal(await a.eval('activeTripId'),id);assert.equal(await a.eval('JSON.stringify(captureDataState())'),before);
   await a.send('Page.close');a.ws.close();a=await tab();await a.eval(helper);assert.equal(await a.eval('activeTripId'),id);assert.equal(await a.eval('JSON.stringify(captureDataState())'),before);return{persisted:true};
 });
 await record('rename-same-name-distinct-ids-and-archive-reenable',async()=>{
   await fresh(seed);const A=await a.eval('activeTripId'),B=await a.eval("createTrip('历史账本')");assert.notEqual(A,B);await a.eval('updateTrip('+JSON.stringify(A)+",{name:'重命名',status:'active'})");assert.equal(await a.eval('tripBook.trips[0].id'),A);
   await a.eval('updateTrip('+JSON.stringify(B)+",{status:'archived'})");assert.equal(await a.eval('currentTrip().status'),'archived');const before=await bookRaw();await a.eval("add('不应保存','X',1)");assert.equal(await bookRaw(),before);
   await a.eval("openTripManager();document.getElementById('show-archived-trips').checked=false;renderTripManager()");assert.equal(await a.eval("document.querySelectorAll('#trip-manager-list .card').length"),1);
   await a.eval("document.getElementById('show-archived-trips').checked=true;renderTripManager()");assert.equal(await a.eval("document.querySelectorAll('#trip-manager-list .card').length"),2);
   assert.equal((await a.eval('makeAllTripsBackup().trips')).length,2);await a.eval('updateTrip('+JSON.stringify(B)+",{status:'active'});add('可以保存','X',1)");assert.equal(await a.eval('orders.length'),1);return{sameNameAllowed:true,archivedReadonly:true,reenabled:true};
 });
 await record('delete-two-confirmations-and-only-target-trip',async()=>{
   const ids=await a.eval('tripBook.trips.map(t=>t.id)'),raw=await bookRaw();await a.eval("window.confirm=()=>false;deleteTrip(activeTripId)");assert.equal(await bookRaw(),raw);
   await a.eval("window.n=0;window.confirm=()=>++n===1;deleteTrip(activeTripId)");assert.equal(await a.eval('n'),2);assert.equal(await bookRaw(),raw);
   await a.eval('window.confirm=()=>true;deleteTrip('+JSON.stringify(ids[1])+')');assert.equal(await a.eval('tripBook.trips.length'),1);assert.equal(await a.eval('orders[0].customer'),'甲');return{cancelSafe:true,doubleConfirmation:true,otherTripPreserved:true};
 });
 await record('legacy-file-no-automatic-import-existing-target',async()=>{
   await fresh();const A=await a.eval('activeTripId'),B=await a.eval("createTrip('B')"),before=await bookRaw();await selectFile(sample);assert.equal(await bookRaw(),before);
   assert.equal(await a.eval("document.getElementById('import-trip-target').value"),'');assert.equal(await a.eval("document.getElementById('btn-confirm-import').disabled"),true);
   await a.eval('confirmImportBackup()');assert.equal(await bookRaw(),before);
   await a.eval('document.getElementById("import-trip-target").value='+JSON.stringify(A)+';updateImportSummary();confirmImportBackup()');assert.equal(await a.eval('activeTripId'),A);assert.equal(await a.eval('orders.length'),1);await a.eval('switchTrip('+JSON.stringify(B)+')');assert.equal(await a.eval('orders.length'),0);return{explicitTargetRequired:true,otherTripUnchanged:true};
 });
 await record('legacy-new-trip-repeat-uses-stable-id',async()=>{
   await restore(sample,{target:'__new__',name:'旧备份新行程'});const id=await a.eval('activeTripId'),n=await a.eval('tripBook.trips.length');assert(id.startsWith('legacy-'));assert.equal(await a.eval('currentTrip().name'),'旧备份新行程');
   await restore(sample,{target:'__new__',name:'旧备份新行程'});assert.equal(await a.eval('activeTripId'),id);assert.equal(await a.eval('tripBook.trips.length'),n);assert.equal(await a.eval('orders.length'),1);return{repeatDoesNotDuplicate:true};
 });
 let singleBackup;
 await record('single-download-id-match-replace-same-name-not-matched',async()=>{
   const oldId=await a.eval('activeTripId');[singleBackup]= (await downloads('single',"doExportFile('trip')")).map(x=>x.data);assert.equal(singleBackup.version,3);assert.equal(singleBackup.type,'trip');assert.equal(singleBackup.trip.id,oldId);
   const other=await a.eval('createTrip('+JSON.stringify(singleBackup.trip.name)+')');await a.eval("add('同名账本客户','Y',1)");await selectFile(singleBackup);assert((await a.eval("document.getElementById('import-summary').textContent")).includes('按ID匹配'));
   await a.eval('confirmImportBackup()');assert.equal(await a.eval('activeTripId'),oldId);assert.equal(await a.eval('orders[0].customer'),'甲');const n=await a.eval('tripBook.trips.length');await restore(singleBackup);assert.equal(await a.eval('tripBook.trips.length'),n);
   await a.eval('switchTrip('+JSON.stringify(other)+')');assert.equal(await a.eval('orders[0].customer'),'同名账本客户');return{identityMatched:true,sameNameUntouched:true,repeatSafe:true};
 });
 await record('single-new-id-retained-roundtrip',async()=>{
   await fresh();await restore(singleBackup);assert.equal(await a.eval('activeTripId'),singleBackup.trip.id);assert.deepEqual(await a.eval('makeTripBackup().trip'),singleBackup.trip);return{retainedIdAndData:true};
 });
 let allBackup;
 await record('all-download-preview-add-replace-delete-safety-and-roundtrip',async()=>{
   await a.eval("var archive=createTrip('已归档');updateTrip(archive,{status:'archived'})");const files=await downloads('all',"doExportFile('all-trips')");allBackup=files[0].data;assert(files[0].name.includes('全部行程'));assert.equal(allBackup.type,'all-trips');assert(allBackup.trips.some(t=>t.status==='archived'));
   await a.eval("var extra=createTrip('应被删除');add('本地客户','Z',2)");const before=await a.eval('tripBook.trips');await selectFile(allBackup);const summary=await a.eval("document.getElementById('import-summary').textContent");assert(summary.includes('删除：应被删除'));assert(summary.includes('替换：'));
   await a.eval('confirmImportBackup()');assert.deepEqual(await a.eval('tripBook.trips'),allBackup.trips);assert.equal(await a.eval('activeTripId'),allBackup.activeTripId);
   const safety=await a.eval('JSON.parse(localStorage.getItem(RESTORE_SAFETY_KEY)).backup');assert.deepEqual(safety.trips,before);
   const [saved]=await downloads('safety','exportRestoreSafety()');assert.deepEqual(saved.data.trips,before);
   const n=await a.eval('tripBook.trips.length');await restore(allBackup);assert.equal(await a.eval('tripBook.trips.length'),n);return{allRestored:true,safetyDownload:true};
 });
 const invalid=[['unknown-version',b=>b.version=999],['unknown-type',b=>b.type='merge'],['duplicate-trip-id',b=>b.trips.push(clone(b.trips[0]))],['bad-trip-id',b=>b.trips[0].id='<script>'],['empty-name',b=>b.trips[0].name=''],['unknown-status',b=>b.trips[0].status='constructor'],['bad-date',b=>b.trips[0].createdAt='yesterday'],['bad-selection',b=>b.activeTripId='not-present'],['bad-number',b=>{const t=b.trips.find(t=>t.orders.length);t.orders[0].qty=-1;}],['bad-meta',b=>b.trips[0].productMeta=null]];
 for(const[name,change]of invalid)await record('invalid-'+name+'-preserves-all-data',async()=>{await fresh();const raw=await a.eval(rawExpr),b=clone(allBackup);change(b);await selectFile(b);assert.equal(await a.eval(rawExpr),raw);assert.equal(await a.eval('pendingImport'),null);assert((await a.eval('window.lastAlert')).includes('导入已拒绝'));return{unchanged:true};});
 await record('invalid-json-no-changes',async()=>{const raw=await a.eval(rawExpr);await selectFile('{broken',true);assert.equal(await a.eval(rawExpr),raw);return{unchanged:true};});
 await record('cancel-import-does-not-write-safety-or-book',async()=>{await fresh();const raw=await a.eval(rawExpr);await selectFile(singleBackup);await a.eval('window.confirm=()=>false;confirmImportBackup()');assert.equal(await a.eval(rawExpr),raw);return{unchanged:true};});
 for(const key of ['BOOK_KEY','RESTORE_SAFETY_KEY'])await record('import-quota-'+key,async()=>{
   await fresh(seed);const raw=await bookRaw(),mem=await a.eval('JSON.stringify(captureDataState())');await selectFile(allBackup);
   await a.eval('window.nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='+key+")throw new DOMException('full','QuotaExceededError');return nativeSet.call(this,k,v)};confirmImportBackup();Storage.prototype.setItem=nativeSet");
   assert.equal(await bookRaw(),raw);assert.equal(await a.eval('JSON.stringify(captureDataState())'),mem);assert((await a.eval("document.getElementById('toast').textContent")).includes('保存失败'));await reload();assert.equal(await bookRaw(),raw);return{bookUnchanged:true};
 });
 await record('normal-save-quota-keeps-all-trips-and-retry',async()=>{
   await fresh(seed);await a.eval("createTrip('B')");const raw=await bookRaw();await a.eval("window.nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===BOOK_KEY)throw Error('full');return nativeSet.call(this,k,v)};add('甲','X',1)");assert.equal(await bookRaw(),raw);assert.equal(await a.eval('orders.length'),0);
   await a.eval('Storage.prototype.setItem=nativeSet;confirmAddOrder()');assert.equal(await a.eval('orders.length'),1);return{retrySavedOnce:true};
 });
 await record('trip-migration-write-failure-safe-retry',async()=>{
   const inj=(await a.send('Page.addScriptToEvaluateOnNewDocument',{source:"window.nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='dual_table_trip_book_v1')throw Error('migration full');return nativeSet.call(this,k,v)}"})).identifier;
   await fresh(seed);assert.equal(await a.eval('!!dataProtection'),true);assert.equal(await a.eval('localStorage.getItem(BOOK_KEY)'),null);
   for(const[k,v]of Object.entries(seed))assert.equal(await a.eval('localStorage.getItem('+JSON.stringify(k)+')'),JSON.stringify(v));
   await a.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:inj});await reload();assert.equal(await a.eval('!!dataProtection'),false);assert.equal(await a.eval('orders.length'),1);assert.equal(await a.eval('tripBook.trips.length'),1);return{retrySafe:true};
 });
 await record('switch-invalidates-every-edit-and-purchase-draft',async()=>{
   await fresh(seed);const A=await a.eval('activeTripId'),B=await a.eval("createTrip('B')");await a.eval('switchTrip('+JSON.stringify(A)+')');
   for(const open of ["openEditFieldModal(orders[0].id,'qty')","openPriceModal(orders[0].id)","openNoteModal(orders[0].id)","openProductNoteModal('苹果')","openEditPurchasedModal('苹果','',0)","openEditProductPriceModal('苹果')","openAddModal()","pendingAlloc=allocatePurchase('苹果',5,10,'',true)"]){
     await a.eval(open+';switchTrip('+JSON.stringify(B)+')');const raw=await bookRaw();await a.eval('confirmEditField();confirmPriceEdit();confirmNote();confirmProductNote();confirmEditPurchased();confirmEditProductPrice();confirmAddOrder();confirmAllocation()');assert.equal(await bookRaw(),raw);assert.equal(await a.eval("document.querySelectorAll('.modal-overlay.show').length"),0);await a.eval('switchTrip('+JSON.stringify(A)+')');
   }return{allDraftsInvalidated:true};
 });
 await record('async-file-read-and-ready-import-cancelled-on-switch',async()=>{
   const A=await a.eval('activeTripId'),B=await a.eval("createTrip('B')");await a.eval('switchTrip('+JSON.stringify(A)+');window.nativeRead=FileReader.prototype.readAsText;FileReader.prototype.readAsText=function(...args){const r=this;setTimeout(()=>nativeRead.apply(r,args),200)}');
   await a.eval('handleImportFile({target:{files:[new File(['+JSON.stringify(JSON.stringify(singleBackup))+"],'test.json')],value:''}});switchTrip("+JSON.stringify(B)+')');const raw=await bookRaw();await sleep(350);assert.equal(await bookRaw(),raw);assert.equal(await a.eval('pendingImport'),null);await a.eval('FileReader.prototype.readAsText=nativeRead');
   await selectFile(singleBackup);await a.eval('switchTrip('+JSON.stringify(A)+');confirmImportBackup()');assert.equal(await bookRaw(),raw);return{staleReaderAndConfirmationBlocked:true};
 });
 await record('cross-window-sync-invalidates-modal-and-saves-current-trip-only',async()=>{
   await fresh(seed);const id=await a.eval('activeTripId');await a.eval("openPriceModal(orders[0].id);document.getElementById('input-edit-price').value=999");const b=await tab();
   try{await b.eval(helper);await b.eval("buy('苹果',1)");await waitFor('purchaseLogs.length',2);assert.equal(await a.eval('editingOrderId'),null);const raw=await bookRaw();await a.eval('confirmPriceEdit()');assert.equal(await bookRaw(),raw);await b.eval("createTrip('另一个行程');add('乙','Y',1)");await waitFor('tripBook.trips.length',2);assert.equal(await a.eval('activeTripId'),id);assert.equal(await a.eval('orders[0].customer'),'甲');}finally{await b.send('Page.close');b.ws.close();}return{synced:true,staleEditClosed:true};
 });
 await record('unsynced-baseline-conflict-rejects-save',async()=>{
   await fresh(seed);const old=await a.eval('captureDataState()');await a.eval("var other=JSON.parse(localStorage.getItem(BOOK_KEY));other.revision++;other.commitId='remote';other.trips[0].orders[0].sellingPrice=55;localStorage.setItem(BOOK_KEY,JSON.stringify(other))");const raw=await bookRaw();await a.eval('togglePaid(orders[0].id)');assert.equal(await bookRaw(),raw);await sleep(100);assert.equal(await a.eval('orders[0].sellingPrice'),55);assert.equal(await a.eval('orders[0].isPaid'),old.orders[0].isPaid);return{rejectedBeforeOverwrite:true};
 });
 await record('simultaneous-revision-conflict-preserves-window-snapshot',async()=>{
   await fresh(seed);await a.eval('togglePaid(orders[0].id)');const before=await a.eval('tripBook.trips');await a.eval("var collision=cloneData(tripBook);collision.commitId='other-simultaneous-commit';collision.trips[0].orders[0].sellingPrice=123;localStorage.setItem(BOOK_KEY,JSON.stringify(collision));window.dispatchEvent(new StorageEvent('storage',{key:BOOK_KEY,newValue:JSON.stringify(collision)}))");assert.equal(await a.eval('!!dataProtection'),true);assert.deepEqual(await a.eval('dataProtection.bookSnapshot.trips'),before);assert((await a.eval('dataProtection.message')).includes('同时保存冲突'));return{explicitConflictAndSnapshot:true};
 });
 await record('startup-race-keeps-original-read-baseline',async()=>{
   await fresh(seed);
   const inj=(await a.send('Page.addScriptToEvaluateOnNewDocument',{source:"window.nativeGet=Storage.prototype.getItem;window.startupChanged=false;Storage.prototype.getItem=function(k){if(k==='dual_table_active_trip_v1'&&!startupChanged){startupChanged=true;const b=JSON.parse(nativeGet.call(this,'dual_table_trip_book_v1'));b.revision++;b.commitId='startup-remote';b.trips[0].orders[0].sellingPrice=55;this.setItem('dual_table_trip_book_v1',JSON.stringify(b));}return nativeGet.call(this,k)}"})).identifier;
   await reload();await a.eval(helper);await a.eval('togglePaid(orders[0].id)');await sleep(100);assert.equal(await a.eval('orders[0].sellingPrice'),55);assert.equal(await a.eval('orders[0].isPaid'),false);assert.equal(await a.eval('JSON.parse(localStorage.getItem(BOOK_KEY)).trips[0].orders[0].sellingPrice'),55);
   await a.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:inj});return{startupChangeNotOverwritten:true};
 });
 await record('concurrent-first-migration-does-not-overwrite-created-book',async()=>{
   const inj=(await a.send('Page.addScriptToEvaluateOnNewDocument',{source:"window.nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){const r=nativeSet.call(this,k,v);if(k==='dual_table_migration_v6'&&JSON.parse(v).status==='complete')nativeSet.call(this,'dual_table_trip_book_v1',JSON.stringify({schemaVersion:1,revision:4,commitId:'other-initializer',migration:{status:'complete'},trips:[emptyTrip('其他窗口已建立','external-init')]}));return r;}"})).identifier;
   await fresh(seed);assert.equal(await a.eval('!!dataProtection'),true);assert.equal(await a.eval('JSON.parse(localStorage.getItem(BOOK_KEY)).trips[0].id'),'external-init');
   await a.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:inj});await reload();assert.equal(await a.eval('!!dataProtection'),false);assert.equal(await a.eval('activeTripId'),'external-init');return{existingBookNeverOverwritten:true};
 });
 for(const key of ['dual_table_trip_book_v1','dual_table_active_trip_v1'])await record('startup-read-denied-'+key,async()=>{
   await fresh(seed);const before=await bookRaw();const inj=(await a.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.nativeGet=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='+JSON.stringify(key)+")throw Error('read denied');return nativeGet.call(this,k)}"})).identifier;
   await reload();assert.equal(await a.eval('!!dataProtection'),true);await a.eval('Storage.prototype.getItem=nativeGet');assert.equal(await bookRaw(),before);await a.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:inj});return{protectedNoOverwrite:true};
 });
 await record('older-concurrent-revision-and-recovery-raw-safety',async()=>{
   await fresh(seed);await a.eval('togglePaid(orders[0].id);togglePaid(orders[0].id)');const before=await a.eval('tripBook.trips');
   await a.eval("var older=cloneData(tripBook);older.revision--;older.commitId='late-stale-writer';older.trips[0].orders[0].sellingPrice=456;localStorage.setItem(BOOK_KEY,JSON.stringify(older));window.dispatchEvent(new StorageEvent('storage',{key:BOOK_KEY,newValue:JSON.stringify(older)}))");
   assert.equal(await a.eval('!!dataProtection'),true);assert.deepEqual(await a.eval('dataProtection.bookSnapshot.trips'),before);
   const raw=await a.eval('dataProtection.raw');assert(raw.conflictingStorageEvent);await restore(allBackup);assert.equal(await a.eval('!!dataProtection'),false);assert.deepEqual(await a.eval('JSON.parse(localStorage.getItem(RESTORE_SAFETY_KEY)).recoveryRaw'),raw);return{lateWriterDetectedAndRawRetained:true};
 });
 await record('corrupt-book-protection-and-full-backup-recovery',async()=>{
   await fresh({'dual_table_trip_book_v1':'{broken',...seed});assert.equal(await a.eval('!!dataProtection'),true);const raw=await bookRaw();await a.eval("add('blocked','X',2)");assert.equal(await bookRaw(),raw);await restore(allBackup);assert.equal(await a.eval('!!dataProtection'),false);assert.deepEqual(await a.eval('tripBook.trips'),allBackup.trips);await reload();assert.equal(await a.eval('!!dataProtection'),false);return{protectedAndRecovered:true};
 });
 await record('desktop-mobile-controls-fit-and-real-click-create',async()=>{
   await fresh();for(const width of[390,1100]){await a.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});await a.eval("window.prompt=()=> '日本行 · 2026年11月'");await click('.trip-bar button',1);assert.equal(await a.eval('currentTrip().name'),'日本行 · 2026年11月');assert.equal(await a.eval('document.documentElement.scrollWidth'),width);assert(await a.eval("[...document.querySelectorAll('.trip-bar button,.trip-bar select')].every(e=>{const r=e.getBoundingClientRect();return r.width>30&&r.right<=innerWidth})"));await click('.trip-bar button');assert.equal(await a.eval("document.getElementById('modal-trips').classList.contains('show')"),true);fs.writeFileSync(path.join(scratch,'trips-'+width+'.png'),Buffer.from((await a.send('Page.captureScreenshot')).data,'base64'));await a.eval('closeTripManager()');}await a.send('Emulation.clearDeviceMetricsOverride');return{desktopAndMobile:true};
 });
 await record('offline-start-refresh-keeps-all-trips-and-selection',async()=>{
   await a.eval('navigator.serviceWorker.ready');await reload();assert(await a.eval('!!navigator.serviceWorker.controller'));const before=await bookRaw(),id=await a.eval('activeTripId');offline=true;await reload();assert.equal(await bookRaw(),before);assert.equal(await a.eval('activeTripId'),id);assert.equal(await a.eval('typeof createTrip'),'function');await a.eval(helper);await a.eval("add('离线客户','X',2)");await reload();assert.equal(await a.eval('orders.length'),1);offline=false;return{offlineJsCached:true,offlineSaveRefresh:true};
 });
 // 使用仓库中实际保存的文件，通过浏览器文件输入控件触发 onchange/FileReader。
 const fixtures=Object.fromEntries([5,6].map(v=>[v,JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/legacy-v'+v+'-backup.json'),'utf8'))]));
 async function chooseFixture(v){
   await a.eval('openImportModal()');const {root:doc}=await a.send('DOM.getDocument');
   const {nodeId}=await a.send('DOM.querySelector',{nodeId:doc.nodeId,selector:'#input-import-file'});
   await a.send('DOM.setFileInputFiles',{nodeId,files:[path.join(root,'tests/fixtures/legacy-v'+v+'-backup.json')]});
   await waitFor("pendingImport?.kind",'legacy');
 }
 async function fixtureTarget(id,name='旧版测试行程'){
   await a.eval('document.getElementById("import-trip-target").value='+JSON.stringify(id)+';document.getElementById("import-trip-name").value='+JSON.stringify(name)+';document.getElementById("import-trip-target").dispatchEvent(new Event("change",{bubbles:true}))');
 }
 async function checkFixture(v){
   const expected=clone(fixtures[v]);expected.orders=expected.orders.filter(o=>o.customer!=='【系统库存】').map(o=>({isPaid:false,note:'',...o}));
   expected.productMeta=Object.fromEntries(Object.entries(expected.productMeta).map(([p,m])=>[p,{...m,note:m.note||''}]));
   const actual=await state();assert.deepEqual(actual,{orders:expected.orders,purchaseLogs:expected.purchaseLogs,productMeta:expected.productMeta});
   const summary=await a.eval("({clients:[...new Set(orders.map(o=>o.customer))].sort(),orders:orders.length,logs:purchaseLogs.length,qty:orders.reduce((s,o)=>s+o.qty,0),allocated:orders.reduce((s,o)=>s+o.purchased,0),gap:orders.reduce((s,o)=>s+o.qty-o.purchased,0),stock:getCurrentStock('模拟面膜'),otherStocks:['模拟饼干','模拟维生素','模拟茶包'].map(getCurrentStock),cost:getPurchaseCost(),receivable:orders.reduce((s,o)=>s+o.qty*o.sellingPrice,0),unpaid:orders.reduce((s,o)=>s+(o.isPaid?0:o.qty*o.sellingPrice),0),finance:Number(document.getElementById('finance-sales').dataset.raw),cards:document.querySelectorAll('#customer-table-container .card').length,rows:document.querySelectorAll('.tap-row').length})");
   assert.deepEqual(summary,{clients:['测试客户A','测试客户B','测试客户C'],orders:5,logs:3,qty:14,allocated:8,gap:6,stock:2,otherStocks:[0,0,0],cost:210,receivable:550,unpaid:v===6?190:550,finance:345,cards:3,rows:5});
   assert((await a.eval("document.getElementById('trip-overview').textContent")).includes('待采购 6 件'));
   return summary;
 }
 await record('fixture-v6-authentic-format-and-v5-historical-format',async()=>{
   for(const v of[5,6]){
     assert.deepEqual(Object.keys(fixtures[v]),['version','exportedAt','orders','purchaseLogs','productMeta']);assert.equal(fixtures[v].version,v===6?2:1);
     assert.equal(fixtures[v].orders.filter(o=>o.customer!=='【系统库存】').length,5);assert.equal(fixtures[v].purchaseLogs.length,3);assert.equal(Object.keys(fixtures[v].productMeta).length,4);
     assert(!Object.hasOwn(fixtures[v],'trip'));assert(!Object.hasOwn(fixtures[v],'activeTripId'));
   }return{v6Version:2,v5Version:1,noTripFields:true};
 });
 await record('fixture-file-requires-target-before-any-change',async()=>{
   await fresh(seed);const raw=await a.eval(rawExpr);await chooseFixture(6);
   assert.equal(await a.eval('pendingImport.kind'),'legacy');assert.equal(await a.eval("document.getElementById('legacy-import-target').hidden"),false);
   assert.equal(await a.eval("document.getElementById('import-trip-target').value"),'');assert.equal(await a.eval("document.getElementById('btn-confirm-import').disabled"),true);
   await a.eval('confirmImportBackup()');assert.equal(await a.eval(rawExpr),raw);return{actualFileRead:true,explicitSelectionRequired:true};
 });
 for(const v of[6,5])await record('fixture-v'+v+'-existing-target-confirm-cancel-and-isolation',async()=>{
   await fresh(seed);const target=await a.eval('activeTripId');await a.eval("createTrip('应保持不变');add('隔离验证客户','模拟面膜',1,5);buy('模拟面膜',2,1);price('模拟面膜',88)");
   const other=await a.eval('cloneData(currentTrip())'),before=await a.eval('tripBook.trips'),raw=await a.eval(rawExpr);
   await chooseFixture(v);await fixtureTarget(target);assert.equal(await a.eval(rawExpr),raw);
   await a.eval('window.confirm=msg=>{window.fixtureWarning=msg;return false}');await click('#btn-confirm-import');assert.equal(await a.eval(rawExpr),raw);
   const warning=await a.eval('fixtureWarning');assert(warning.includes('历史账本'));assert(warning.includes('5 笔订单'));assert(warning.includes('3 笔采购'));assert(warning.includes('替换'));
   if(v===5){assert(warning.includes('核对1条系统库存行'));assert(warning.includes('未收款'));}
   await a.eval('window.confirm=()=>true');await click('#btn-confirm-import');assert.equal(await a.eval('activeTripId'),target);const summary=await checkFixture(v);
   assert.deepEqual(await a.eval('tripBook.trips.find(t=>t.id==='+JSON.stringify(other.id)+')'),other);
   assert.deepEqual(await a.eval('JSON.parse(localStorage.getItem(RESTORE_SAFETY_KEY)).backup.trips'),before);
   await reload();await checkFixture(v);return{...summary,cancelPreservesAll:true,otherTripUnchanged:true,refreshPreserves:true};
 });
 for(const v of[6,5])await record('fixture-v'+v+'-new-target-repeat-no-duplicates',async()=>{
   await fresh(seed);const before=await a.eval('tripBook.trips');await chooseFixture(v);await fixtureTarget('__new__','旧版v'+v+'导入测试');
   await a.eval('window.confirm=()=>false');await click('#btn-confirm-import');assert.deepEqual(await a.eval('tripBook.trips'),before);
   await a.eval('window.confirm=()=>true');await click('#btn-confirm-import');const id=await a.eval('activeTripId');assert.equal(await a.eval('currentTrip().name'),'旧版v'+v+'导入测试');await checkFixture(v);
   assert.deepEqual(await a.eval('tripBook.trips.filter(t=>t.id!=='+JSON.stringify(id)+')'),before);
   await chooseFixture(v);await fixtureTarget('__new__','旧版v'+v+'导入测试');await click('#btn-confirm-import');assert.equal(await a.eval('activeTripId'),id);assert.equal(await a.eval('tripBook.trips.length'),before.length+1);await checkFixture(v);
   return{createdAfterConfirmationOnly:true,otherTripUnchanged:true,repeatedFileNotDuplicated:true};
 });
 const badV5=[
   ['stock-short',b=>{b.orders.at(-1).qty=1;b.orders.at(-1).purchased=1;}],
   ['stock-excess',b=>{b.orders.at(-1).qty=3;b.orders.at(-1).purchased=3;}],
   ['stock-price',b=>b.orders.at(-1).sellingPrice=10],
   ['stock-paid',b=>b.orders.at(-1).isPaid=true],
   ['stock-note',b=>b.orders.at(-1).note='必须保留的未知备注'],
   ['stock-unknown-field',b=>b.orders.at(-1).unknown='不能丢失的字段'],
   ['duplicate-id',b=>b.orders.at(-1).id=b.orders[0].id],
   ['stock-with-demand-gap',b=>b.orders[0].qty=6],
   ['invalid-number',b=>b.orders[0].qty='3']
 ];
 for(const[name,change]of badV5)await record('v5-reject-'+name+'-before-any-write',async()=>{
   await fresh(seed);const raw=await a.eval(rawExpr),value=clone(fixtures[5]);change(value);await selectFile(value);
   assert.equal(await a.eval('pendingImport'),null);assert.equal(await a.eval(rawExpr),raw);assert((await a.eval('window.lastAlert')).includes('导入已拒绝'));return{originalBookUnchanged:true};
 });
 await record('no-page-exceptions',async()=>{assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));return{count:0};});
 const failed=out.filter(x=>x.error).length;console.log(JSON.stringify({summary:{total:out.length,failed}}));if(failed)process.exitCode=1;
 await a.send('Browser.close').catch(()=>{});a.ws.close();server.close();await sleep(500);
 if(!failed)fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});else console.error('测试证据：'+scratch);
}
main().catch(e=>{console.error(e);if(edge)edge.kill();if(server)server.close();process.exitCode=1;});
