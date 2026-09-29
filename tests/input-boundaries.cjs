// 输入边界回归：node tests/input-boundaries.cjs
// Node 22+、已安装Edge（可用EDGE_PATH指定）；无第三方依赖，不下载浏览器。
// 独立临时浏览器目录和127.0.0.1来源；成功自动清理，失败保留测试证据。
const fs=require('fs'),http=require('http'),cp=require('child_process'),path=require('path');
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(require('os').tmpdir(),'jizhang-input-boundaries-')),out=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));let edge,server;const pageErrors=[];
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
 edge=cp.spawn(process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(scratch,'profile'),'about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=Number(fs.readFileSync(path.join(scratch,'profile/DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{}await sleep(100);}if(!port)throw Error('Edge startup failed');
 async function tab(){const t=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();const c=await CDP.connect(t.webSocketDebuggerUrl);await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};'});await c.send('Page.navigate',{url:origin});await sleep(180);return c;}
 let a=await tab();
 async function reset(seed={}){await a.eval('localStorage.clear();'+Object.entries(seed).map(([k,v])=>'localStorage.setItem('+JSON.stringify(k)+','+JSON.stringify(typeof v==='string'?v:JSON.stringify(v))+');').join(''));await a.send('Page.reload');await sleep(120);}
 const O='dual_table_orders_v6',L='dual_table_purchase_logs_v6',M='dual_table_product_meta_v6';
 const helper="window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};window.add=(customer,product,qty,price=20,location='店A')=>{openAddModal();showAddStep(2);for(const [id,val] of Object.entries({'customer':customer,'product':product,'qty':qty,'price':price,'location':location}))document.getElementById('input-confirm-'+id).value=val;confirmAddOrder();return orders.at(-1)?.id;};window.buy=(product,qty,price=10,location='店B')=>{pendingAlloc=allocatePurchase(product,qty,price,location,true);confirmAllocation();};window.edit=(id,field,val)=>{openEditFieldModal(id,field);document.getElementById('input-edit-field').value=val;confirmEditField();};window.total=(product,n)=>{openEditPurchasedModal(product,'',0);document.getElementById('input-edit-purchased').value=n;confirmEditPurchased();};window.price=(product,n)=>{openEditProductPriceModal(product);document.getElementById('input-edit-product-price').value=n;confirmEditProductPrice();};window.state=()=>({orders,purchaseLogs,productMeta,spend:document.getElementById('finance-total').dataset.raw,sales:document.getElementById('finance-sales').dataset.raw,toast:document.getElementById('toast').textContent});";
 async function fresh(seed={}){await a.send('Page.bringToFront');await reset(seed);await a.eval(helper);}
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

 const idPayloads=['x" onpointerover="window.injected=1',"x');window.injected=1;//",'<script>window.injected=1</script>','x&y','<','>','javascript:window.injected=1'];
 for(const id of idPayloads)await record('09-reject-id-'+id,async()=>{await fresh(seedOf(sample));const raw=await a.eval(rawExpr);const x=clone(sample);x.orders[0].id=id;await imp(x);assert.equal(await a.eval(rawExpr),raw);assert.equal(await a.eval('window.injected||0'),0);return{rejected:true};});
 for(const id of ['abc123','1690000000000','legacy-order_01','550e8400-e29b-41d4-a716-446655440000','onclick','onpointerover'])await record('09-safe-id-'+id,async()=>{await fresh();const x=clone(sample);x.orders[0].id=id;await imp(x);assert.equal(await a.eval('orders[0].id'),id);await a.eval("document.querySelector('.tap-row .cell-clickable').click()");assert.equal(await a.eval('editingField.orderId'),id);await a.eval("document.getElementById('input-edit-field').value='Y';confirmEditField();deleteOrder(orders[0].id)");assert.equal(await a.eval('orders.length'),0);return{importEditDelete:true};});
 const texts=['double"quote',"single'quote",'<','>','&','x" onpointerover="window.injected=1',"x');window.injected=1;//",'<script>window.injected=1</script>','javascript:window.injected=1','onclick','onpointerover','反斜杠\\'];
 for(const value of texts)await record('09-text-'+value,async()=>{
 await fresh();const x=clone(sample);x.orders[0].customer=value;x.orders[0].product=value;x.orders[0].location=value;x.orders[0].note=value+'\n第二行';x.purchaseLogs[0].product=value;x.purchaseLogs[0].location=value;x.productMeta=Object.fromEntries([[value,{lastLocation:value,lastPrice:10,note:value+'\n第二行'}]]);await imp(x);
 assert.equal(await a.eval('orders[0].product'),value);assert.equal(await a.eval("document.querySelector('.tap-row td .cell-clickable').textContent"),value);
 await a.eval("for(const el of document.querySelectorAll('.tap-row,.card'))el.dispatchEvent(new Event('pointerover'));document.querySelector('.tap-row .cell-clickable').click()");assert.equal(await a.eval('editingField.orderId'),'o1');await a.eval("closeEditFieldModal();document.querySelector('.btn-add-for-customer').click()");assert.equal(await a.eval('JSON.parse(document.getElementById("input-raw-order").value.trim())'),value);await a.eval('closeAddModal();renderProducts()');
 assert.equal(await a.eval('window.injected||0'),0);assert.equal(await a.eval("document.querySelectorAll('[onpointerover]').length"),0);assert.equal(await a.eval("document.querySelectorAll('.tap-row').length"),1);return{dataOnly:true};
 });
 await record('09-render-defence-and-note-newline',async()=>{await fresh(seedOf(sample));await a.eval(`orders[0].id='x" onpointerover="window.injected=1';renderAll();document.querySelector('.tap-row').dispatchEvent(new Event('pointerover'));document.querySelector('.tap-row .cell-clickable').click()`);assert.equal(await a.eval('window.injected||0'),0);assert.equal(await a.eval('editingField.orderId'),await a.eval('orders[0].id'));return{escapedEvenWithoutImportGate:true};});
 for(const name of ['constructor','__proto__','prototype','toString','hasOwnProperty'])for(const role of ['customer','product','location'])await record('10-'+role+'-'+name,async()=>{
 await fresh();await a.eval('add('+JSON.stringify(role==='customer'?name:'A')+','+JSON.stringify(role==='product'?name:'X')+',2,10,'+JSON.stringify(role==='location'?name:'店')+')');assert.equal(await a.eval('orders.length'),1);const product=role==='product'?name:'X';
 await a.eval('buy('+JSON.stringify(product)+',3,4);edit(orders[0].id,"qty",3);openProductNoteModal('+JSON.stringify(product)+');document.getElementById("input-product-note").value="备注";confirmProductNote()');
 const canonical=await a.eval('JSON.stringify(validateDataState(captureDataState()))');await reload();await a.eval(helper);assert.equal(await a.eval('JSON.stringify(captureDataState())'),canonical);assert.equal(await a.eval('!!dataProtection'),false);
 const [backup]=await downloadRecovery('special-'+role+'-'+name,'doExportFile()');await fresh();await imp(backup);assert.equal(await a.eval('JSON.stringify(captureDataState())'),canonical);
 await a.eval('edit(orders[0].id,"product","暂改");edit(orders[0].id,"product",'+JSON.stringify(product)+');renderProducts();deleteOrder(orders[0].id)');assert.equal(await a.eval('orders.length'),0);assert.equal(await a.eval('getCurrentStock('+JSON.stringify(product)+')'),3);
 assert.equal(await a.eval('Object.prototype.lastLocation'),undefined);assert.equal(await a.eval('Object.lastLocation'),undefined);assert.equal(await a.eval('Object.getPrototypeOf(productMeta)===null'),true);return{addRefreshEditSummaryExportImportDelete:true};
 });
 await record('10-nested-prototype-payload-rejected',async()=>{await fresh(seedOf(sample));const raw=await a.eval(rawExpr),x=clone(sample);x.productMeta=JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');await imp(x);assert.equal(await a.eval(rawExpr),raw);assert.equal(await a.eval('({}).polluted'),undefined);return{rejected:true};});
 for(const entrance of ['manual','quick','import','v5','v6'])await record('11-reserved-'+entrance,async()=>{await fresh(seedOf(sample));let raw=await a.eval(rawExpr);
 if(entrance==='manual')await a.eval("add('【系统库存】','X',2)");
 if(entrance==='quick')await a.eval("document.getElementById('input-raw-order').value='【系统库存】 X 2 10';parseAndReview()");
 if(entrance==='import'){const x=clone(sample);x.orders[0].customer='【系统库存】';await imp(x);}
 if(entrance==='v5'||entrance==='v6'){const x=clone(sample);x.orders[0].customer='【系统库存】';await fresh(entrance==='v5'?{'dual_table_orders_v5':x.orders,'dual_table_purchase_logs_v5':x.purchaseLogs,'dual_table_product_meta_v5':x.productMeta}:seedOf(x));raw=await a.eval(rawExpr);assert.equal(await a.eval('!!dataProtection'),true);await reload();}
 assert.equal(await a.eval(rawExpr),raw);return{noSilentDeletionOrSuccess:true};});
 // Explicit numeric range retained from the stable baseline: safe-integer counts and 1e12 yuan per price, line and ledger total.
 for(const mutation of ['orders[0].sellingPrice=Infinity','orders[0].sellingPrice=NaN','orders[0].qty=Number.MAX_SAFE_INTEGER+1','productMeta.X.lastPrice=NaN','purchaseLogs[0].unitPrice=1e308;purchaseLogs[0].totalCost=Infinity','orders[0].sellingPrice=1e12'])await record('12-write-reject-'+mutation,async()=>{await fresh(seedOf(sample));const raw=await a.eval(rawExpr),mem=await a.eval('JSON.stringify(captureDataState())');assert.equal(await a.eval('var prev=captureDataState();'+mutation+';persistDataState(prev,DATA_KEYS)'),false);assert.equal(await a.eval(rawExpr),raw);assert.equal(await a.eval('JSON.stringify(captureDataState())'),mem);return{unchanged:true};});
 for(const entry of ['add','edit-sale','default-price','purchase','total-purchased'])await record('12-entry-'+entry,async()=>{await fresh(seedOf(sample));if(entry==='total-purchased')await a.eval("price('X',1e12)");const raw=await a.eval(rawExpr);await a.eval({add:"add('B','Y',10,1e308)",'edit-sale':"openPriceModal(orders[0].id);document.getElementById('input-edit-price').value=1e308;confirmPriceEdit()",'default-price':"price('X',1e308)",purchase:"buy('X',10,1e308)",'total-purchased':"total('X',10)"}[entry]);assert.equal(await a.eval(rawExpr),raw);return{rejected:true};});
 for(const type of ['sales','cost'])await record('12-aggregate-'+type,async()=>{await fresh();await a.eval(type==='sales'?"add('A','X',1,6e11)":"buy('X',1,6e11)");const raw=await a.eval(rawExpr);await a.eval(type==='sales'?"add('B','Y',1,6e11)":"buy('Y',1,6e11)");assert.equal(await a.eval(rawExpr),raw);return{aggregateRejected:true};});
 await record('12-zero-normal-and-max-refresh',async()=>{await fresh();await a.eval("add('A','X',1,1e12);buy('X',1,1e12);add('B','Y',2,0);buy('Y',2,0)");const canonical=await a.eval('JSON.stringify(validateDataState(captureDataState()))');await reload();assert.equal(await a.eval('JSON.stringify(captureDataState())'),canonical);return{zeroAndLimitRoundtrip:true};});
 await record('12-import-nonfinite-json-number',async()=>{await fresh(seedOf(sample));const raw=await a.eval(rawExpr);await imp(JSON.stringify(sample).replace('"sellingPrice":20','"sellingPrice":1e309'),true);assert.equal(await a.eval(rawExpr),raw);return{rejected:true};});
 const valid=[
 ['A X 2 10','X 2 10','X','',2,10],['A SK-II 2 0','SK-II 2 0','SK-II','',2,0],['A 3CE 2 10','3CE 2 10','3CE','',2,10],
 ['A "iPhone 18" 2 10','"iPhone 18" 2 10','iPhone 18','',2,10],['A 面膜 Mask 2 10','面膜 Mask 2 10','面膜 Mask','',2,10],
 ['A X 2 10 店 2 楼','X 2 10 店 2 楼','X','店 2 楼',2,10],['A X 2 10 东京站 3 号店','X 2 10 东京站 3 号店','X','东京站 3 号店',2,10],
 ['A X 2 10 Outlet 2F','X 2 10 Outlet 2F','X','Outlet 2F',2,10],['A X 2 店 2 楼','X 2 店 2 楼','X','店 2 楼',2,0],
 ['A X 2','X 2','X','',2,0],['A X 2 10 "2 楼"','X 2 10 "2 楼"','X','2 楼',2,10]
 ];
 for(const [order,stock,product,location,qty,price] of valid)await record('13-valid-'+order,async()=>{await fresh();await a.eval('openAddModal();document.getElementById("input-raw-order").value='+JSON.stringify(order)+';parseAndReview();confirmAddOrder()');assert.equal(await a.eval('orders.length'),1);assert.deepEqual(await a.eval('({product:orders[0].product,location:orders[0].location,qty:orders[0].qty,price:orders[0].sellingPrice})'),{product,location,qty,price});await a.eval('document.getElementById("input-raw-stock").value='+JSON.stringify(stock)+';previewAllocation();confirmAllocation()');assert.deepEqual(await a.eval('({product:purchaseLogs[0].product,location:purchaseLogs[0].location,qty:purchaseLogs[0].qty,price:purchaseLogs[0].unitPrice})'),{product,location,qty,price});return{savedCorrectly:true};});
 const invalid=['X -2 10','X 2 -10','X 0 10','X 1.5 10','X Infinity 10','X NaN 10','X 1e309 10','X 2 Infinity','X 2 NaN','X 2 1e309','X 2 1000000000001','X 2 1000000000000','X 9007199254740992 0','iPhone 18 2 10','"iPhone 18 2 10'];
 for(const rawInput of invalid)for(const type of ['order','stock'])await record('13-invalid-'+type+'-'+rawInput,async()=>{await fresh(seedOf(sample));const raw=await a.eval(rawExpr);const input=type==='order'?'A '+rawInput:rawInput;const parsed=await a.eval((type==='order'?'parseOrderInput':'parseStockInput')+'('+JSON.stringify(input)+')');assert(parsed.error);await a.eval('document.getElementById('+JSON.stringify(type==='order'?'input-raw-order':'input-raw-stock')+').value='+JSON.stringify(input)+';'+(type==='order'?'parseAndReview()':'previewAllocation();confirmAllocation()'));assert.equal(await a.eval(rawExpr),raw);return{error:parsed.error,unchanged:true};});
 await record('13-autocomplete-numeric-name',async()=>{await fresh();await a.eval("add('A','iPhone 18',1);document.getElementById('input-raw-stock').value='i';document.getElementById('input-raw-stock').setSelectionRange(1,1);selectStockAutocomplete('iPhone 18');document.getElementById('input-raw-stock').value+='1 10';previewAllocation();confirmAllocation()");assert.equal(await a.eval('purchaseLogs[0].product'),'iPhone 18');return{quotedSuggestionSaved:true};});
 await record('workflow-print-export-import-refresh',async()=>{await fresh();await a.eval("add('A','X',3);buy('X',4,10);price('X',12);edit(orders[0].id,'qty',2);deleteOrder(orders[0].id);add('B','X',2)");const pdf=await a.send('Page.printToPDF',{printBackground:true});assert(Buffer.from(pdf.data,'base64').length>1000);const [backup]=await downloadRecovery('workflow','doExportFile()');await fresh();await imp(backup);const before=await a.eval('JSON.stringify(captureDataState())');await reload();assert.equal(await a.eval('JSON.stringify(captureDataState())'),before);return{printOpenedAndRoundtrip:true};});

 for(const entrance of ['manual-sale','edit-sale'])await record('12-native-number-overflow-'+entrance,async()=>{
 await fresh(seedOf(sample));const raw=await a.eval(rawExpr);
 const id=entrance==='manual-sale'?'input-confirm-price':'input-edit-price';
 await a.eval(entrance==='manual-sale'?"openAddModal();showAddStep(2);document.getElementById('input-confirm-customer').value='B';document.getElementById('input-confirm-product').value='Y';document.getElementById('input-confirm-qty').value=2":"openPriceModal(orders[0].id)");
 await sleep(350);await a.eval('document.getElementById('+JSON.stringify(id)+').focus();document.getElementById('+JSON.stringify(id)+').select()');await a.send('Input.insertText',{text:'1e309'});
 assert.equal(await a.eval('document.getElementById('+JSON.stringify(id)+').validity.badInput'),true);
 await a.eval(entrance==='manual-sale'?'confirmAddOrder()':'confirmPriceEdit()');assert.equal(await a.eval(rawExpr),raw);assert((await a.eval('state().toast')).includes('不是有效数字'));return{nativeInvalidNotZero:true};
 });
 for(const mobile of [false,true])await record('normal-ui-quick-entry-'+(mobile?'mobile':'desktop'),async()=>{
 await fresh();await a.send('Emulation.setDeviceMetricsOverride',{width:mobile?390:1100,height:844,deviceScaleFactor:1,mobile});
 async function click(selector){await sleep(300);const pos=await a.eval('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');await a.send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});await a.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});}
 await click('.btn-add');await sleep(350);await a.send('Input.insertText',{text:'A "iPhone 18" 2 10 店 2 楼'});await click('#add-step1 .btn-primary');await click('#add-step2 .btn-primary');assert.equal(await a.eval('orders[0].product'),'iPhone 18');
 await click('.btn-stock');await sleep(350);await a.send('Input.insertText',{text:'"iPhone 18" 2 5 店 2 楼'});await click('#stock-step1 [onclick="previewAllocation()"]');await click('#btn-confirm-alloc');assert.equal(await a.eval('orders[0].purchased'),2);assert.equal(await a.eval('purchaseLogs[0].location'),'店 2 楼');await a.send('Emulation.clearDeviceMetricsOverride');return{nativeClicksAndInput:true};
 });
 await record('no-page-exceptions',async()=>{assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));return{count:0};});
 if(out.some(x=>x.error))process.exitCode=1;
 console.log(JSON.stringify({summary:{total:out.length,failed:out.filter(x=>x.error).length}}));
 await a.send('Browser.close').catch(()=>{});a.ws.close();server.close();await sleep(500);
 if(!out.some(x=>x.error)){fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
 else console.error('测试失败，临时证据保留于：'+scratch);
}
main().catch(e=>{console.error(e);if(edge)edge.kill();if(server)server.close();process.exitCode=1;});
