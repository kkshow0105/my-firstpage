// 库存与真实交互回归：node tests/inventory-interactions.cjs
// Node 22+、已安装Edge（可用EDGE_PATH指定）；无第三方依赖，不下载浏览器。
// 独立临时浏览器目录和127.0.0.1来源；成功自动清理，失败保留测试证据。
const fs=require('fs'),http=require('http'),cp=require('child_process'),path=require('path');
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(require('os').tmpdir(),'jizhang-inventory-')),out=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));let edge,server;const pageErrors=[];
class CDP{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);this.pending.delete(m.id);if(!p)return;m.error?p.reject(m.error):p.resolve(m.result);}else {this.events.push(m);if(m.method==='Page.javascriptDialogOpening')this.send('Page.handleJavaScriptDialog',{accept:this.dialogAccept??false});if(m.method==='Runtime.exceptionThrown')pageErrors.push(m);}};}
 static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return new CDP(ws);}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP超时: '+method));},15000);this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
async function main(){
 server=http.createServer((req,res)=>{let name=new URL(req.url,'http://localhost').pathname;if(name==='/')name='/index.html';const file=path.join(root,name);if(!file.startsWith(root)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':'image/png');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 try{fs.unlinkSync(path.join(scratch,'profile/DevToolsActivePort'));}catch{}
 edge=cp.spawn(process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(scratch,'profile'),'about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=Number(fs.readFileSync(path.join(scratch,'profile/DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{}await sleep(100);}if(!port)throw Error('Edge startup failed');
 async function tab(){const t=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();const c=await CDP.connect(t.webSocketDebuggerUrl);await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.nativeConfirm=window.confirm;window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};'});await c.send('Page.navigate',{url:origin});await sleep(180);return c;}
 let a=await tab();
 async function reset(seed={}){await a.eval('localStorage.clear();'+Object.entries(seed).map(([k,v])=>'localStorage.setItem('+JSON.stringify(k)+','+JSON.stringify(typeof v==='string'?v:JSON.stringify(v))+');').join(''));await a.send('Page.reload');await sleep(120);}
 const helper="window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};window.add=(customer,product,qty,price=20,location='店A')=>{for(const [id,val] of Object.entries({'customer':customer,'product':product,'qty':qty,'price':price,'location':location}))document.getElementById('input-confirm-'+id).value=val;confirmAddOrder();return orders.at(-1)?.id;};window.buy=(product,qty,price=10,location='店B')=>{pendingAlloc=allocatePurchase(product,qty,price,location,true);confirmAllocation();};window.edit=(id,field,val)=>{openEditFieldModal(id,field);document.getElementById('input-edit-field').value=val;confirmEditField();};window.total=(product,n)=>{openEditPurchasedModal(product,'',0);document.getElementById('input-edit-purchased').value=n;confirmEditPurchased();};window.price=(product,n)=>{openEditProductPriceModal(product);document.getElementById('input-edit-product-price').value=n;confirmEditProductPrice();};window.state=()=>({orders,purchaseLogs,productMeta,spend:document.getElementById('finance-total').dataset.raw,sales:document.getElementById('finance-sales').dataset.raw,toast:document.getElementById('toast').textContent});";
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
 for(const name of ['X',' X '])await record('01-unchanged-'+JSON.stringify(name),async()=>{
 await fresh();await a.eval("add('A','X',5);add('B','X',5);buy('X',5)");const raw=await a.eval(rawExpr),before=await state();
 await click('.tap-row .cell-clickable');await a.eval('document.getElementById("input-edit-field").value='+JSON.stringify(name));await click('#modal-edit-field .btn-primary');
 assert.equal(await a.eval(rawExpr),raw);assert.deepEqual(await state(),before);return{allocated:before.orders.map(o=>o.purchased),unchanged:true};
 });
 for(const kind of ['too-many','negative','over-total','unallocated-stock'])await record('01-save-constraint-'+kind,async()=>{
 await fresh();await a.eval("add('A','X',5);add('B','X',5);buy('X',5)");const before=await state(),raw=await a.eval(rawExpr);
 const mutation={'too-many':'orders[0].purchased=6','negative':'orders[0].purchased=-1','over-total':'orders[1].purchased=5','unallocated-stock':'orders[0].purchased=4'}[kind];
 assert.equal(await a.eval('var prev=captureDataState();'+mutation+';persistDataState(prev,[ORDERS_KEY,LOGS_KEY,META_KEY])'),false);assert.equal(await a.eval(rawExpr),raw);assert.deepEqual(await state(),before);return{rejectedBeforeWrite:true};
 });
 for(const scenario of ['shrink','add','purchase','rename','delete'])await record('02-other-window-'+scenario,async()=>{
 await fresh();await a.eval("add('A','X',"+(scenario==='shrink'?10:2)+");document.getElementById('modal-stock').classList.add('show');document.getElementById('input-raw-stock').value='X "+(scenario==='shrink'?10:5)+" 10';previewAllocation()");
 const b=await tab();await b.send('Page.bringToFront');await b.eval(helper);await b.eval({shrink:"edit(orders[0].id,'qty',2)",add:"add('B','X',3)",purchase:"buy('X',1)",rename:"edit(orders[0].id,'product','Y')",delete:"deleteOrder(orders[0].id)"}[scenario]);
 const expected=await b.eval('JSON.stringify(validateDataState(captureDataState()))');await a.send('Page.bringToFront');await waitFor('JSON.stringify(captureDataState())',expected);const raw=await a.eval(rawExpr);
 await click('#btn-confirm-alloc');assert.equal(await a.eval(rawExpr),raw);assert.equal(await a.eval('pendingAlloc'),null);assert((await a.eval('document.getElementById("toast").textContent')).includes('重新确认'));
 await a.eval('previewAllocation()');await click('#btn-confirm-alloc');const r=await state();assert.equal(r.purchaseLogs.reduce((s,l)=>s+l.qty,0),(scenario==='shrink'?10:5)+(scenario==='purchase'?1:0));await b.send('Page.close');b.ws.close();return{staleRejected:true,repreviewSaved:true};
 });
 await record('02-local-change',async()=>{await fresh();await a.eval("add('A','X',2);document.getElementById('modal-stock').classList.add('show');document.getElementById('input-raw-stock').value='X 5 10';previewAllocation();add('B','X',3)");const raw=await a.eval(rawExpr);await a.eval('confirmAllocation()');assert.equal(await a.eval(rawExpr),raw);assert.equal(await a.eval('pendingAlloc'),null);return{rejected:true};});
 await record('02-unsynced-storage-change',async()=>{await fresh();await a.eval("add('A','X',2);pendingAlloc=allocatePurchase('X',5,10,'',true);var changed=JSON.parse(localStorage.getItem(ORDERS_KEY));changed[0].qty=3;localStorage.setItem(ORDERS_KEY,JSON.stringify(changed))");const raw=await a.eval(rawExpr);await a.eval('confirmAllocation()');assert.equal(await a.eval(rawExpr),raw);await sleep(350);await state();return{baselineBlocked:true};});
 await record('03-default-price-preserves-batches-refresh',async()=>{
 await fresh();await a.eval("buy('X',2,10);buy('X',3,20)");const logs=await a.eval('JSON.stringify(purchaseLogs)');await a.eval("openEditProductPriceModal('X');document.getElementById('input-edit-product-price').value=30");await click('#modal-edit-product-price .btn-primary');
 assert.equal(await a.eval('JSON.stringify(purchaseLogs)'),logs);assert.equal(await a.eval('Number(state().spend)'),80);assert.equal(await a.eval("getLatestPrice('X')"),30);await reload();await a.eval(helper);assert.equal(await a.eval('JSON.stringify(purchaseLogs)'),logs);assert.equal(await a.eval("getLatestPrice('X')"),30);await a.eval("quickStockIn('X')");assert.equal((await state()).purchaseLogs.at(-1).unitPrice,30);return{historicalCost:80,nextPrice:30};
 });
 await record('03-zero-and-omitted-price',async()=>{await fresh();await a.eval("buy('X',2,10);buy('X',1,0);price('X',30);document.getElementById('modal-stock').classList.add('show');document.getElementById('input-raw-stock').value='X 2';previewAllocation();confirmAllocation()");const r=await state();assert.deepEqual(r.purchaseLogs.map(l=>l.unitPrice),[10,0,0]);assert.equal(r.productMeta.X.lastPrice,30);assert.equal(r.purchaseLogs.reduce((s,l)=>s+l.totalCost,0),20);await a.eval("price('X',0)");assert.equal(await a.eval("getLatestPrice('X')"),0);return{zeroPreserved:true,omittedPriceStillZero:true};});
 await record('inventory-A',async()=>{await fresh();const r=await a.eval("var id=add('A','X',5);add('B','X',3);buy('X',10,10);deleteOrder(id);add('C','X',4);({stock:getCurrentStock('X'),cost:Number(state().spend),allocated:orders.reduce((s,o)=>s+o.purchased,0)})");assert.deepEqual(r,{stock:3,cost:100,allocated:7});await state();return r;});
 await record('inventory-B',async()=>{await fresh();const r=await a.eval("var id=add('A','X',5);buy('X',2,10);edit(id,'qty',3);buy('X',4,12);deleteOrder(id);add('B','X',4);({stock:getCurrentStock('X'),cost:Number(state().spend),allocated:orders[0].purchased})");assert.deepEqual(r,{stock:2,cost:68,allocated:4});await state();return r;});
 await record('inventory-C',async()=>{await fresh();await a.eval("var id=add('A','X',2,20);buy('X',2,10);togglePaid(id);openPriceModal(id);document.getElementById('input-edit-price').value=30;confirmPriceEdit();edit(id,'qty',3);deleteOrder(id);add('A','X',3,30)");const r=await state();assert.equal(r.orders[0].isPaid,false);assert.equal(r.orders[0].qty*r.orders[0].sellingPrice,90);return{unpaid:90};});
 await record('inventory-rename-X-to-Y',async()=>{await fresh();await a.eval("add('A','X',5);add('B','X',5);buy('X',5);buy('Y',3);edit(orders[0].id,'product','Y')");const r=await state();assert.deepEqual(r.orders.map(o=>[o.product,o.purchased]),[['Y',3],['X',5]]);const before=await a.eval('JSON.stringify(validateDataState(captureDataState()))');await reload();assert.equal(await a.eval('JSON.stringify(captureDataState())'),before);return{oldReallocated:5,newConsumed:3};});
 for(const mobile of [false,true])for(const index of [0,1,2])for(const accept of [true,false])await record('22-'+(mobile?'touch':'mouse')+'-'+index+'-'+(accept?'delete':'cancel'),async()=>{
 await fresh();await a.eval("add('客户','A',1);add('客户','B',1);add('客户','C',1);window.confirm=window.nativeConfirm;window.ev=[];for(const name of ['mousedown','mouseup','click','touchstart','touchend','pointerdown','pointerup'])document.addEventListener(name,e=>ev.push({type:e.type,product:e.target.closest('tr')?.textContent,active:_lpActive}),true)");
 await a.send('Emulation.setDeviceMetricsOverride',{width:mobile?390:1100,height:844,deviceScaleFactor:1,mobile});await a.send('Emulation.setTouchEmulationEnabled',{enabled:mobile});a.events=[];a.dialogAccept=accept;
 const pos=await point('.tap-row .cell-clickable',index*2);await down(pos,mobile);await sleep(850);
 assert.equal(a.events.filter(e=>e.method==='Page.javascriptDialogOpening').length,1);await up(pos,mobile);await sleep(120);
 assert.equal(await a.eval('editingField'),null);assert.equal(await a.eval("document.querySelectorAll('.modal-overlay.show').length"),0);
 assert.deepEqual(await a.eval('orders.map(o=>o.product)'),['A','B','C'].filter((_,i)=>!accept||i!==index));await sleep(750);assert.equal(a.events.filter(e=>e.method==='Page.javascriptDialogOpening').length,1,'不能二次触发删除');
 await click('.tap-row .cell-clickable',0,mobile);assert.equal(await a.eval('editingField.field'),'product','后续普通点击应可编辑');await a.eval('closeEditFieldModal()');await state();
 await a.send('Emulation.setTouchEmulationEnabled',{enabled:false});await a.send('Emulation.clearDeviceMetricsOverride');return{oneDialog:true,noResidualEdit:true,nextTapWorks:true};
 });
 await record('22-touch-cancel',async()=>{await fresh();await a.eval("add('客户','A',1);window.confirm=window.nativeConfirm");await a.send('Emulation.setTouchEmulationEnabled',{enabled:true});a.events=[];const p=await point('.tap-row .cell-clickable');await down(p,true);await sleep(200);await a.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await sleep(800);assert.equal(a.events.filter(e=>e.method==='Page.javascriptDialogOpening').length,0);assert.equal((await state()).orders.length,1);await click('.tap-row .cell-clickable',0,true);assert.equal(await a.eval('editingField.field'),'product');await a.send('Emulation.setTouchEmulationEnabled',{enabled:false});return{cancelled:true};});
 await record('no-page-exceptions',async()=>{assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));return{count:0};});
 if(out.some(x=>x.error))process.exitCode=1;
 console.log(JSON.stringify({summary:{total:out.length,failed:out.filter(x=>x.error).length}}));
 await a.send('Browser.close').catch(()=>{});a.ws.close();server.close();await sleep(500);
 if(!out.some(x=>x.error)){fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
 else console.error('测试失败，临时证据保留于：'+scratch);
}
main().catch(e=>{console.error(e);if(edge)edge.kill();if(server)server.close();process.exitCode=1;});
