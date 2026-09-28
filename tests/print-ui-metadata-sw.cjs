// 打印/UI/元数据/SW回归：node tests/print-ui-metadata-sw.cjs
// PDF解析需要pypdf；默认使用已有Codex Python，可用PDF_PYTHON指定。
// PRINT_ARTIFACT_DIR可选：保留本轮生成的A4样例，否则成功后清理。
// Node 22+、已安装 Edge（可用 EDGE_PATH 指定）、Python+pypdf（可用 PDF_PYTHON 指定）。
// 直接使用 CDP，不下载浏览器；PRINT_ARTIFACT_DIR 可保留 PDF 和截图。
// 独立临时浏览器目录和127.0.0.1来源；成功自动清理，失败保留测试证据。
const fs=require('fs'),http=require('http'),cp=require('child_process'),path=require('path');
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(require('os').tmpdir(),'jizhang-print-ui-')),out=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));let edge,server;const pageErrors=[];
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
 const helper="window.confirm=()=>true;window.alert=msg=>{window.lastAlert=msg;};window.add=(customer,product,qty,price=20,location='店A')=>{for(const [id,val] of Object.entries({'customer':customer,'product':product,'qty':qty,'price':price,'location':location}))document.getElementById('input-confirm-'+id).value=val;confirmAddOrder();return orders.at(-1)?.id;};window.buy=(product,qty,price=10,location='店B')=>{pendingAlloc=allocatePurchase(product,qty,price,location,true);confirmAllocation();};window.edit=(id,field,val)=>{openEditFieldModal(id,field);document.getElementById('input-edit-field').value=val;confirmEditField();};window.total=(product,n)=>{openEditPurchasedModal(product,'',0);document.getElementById('input-edit-purchased').value=n;confirmEditPurchased();};window.price=(product,n)=>{openEditProductPriceModal(product);document.getElementById('input-edit-product-price').value=n;confirmEditProductPrice();};window.state=()=>({orders,purchaseLogs,productMeta,spend:document.getElementById('finance-total').dataset.raw,sales:document.getElementById('finance-sales').dataset.raw,toast:document.getElementById('toast').textContent});";
 async function fresh(seed={}){await a.send('Page.bringToFront');await reset(seed);await a.eval(helper);}
 async function record(name,fn){try{out.push({name,result:await fn()});}catch(e){out.push({name,error:String(e)});}console.log(JSON.stringify(out.at(-1)));fs.writeFileSync(path.join(scratch,'results.json'),JSON.stringify(out,null,2));}

 const assert=require('assert');
 async function imp(value,raw=false){
   await a.eval('handleImportFile({target:{files:[new File(['+JSON.stringify(raw?value:JSON.stringify(value))+"],'test.json')],value:''}})");
   await sleep(80);
 }
 async function reload(){await a.send('Page.reload');await sleep(140);}
 async function downloadRecovery(folder,commands){
   const dir=path.join(scratch,folder);fs.mkdirSync(dir,{recursive:true});
   await a.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir});
   await a.eval(commands);await sleep(250);
   return fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(fs.readFileSync(path.join(dir,x),'utf8')));
 }

 // Edge 的 PDF 字体映射可能将汉字提取为外形相同的部首；DOM 另作原文精确比较。
 const pdfText=s=>s.normalize('NFKC').replace(/\u2ed3/g,'长').replace(/\s/g,'');
 const bundledPython=path.join(process.env.USERPROFILE||'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
 const pdfPython=process.env.PDF_PYTHON||(fs.existsSync(bundledPython)?bundledPython:'python');
 const pdfDir=process.env.PRINT_ARTIFACT_DIR||path.join(scratch,'pdf');fs.mkdirSync(pdfDir,{recursive:true});
 async function printPDF(name){const r=await a.send('Page.printToPDF',{paperWidth:210/25.4,paperHeight:297/25.4,preferCSSPageSize:true,printBackground:true});const file=path.join(pdfDir,name+'.pdf');fs.writeFileSync(file,Buffer.from(r.data,'base64'));const pages=JSON.parse(cp.execFileSync(pdfPython,['-X','utf8','-c','from pypdf import PdfReader; import sys,json; r=PdfReader(sys.argv[1]); print(json.dumps([{ "text":p.extract_text(),"width":float(p.mediabox.width),"height":float(p.mediabox.height)} for p in r.pages]))',file],{encoding:'utf8'}));assert(pages.every(p=>Math.abs(p.width-595)<2&&Math.abs(p.height-842)<2));return{file,pages,text:pdfText(pages.map(p=>p.text).join('\n'))};}
 for(const section of ['customers','products'])await record('14-full-print-'+section,async()=>{
 await fresh();await a.eval("add('A','MASK',2,35);add('A','PASTE',3,20);switchTab('"+section+"');document.getElementById('searchInput').value='MASK';doSearch()");
 const view="JSON.stringify({search:document.getElementById('searchInput').value,styles:[...document.querySelectorAll('.card,tr,.location-body')].map(e=>[e.getAttribute('style'),e.className])})",before=await a.eval(view);
 const pdf=await printPDF('filter-'+section);assert(pdf.text.includes('MASK'));assert(pdf.text.includes('PASTE'));assert(pdf.text.includes('130.00'));assert.equal(await a.eval(view),before);return{allRowsAndTotal:true,screenUnchanged:true,pages:pdf.pages.length};
 });
 const noteCases=[['order','订单备注 中文 English',''],['product','','商品备注 中文 English'],['both','Order memo','Product memo'],['special','<script>window.injected=1</script> " & \'','特殊<>&\'"'],['long','长备注 English '.repeat(80)+'ORDEREND','商品备注 '.repeat(80)+'PRODUCTEND'],['none','','']];
 for(const [name,orderNote,productNote] of noteCases)await record('15-notes-'+name,async()=>{
 await fresh();await a.eval("add('A','X',2,35);orders[0].note="+JSON.stringify(orderNote)+";productMeta.X.note="+JSON.stringify(productNote)+";renderAll()");
 const n=await a.eval("document.querySelectorAll('.note-preview').length");assert.equal(n,(orderNote?1:0)+(productNote?2:0));assert.equal(await a.eval("[...document.querySelectorAll('.note-preview')].every(e=>getComputedStyle(e).display==='none')"),true);
 const domNotes=await a.eval("[...document.querySelectorAll('.note-preview')].map(e=>e.textContent)");for(const [label,note] of [['订单备注：',orderNote],['商品备注：',productNote]])if(note)assert(domNotes.includes(label+note));
 const pdf=await printPDF('notes-'+name);for(const note of [orderNote,productNote])if(note)assert(pdf.text.includes(pdfText(note)),'备注内容丢失');assert.equal(await a.eval('window.injected||0'),0);return{notes:n,pages:pdf.pages.length,complete:true};
 });
 for(const width of [1100,390])for(const [kind,name] of [['normal','面膜'],['chinese','超长中文商品名称'.repeat(30)],['english','LongProduct'.repeat(30)],['mixed','中文LongName混合'.repeat(25)],['number','iPhone 18 '.repeat(25)]])await record('16-layout-'+width+'-'+kind,async()=>{
 await fresh();await a.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});await a.eval('add('+JSON.stringify(name)+','+JSON.stringify(name)+',12,35.5)');
 const check=await a.eval("(()=>{const card=document.querySelector('#customer-table-container .card').getBoundingClientRect(),row=document.querySelector('.tap-row'),cells=[...row.cells].map(e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width}});return{card:{x:card.x,right:card.right},cells,button:document.querySelector('.btn-add-for-customer').getBoundingClientRect().right}})()");
 assert(check.cells.every(c=>c.x>=check.card.x-1&&c.right<=check.card.right+1&&c.width>0));assert(check.button<=check.card.right+1);
 if(width===390&&kind==='english'){await sleep(2500);fs.writeFileSync(path.join(pdfDir,'mobile-customer-long-name.png'),Buffer.from((await a.send('Page.captureScreenshot')).data,'base64'));}
 await a.eval("switchTab('products');document.querySelectorAll('.location-body').forEach(e=>e.classList.add('open'))");assert.equal(await a.eval("[...document.querySelectorAll('#product-table-container table')].every(e=>e.getBoundingClientRect().right<=innerWidth)"),true);
 if(width===390&&kind==='english')fs.writeFileSync(path.join(pdfDir,'mobile-long-name.png'),Buffer.from((await a.send('Page.captureScreenshot')).data,'base64'));
 await a.send('Emulation.clearDeviceMetricsOverride');return{criticalColumnsVisible:true};
 });
 for(const scenario of ['omitted','zero','multiple'])await record('17-location-'+scenario,async()=>{
 await fresh();await a.eval("buy('X',2,10,'旧店');pendingAlloc=allocatePurchase('X',1,0,'新店',"+(scenario==='zero'?'true':'false')+");confirmAllocation()"+(scenario==='multiple'?";pendingAlloc=allocatePurchase('X',1,0,'第三店',false);confirmAllocation()":''));
 const expected=await a.eval('JSON.stringify(productMeta.X)');assert.equal(await a.eval('productMeta.X.lastLocation'),scenario==='multiple'?'第三店':'新店');assert.equal(await a.eval("getLatestPrice('X')"),scenario==='zero'?0:10);
 await reload();assert.equal(await a.eval('JSON.stringify(productMeta.X)'),expected);await a.send('Page.close');a.ws.close();a=await tab();assert.equal(await a.eval('JSON.stringify(productMeta.X)'),expected);await a.eval(helper);
 const [backup]=await downloadRecovery('metadata-'+scenario,'doExportFile()');await fresh();await imp(backup);assert.equal(await a.eval('JSON.stringify(productMeta.X)'),expected);await a.eval("price('X',30)");await reload();assert.equal(await a.eval("getLatestPrice('X')"),30);assert.equal(await a.eval('productMeta.X.lastLocation'),scenario==='multiple'?'第三店':'新店');return{refreshReopenBackupDefaultPrice:true};
 });
 await record('18-unique-kinds',async()=>{await fresh();const r=await a.eval("add('A','X',2,10,'东京');add('B','X',2,10,'大阪');add('C','Y',1,10,'大阪');buy('Z',2,10);[...document.querySelectorAll('.summary-chip .num')].map(e=>Number(e.textContent))");assert.deepEqual(r,[2,3,2,5]);await a.eval("buy('X',4,10)");assert.deepEqual(await a.eval("[...document.querySelectorAll('.summary-chip .num')].map(e=>Number(e.textContent))"),[2,3,1,1]);return{uniqueIncludingStock:true};});
 for(const [name,batches,target,cost] of [['single',[[5,10]],3,30],['two',[[2,10],[3,20]],3,40],['three',[[2,10],[3,20],[2,30]],6,110],['zero-total',[[2,10],[3,20]],0,0],['increase',[[2,10],[3,20]],7,120],['zero-batch',[[2,10],[3,0]],4,20]])await record('19-cost-'+name,async()=>{await fresh();await a.eval('for(const [qty,price] of '+JSON.stringify(batches)+")buy('X',qty,price);total('X',"+target+")");assert.equal(await a.eval("getPurchaseCost('X')"),cost);assert.equal(await a.eval('Number(state().spend)'),cost);assert((await a.eval('state().toast')).endsWith('¥'+cost.toFixed(2)));return{cost};});
 for(const [name,count,longName,longNote] of [['2-orders',2,false,false],['10-orders',10,false,false],['100-orders',100,false,false],['long-names',2,true,false],['long-notes',2,false,true]])await record('20-pdf-'+name,async()=>{
 await fresh();await a.eval('for(let i=0;i<'+count+';i++){add("客户A","Item"+String(i).padStart(3,"0")+'+JSON.stringify(longName?'Long连续'.repeat(65)+'ENDNAME':'')+',2,35);'+(longNote?'orders.at(-1).note="'+('中英 Note '.repeat(400)+'ENDNOTE')+'";':'')+'}renderAll()');
 const pdf=await printPDF(name);assert(pdf.pages[0].text.replace(/\s/g,'').includes('Item000'),'首页没有正文');for(let i=0;i<count;i++)assert.equal(pdf.text.split('Item'+String(i).padStart(3,'0')).length-1,2,'客户或商品表漏商品'+i);
 assert(pdf.pages.every(p=>p.text.trim().length>30),'纯标题/空白页');if(count<=10&&!longName&&!longNote)assert.equal(pdf.pages.length,1);assert(pdf.text.includes((count*70).toFixed(2)),'金额缺失');assert(pdf.text.includes('35.00'),'售价缺失');assert(pdf.text.includes('0/2'),'已采缺失');
 if(longName)assert(pdf.text.includes('ENDNAME'));if(longNote)assert.equal((pdf.text.match(/ENDNOTE/g)||[]).length,2);return{file:pdf.file,pages:pdf.pages.length,pageTextLengths:pdf.pages.map(p=>p.text.length),allItems:true};
 });
 await record('21-actual-activate-handler',async()=>{const vm=require('vm'),handlers={},names=new Set(['shuangbiao-v3','shuangbiao-v4','another-app-test','ordinary-cache']);let work;vm.runInNewContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),{self:{addEventListener:(name,fn)=>handlers[name]=fn,clients:{claim:async()=>{}}},caches:{keys:async()=>[...names],delete:async key=>names.delete(key)}});handlers.activate({waitUntil:p=>work=p});await work;assert.deepEqual([...names],['shuangbiao-v4','another-app-test','ordinary-cache']);return{onlyOwnOldDeleted:true};});
 await record('21-browser-activation',async()=>{const result=await a.eval("(async()=>{for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();for(const n of ['shuangbiao-v3','another-app-test','ordinary-cache'])await caches.open(n);const r=await navigator.serviceWorker.register('./sw.js?test='+Date.now());const w=r.installing||r.waiting||r.active;if(w.state!=='activated')await new Promise(resolve=>w.addEventListener('statechange',()=>{if(w.state==='activated')resolve()}));return(await caches.keys()).sort()})()");assert(!result.includes('shuangbiao-v3'));for(const n of ['shuangbiao-v4','another-app-test','ordinary-cache'])assert(result.includes(n));return{remaining:result};});
 await record('no-page-exceptions',async()=>{assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));return{count:0};});
 if(out.some(x=>x.error))process.exitCode=1;
 console.log(JSON.stringify({summary:{total:out.length,failed:out.filter(x=>x.error).length}}));
 await a.send('Browser.close').catch(()=>{});a.ws.close();server.close();await sleep(500);
 if(!out.some(x=>x.error)){fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
 else console.error('测试失败，临时证据保留于：'+scratch);
}
main().catch(e=>{console.error(e);if(edge)edge.kill();if(server)server.close();process.exitCode=1;});
