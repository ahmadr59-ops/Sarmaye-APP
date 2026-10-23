const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {JSDOM}=require('jsdom');
const {IDBFactory}=require('fake-indexeddb');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n').replace(/\ninit\(\);\s*$/,'\n');
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(factory=new IDBFactory(),storage=new Map()){
  const dom=new JSDOM(html,{url:'https://example.test/Sarmaye-APP/',runScripts:'outside-only'});
  const w=dom.window,ctx=dom.getInternalVMContext();
  w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.clearTimeout=()=>{};
  w.indexedDB=factory;w.structuredClone=structuredClone;
  Object.defineProperty(w,'crypto',{value:webcrypto});
  Object.defineProperty(w,'localStorage',{value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)}});
  w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.File=File;w.Blob=Blob;
  w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
  w.confirm=()=>true;w.prompt=()=>null;w.alert=()=>{};
  w.fetch=async()=>{throw Error('Unexpected network request in isolated test');};
  vm.runInContext(code,ctx);
  const run=src=>vm.runInContext(src,ctx);
  return {w,run,storage,async boot(){await run('openDB()');await run('loadState()');},close(){run('if(db)db.close()');w.close();}};
}
function setup(t,factory,storage){const f=fixture(factory,storage);t.after(()=>f.close());return f;}

test('IndexedDB acknowledges transaction completion, not the put request',async t=>{
  const f=setup(t);await f.boot();
  await f.run(`(async()=>{await dbSet('probe',{ok:true});})()`);
  assert.equal((await f.run(`dbGet('probe')`)).ok,true);
  let tx;
  f.w.__fakeDb={transaction:()=>{tx={objectStore:()=>({put:()=>({})})};return tx;}};
  f.run('db=__fakeDb');
  let settled=false;const p=f.run(`dbSet('probe',{})`).then(()=>{settled=true;},()=>{settled=true;});
  await Promise.resolve();assert.equal(settled,false);
  tx.onabort();await p;assert.equal(settled,true);
  f.run('db=null');
});

test('fallback newer than IndexedDB survives reopening and then returns to IndexedDB',async t=>{
  const factory=new IDBFactory(),storage=new Map();const a=setup(t,factory,storage);await a.boot();
  await a.run(`ST.appName='OLD';sv()`);
  a.run(`dbWriteState=async()=>{throw Error('disk unavailable')};ST.appName='NEW'`);await a.run('sv()');
  assert.equal(JSON.parse(storage.get('srmy1')).appName,'NEW');
  const b=setup(t,factory,storage);await b.boot();assert.equal(b.run('ST.appName'),'NEW');
  await b.run(`ST.appName='RECOVERED';sv()`);
  const c=setup(t,factory,storage);await c.boot();assert.equal(c.run('ST.appName'),'RECOVERED');
});

test('storage quota failure is visible and rejects save',async t=>{
  const f=setup(t);await f.boot();
  f.run(`dbWriteState=async()=>{throw Error('disk')};localStorage.setItem=()=>{throw Error('quota')}`);
  await assert.rejects(f.run('sv()'));
  assert.equal(f.run('storageHealthy'),false);
  assert.ok(f.w.document.getElementById('storage-error').textContent.includes('خروجی نجات'));
});

test('stale tab cannot overwrite a newer revision, including simultaneous writers',async t=>{
  const factory=new IDBFactory(),storage=new Map(),a=setup(t,factory,storage),b=setup(t,factory,storage);
  await a.boot();await b.boot();
  const outcomes=await Promise.allSettled([a.run(`ST.appName='A';sv()`),b.run(`ST.appName='B';sv()`)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const rejected=outcomes.find(x=>x.status==='rejected');assert.equal(rejected.reason.code,'STORAGE_CONFLICT');
  const saved=await a.run(`dbGet('state')`);assert.ok(['A','B'].includes(saved.appName));
});

test('missing IndexedDB can reopen a valid local fallback; corrupt data never becomes empty state',async t=>{
  const f=setup(t);await f.boot();const good=copy(f.run('ST'));
  const storage=new Map([['srmy1',JSON.stringify(good)]]);const g=setup(t,undefined,storage);
  g.run(`dbGet=async()=>{throw Error('no IDB')}`);await g.run('loadState()');assert.equal(g.run('ST.schemaVersion'),2);
  storage.set('srmy1','bad json');await assert.rejects(g.run('loadState()'));
});

test('valuation preserves past months, including migration and repeated same-day updates',async t=>{
  const f=setup(t);await f.boot();
  f.run(`today=()=>({y:1405,m:4,d:10});ST.accounts=[{id:'inv',bank:'بورس',initBalance:0}];ST.tx=[
    {id:'o',tp:'income',a:100,accId:'inv',isOpening:true,nature:'opening',y:1405,m:0,day:1},
    {id:'r',tp:'income',a:20,accId:'inv',nature:'revaluation',y:1405,m:1,day:1}];valAcc='inv';document.getElementById('valm-v').value='150'`);
  await f.run('saveVal()');assert.equal(f.run('assetsAt(1,1405)'),120);assert.equal(f.run(`calcAccBalance('inv')`),150);
  f.run(`document.getElementById('valm-v').value='140'`);await f.run('saveVal()');
  assert.equal(f.run(`calcAccBalance('inv')`),140);assert.equal(f.run('assetsAt(1,1405)'),120);
  f.run('delete ST.valV1;delete ST.revalV2;ST=migrateState(ST)');assert.equal(f.run('assetsAt(1,1405)'),120);
});

test('linked deposit cannot become ordinary income and date edit stays linked',async t=>{
  const f=setup(t);await f.boot();
  f.run(`ST.accounts=[{id:'a',bank:'x',initBalance:0}];ST.tx=[{id:'d',tp:'income',cat:'deposit',a:100,nature:'deposit',depositRole:'received',contractId:'c',accId:'a',day:1,m:0,y:1405}];ST.rentalContracts=[{id:'c',deposit:100,periods:[{sy:1405,sm:0,sd:1,dur:12,rent:10}],depositTxIds:{received:'d'}}];etx='d';txtp='income'`);
  await f.run(`finishSaveTx(100,'s1','x',1,0,1405,'a')`);assert.equal(f.run('depositLiability()'),100);assert.equal(f.run('netWorth()'),0);
  await f.run(`finishSaveTx(100,'deposit','x',2,0,1405,'a')`);
  assert.equal(f.run('ST.rentalContracts[0].depositReceivedDate.d'),2);
});

for(const kind of ['Amlak','Sarafi'])test(`${kind} outbox retains new items during upload and retries idempotently`,async t=>{
  const f=setup(t);await f.boot();const field=kind==='Amlak'?'amlakOutbox':'sarafiOutbox';
  f.run(`ghOn=()=>true;ghSchedule=()=>{};ST.${field}=[{id:'first',a:1,date:{y:1405,m:0,d:1}}]`);await f.run('sv()');
  let release;const uploaded=[];
  f.w.__upload=mut=>{const d={items:{}};mut(d);uploaded.push(copy(d));return new Promise(r=>release=r);};
  f.run('ghInboxUpdate=__upload');const task=f.run(`flush${kind}Outbox()`);
  await new Promise(r=>setImmediate(r));
  f.run(`ST.${field}.push({id:'second',a:2})`);await f.run('sv()');
  assert.equal(await f.run(`flush${kind}Outbox()`),0);
  release(true);assert.equal(await task,1);
  assert.deepEqual(Object.keys(uploaded[0].items),['first']);assert.deepEqual(copy(f.run(`ST.${field}.map(x=>x.id)`)),['second']);
  f.w.__fail=async()=>{throw Error('offline')};f.run('ghInboxUpdate=__fail');assert.equal(await f.run(`flush${kind}Outbox()`),0);
  assert.equal(f.run(`ST.${field}.length`),1);
});

test('HTML-like tenant name is rendered as text in both card and warning',async t=>{
  const f=setup(t);await f.boot();
  f.run(`const now=today();ST.tenants=[{id:'t',name:'<img src=x onerror=alert(1)>'}];ST.properties=[{id:'p',type:'residential'}];ST.rentalContracts=[{id:'c',tenantId:'t',propertyId:'p',periods:[{sy:now.y,sm:now.m-2,sd:1,dur:12,rent:100}],deposit:0}];rTen()`);
  assert.equal(f.w.document.querySelector('#alrt img'),null);assert.ok(f.w.document.getElementById('alrt').textContent.includes('<img'));
});

test('cancelled share and unconfirmed download do not update backup time',async t=>{
  const f=setup(t);await f.boot();f.w.navigator.canShare=()=>true;
  f.w.navigator.share=async()=>{throw new f.w.DOMException('cancel','AbortError');};
  await f.run('doBackup()');assert.equal(f.run('getLastBackupTs()'),0);
  f.w.navigator.canShare=()=>false;f.w.confirm=()=>false;await f.run('doBackup()');assert.equal(f.run('getLastBackupTs()'),0);
  f.w.navigator.canShare=()=>true;f.w.navigator.share=async()=>{};await f.run('doBackup()');assert.ok(f.run('getLastBackupTs()')>0);
});

test('restore rejects malformed/future input, supports cancellation, and can undo',async t=>{
  const f=setup(t);await f.boot();await f.run(`ST.appName='ORIGINAL';sv()`);const backup=copy(f.run('ST'));backup.appName='RESTORED';
  f.w.__backup=backup;
  await assert.rejects(f.run('applyBackupObject({...__backup,schemaVersion:99})'));
  await assert.rejects(f.run(`applyBackupObject({...__backup,tx:[{id:'bad',tp:'income',a:'10'}]})`));
  await assert.rejects(f.run(`applyBackupObject({...__backup,accounts:[{id:"bad'"}]})`));
  f.w.confirm=()=>false;assert.equal(await f.run('applyBackupObject(__backup)'),false);assert.equal(f.run('ST.appName'),'ORIGINAL');
  f.w.confirm=()=>true;assert.equal(await f.run('applyBackupObject(__backup)'),true);assert.equal(f.run('ST.appName'),'RESTORED');
  await f.run('undoRestore()');assert.equal(f.run('ST.appName'),'ORIGINAL');
});

test('restore stops if recovery snapshot cannot be written',async t=>{
  const f=setup(t);await f.boot();const input=copy(f.run('ST'));input.appName='REPLACEMENT';f.w.__backup=input;
  f.run(`dbSet=async()=>{throw Error('disk')};localStorage.setItem=()=>{throw Error('quota')}`);
  await assert.rejects(f.run('applyBackupObject(__backup)'));assert.notEqual(f.run('ST.appName'),'REPLACEMENT');
});

test('authentication, backgrounding and legacy auto-backup do not write cloud data',async t=>{
  const f=setup(t);await f.boot();let writes=0;
  f.w.__auth={currentUser:{uid:'test'},onAuthStateChanged:fn=>fn({uid:'test'})};
  f.w.__db={collection:()=>({doc:()=>({get:async()=>({exists:false}),set:async()=>writes++})})};
  f.run('fbReady=true;fbAuth=__auth;fbDb=__db;attachCloudListener()');await f.run('cloudAutoBackupIfSignedIn()');assert.equal(writes,0);
});

test('manual cloud backup preserves previous copy, encryption and unrelated fields',async t=>{
  const f=setup(t);await f.boot();let data={data:'{"old":true}',srmEnc:0,amlak:{keep:true}};
  const ref={get:async()=>({exists:true,data:()=>copy(data)})};
  f.w.__db={collection:()=>({doc:()=>ref}),runTransaction:async fn=>fn({get:ref.get,set:(_ref,v)=>{data={...data,...copy(v)}}})};
  f.w.__auth={currentUser:{uid:'test'}};f.w.firebase={firestore:{FieldValue:{serverTimestamp:()=>1}}};f.w.prompt=()=> 'test-password';
  f.run('fbReady=true;fbAuth=__auth;fbDb=__db;renderCloudPanel=()=>{}');assert.equal(await f.run('cloudBackupManual()'),true);
  assert.equal(data.srmEnc,1);assert.equal(data.sarmayePrevious.data,'{"old":true}');assert.equal(data.amlak.keep,true);
  f.w.__envelope=data;assert.equal((await f.run(`decryptJSON(__envelope,'test-password')`)).schemaVersion,2);
  await assert.rejects(f.run(`decryptJSON(__envelope,'wrong')`));
});

test('manual cloud backup refuses a concurrent remote change',async t=>{
  const f=setup(t);await f.boot();let writes=0;
  f.w.__auth={currentUser:{uid:'test'}};f.w.__db={collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>({data:'old'})})})}),runTransaction:async fn=>fn({get:async()=>({exists:true,data:()=>({data:'new'})}),set:()=>writes++})};
  f.w.prompt=()=>'';f.run('fbReady=true;fbAuth=__auth;fbDb=__db');assert.equal(await f.run('cloudBackupManual()'),false);assert.equal(writes,0);
});

test('GitHub automatic backup refuses unknown remote, manual replacement needs confirmation',async t=>{
  const f=setup(t);await f.boot();const requests=[];
  f.w.__gh=async(_path,opt)=>{requests.push(opt?.method||'GET');return opt?.method==='PUT'?{ok:true,json:async()=>({content:{sha:'next'}})}:{ok:true,json:async()=>({sha:'remote'})};};
  f.run(`localStorage.setItem(GH_KEY,JSON.stringify({owner:'test',repo:'test',token:'fake'}));ghFetch=__gh;ST.tx=[{id:'t',tp:'income',a:1,cat:'s1',day:1,m:0,y:1405}]`);
  assert.equal(await f.run('ghBackup(true)'),false);assert.equal(requests.includes('PUT'),false);
  f.w.confirm=()=>false;assert.equal(await f.run('ghBackup(false)'),false);assert.equal(requests.includes('PUT'),false);
  f.w.confirm=()=>true;assert.equal(await f.run('ghBackup(false)'),true);assert.equal(f.run('ghCfg().lastSha'),'next');
});

test('Jalali leap-year boundary and strict numeric parsing',t=>{
  const f=setup(t);
  assert.equal(f.run('jalOrdinal(1404,0,1)-jalOrdinal(1403,11,30)'),1);
  assert.equal(f.run(`toLn('۱۲٫۵')`),12.5);assert.equal(f.run(`toLn('123abc')`),0);assert.equal(f.run(`toLn('Infinity')`),0);
});

function worker(fetcher,initial=new Map()){
  const handlers={},puts=[],deleted=[];const ctx={Request,Response,Promise,Error,setTimeout:()=>0,
    fetch:fetcher,self:{addEventListener:(k,f)=>handlers[k]=f,clients:{claim:async()=>{}}},
    caches:{open:async()=>({put:async(k,res)=>{puts.push(res.status);initial.set(k,res)},addAll:async files=>{for(const f of files){const res=await fetcher(f);if(!res.ok)throw Error('precache failed')}}}),
      match:async k=>initial.get(k),keys:async()=>['sarmaye-old','another-app'],delete:async k=>deleted.push(k)}};
  // Resolve relative Requests against an HTTPS origin as a service worker would.
  ctx.Request=class extends Request{constructor(url,opts){super(new URL(url,'https://example.test/Sarmaye-APP/'),opts)}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/sw.js','utf8'),ctx);
  return {handlers,puts,deleted,async request(req){let result;const waits=[];handlers.fetch({request:req,respondWith:p=>result=p,waitUntil:p=>waits.push(p)});const response=await result;await Promise.all(waits);return response;}};
}
test('HTTP failure leaves the working offline HTML intact',async()=>{
  const req={mode:'navigate',headers:{get:()=>null}},cache=new Map([[req,new Response('working',{headers:{'Content-Type':'text/html'}})]]);
  const w=worker(async()=>new Response('broken',{status:503}),cache);assert.equal(await (await w.request(req)).text(),'working');assert.deepEqual(w.puts,[]);
});
test('failed worker install rejects and activation preserves other applications caches',async()=>{
  const w=worker(async()=>new Response('missing',{status:404}));let install;w.handlers.install({waitUntil:p=>install=p});await assert.rejects(install);
  let activate;w.handlers.activate({waitUntil:p=>activate=p});await activate;assert.deepEqual(w.deleted,['sarmaye-old']);
});

test('normal startup, quick expense and transfer persist and reopen in a full DOM',async t=>{
  const factory=new IDBFactory(),storage=new Map();const f=setup(t,factory,storage);
  await f.run('init()');
  f.run(`ST.accounts=[{id:'a',bank:'بانک آزمایشی',initBalance:0},{id:'b',bank:'بانک دوم',initBalance:0}];upsertOpeningTx(ST.accounts[0],1000)`);await f.run('sv()');
  f.run(`openQuick();qaCat='e7';document.getElementById('qa-amt').value='50';document.getElementById('qa-acc').value='a'`);await f.run('qaSave()');
  assert.equal(f.run(`calcAccBalance('a')`),950);assert.equal(f.run('totals(ST.tx).e'),50);
  f.run(`openQuick();qaTp('transfer');document.getElementById('qa-amt').value='100';document.getElementById('qa-from').value='a';document.getElementById('qa-to').value='b'`);await f.run('qaSave()');
  assert.equal(f.run(`calcAccBalance('a')`),850);assert.equal(f.run(`calcAccBalance('b')`),100);assert.equal(f.run('totals(ST.tx).e'),50);
  const g=setup(t,factory,storage);await g.run('init()');assert.equal(g.run(`calcAccBalance('a')`),850);assert.equal(g.run(`calcAccBalance('b')`),100);
});

test('valid network HTML updates cache; first offline navigation gives a readable error',async()=>{
  const req={mode:'navigate',headers:{get:()=>null}};
  const good=worker(async()=>new Response('new app',{headers:{'Content-Type':'text/html'}}));
  assert.equal(await (await good.request(req)).text(),'new app');assert.deepEqual(good.puts,[200]);
  const offline=worker(async()=>{throw Error('offline')});assert.equal((await offline.request(req)).status,503);
});

test('in-flight currency response cannot mutate state after a restore epoch changes',async t=>{
  const f=setup(t);await f.boot();let release;
  f.w.__get=()=>new Promise(r=>release=r);f.run('ghOn=()=>true;ghFetch=__get');const task=f.run('sarafiSync()');
  f.run('stateEpoch++');release({ok:true,json:async()=>({content:Buffer.from(JSON.stringify({target:500,at:100})).toString('base64')})});
  assert.equal(await task,false);assert.equal(f.run(`ST.accounts.some(a=>a.bank==='ارز')`),false);
});

// Daily-use flows: synthetic records only; every external operation is mocked.
const dailyBase=`ST.accounts=[{id:'a',bank:'بانک آزمایشی',initBalance:0},{id:'b',bank:'صندوق آزمایشی',initBalance:0}];ST.tx=[];`;
test('quick chips and repetition prepare a new ordinary transaction without copying its source',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`ST.lastAccId='a';ST.tx=[{id:'old',tp:'expense',cat:'e7',a:50,day:1,m:0,y:1404,accId:'a',smsHash:'oldhash',stmtN:'source'}];openQuick()`);
  assert.equal(f.w.document.getElementById('qa-acc').value,'a');
  assert.equal(f.w.document.getElementById('qa-more').open,false);
  const chip=f.w.document.querySelector('#qa-chips [data-cat="e7"]');assert.ok(chip);f.run(`(function(){${chip.getAttribute('onclick')}}).call(document.querySelector('#qa-chips [data-cat="e7"]'))`);assert.equal(f.run('qaCat'),'e7');
  f.run(`openReportRows('expense',0,1404);openTxDetails('old');repeatTransaction('old')`);assert.equal(f.run('ST.tx.length'),1);
  assert.equal(+f.w.document.getElementById('qa-day').value,f.run('today().d'));
  await f.run('qaSave()');assert.equal(f.run('ST.tx.length'),2);
  assert.equal(f.run('ST.tx[1].smsHash'),undefined);assert.equal(f.run('ST.tx[1].stmtN'),undefined);
  assert.equal(f.run('ST.tx[1].a'),50);assert.equal(f.w.document.getElementById('ledgerm').classList.contains('on'),false);
});
test('special payments cannot be repeated and details escape descriptions',async t=>{
  const f=setup(t);await f.boot();f.run(dailyBase+`ST.tx=[{id:'p',tp:'expense',cat:'loan',a:80,day:1,m:0,y:1405,accId:'a',nature:'loanPrincipal',loanId:'l',dsc:'<img src=x onerror=alert(1)>'}];openTxDetails('p')`);
  assert.ok(f.w.document.getElementById('txdetail-repeat').hidden);
  assert.equal(f.w.document.querySelector('#txdetail-body img'),null);
  assert.ok(f.w.document.getElementById('txdetail-body').textContent.includes('<img'));
  f.run(`repeatTransaction('p')`);assert.equal(f.w.document.getElementById('qam').classList.contains('on'),false);
});
test('account ledger keeps signed opening, transfers and valuation, independently of transaction filters',async t=>{
  const f=setup(t);await f.boot();f.run(dailyBase+`ST.accounts[0].archived=true;ST.tx=[
    {id:'o',tp:'expense',cat:'opening',isOpening:true,a:100,accId:'a',day:1,m:0,y:1405,nature:'opening'},
    {id:'x',tp:'income',cat:'transfer',isTransfer:true,a:300,accId:'a',day:2,m:0,y:1405,nature:'transfer'},
    {id:'v',tp:'expense',cat:'revaluation',a:25,accId:'a',day:3,m:0,y:1405,nature:'revaluation'}];
    txFilter='income';txAccFilter='b';openAccountLedger('a')`);
  assert.equal(f.run(`ledgerEntries(ledgerQuery).reduce((n,t)=>n+signedAmount(t),0)`),175);
  assert.equal(f.run(`calcAccBalance('a')`),175);
  assert.equal(f.w.document.querySelectorAll('#ledger-list .txi').length,3);
  assert.match(f.w.document.getElementById('ledger-list').textContent,/تعدیل ارزش دارایی/);
  assert.match(f.w.document.getElementById('ledger-list').textContent,/−/);
});
test('report drilldown excludes non-operating rows, paginates without changing totals and supports yearly categories',async t=>{
  const f=setup(t);await f.boot();f.run(dailyBase+`ST.tx=Array.from({length:90},(_,i)=>({id:'e'+i,tp:'expense',cat:'e7',a:10,accId:'a',day:i%28+1,m:0,y:1405,nature:'operating'}));
    ['opening','transfer','deposit','loanPrincipal','revaluation'].forEach((nature,i)=>ST.tx.push({id:'s'+i,tp:'expense',cat:'e7',a:1000,accId:'a',day:1,m:0,y:1405,nature}));openReportRows('expense',0,1405,'e7')`);
  assert.equal(f.run('ledgerEntries(ledgerQuery).length'),90);
  assert.equal(f.run('totals(ledgerEntries(ledgerQuery)).e'),900);
  assert.equal(f.w.document.querySelectorAll('#ledger-list .txi').length,80);
  assert.equal(f.w.document.getElementById('ledger-more').hidden,false);
  const before=f.w.document.getElementById('ledger-summary').textContent;
  f.run('ledgerLimit+=80;renderLedger()');assert.equal(f.w.document.querySelectorAll('#ledger-list .txi').length,90);
  assert.equal(f.w.document.getElementById('ledger-summary').textContent,before);
  f.run(`openReportRows('expense',null,1405,'e7')`);assert.equal(f.run('ledgerEntries(ledgerQuery).length'),90);
});
test('comparison uses equal elapsed days and crosses the Jalali year correctly',async t=>{
  const f=setup(t);await f.boot();f.run(dailyBase+`today=()=>({y:1405,m:1,d:10});ST.tx=[
    {id:'a1',tp:'expense',a:20,cat:'e7',day:5,m:0,y:1405}, {id:'a2',tp:'expense',a:90,cat:'e7',day:20,m:0,y:1405},
    {id:'b1',tp:'expense',a:15,cat:'e7',day:5,m:11,y:1404}, {id:'b2',tp:'expense',a:70,cat:'e7',day:20,m:11,y:1404}]`);
  assert.deepEqual(copy(f.run('monthComparison(0,1405)')), {prev:{m:11,y:1404},day:10,current:{i:0,e:20,b:-20},previous:{i:0,e:15,b:-15}});
  assert.equal(f.run('monthComparison(11,1404).current.e'),85);
});
test('clear filters resets account, date, type and search together',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`txAccFilter='a';txSearchTerm='test';txFilter='income';txDateFilter='week';renderFilterSummary()`);
  assert.ok(f.w.document.querySelector('#tx-filter-summary button'));
  f.run(f.w.document.querySelector('#tx-filter-summary button').getAttribute('onclick'));
  assert.deepEqual(copy(f.run('[txAccFilter,txSearchTerm,txFilter,txDateFilter]')),['','','all','all']);
});
test('SMS summary displays invalid input honestly and opens uncertain dates for review',async t=>{
  const f=setup(t);await f.boot();f.run(dailyBase+`ST.smsQueue=[{hash:'test',raw:'پیام آزمایشی',p:{keys:[],a:100,tp:'expense',d:{y:1405,m:0,d:2},dateGuessed:true}}];smsqIdx=0;openSmsQueue();document.getElementById('smsq-amt').value='bad';smsCompactSummary()`);
  assert.match(f.w.document.getElementById('smsq-summary').textContent,/مبلغ نیازمند اصلاح/);
  assert.equal(f.w.document.getElementById('smsq-details').open,true);
});
test('monthly budget copy is a draft, save is isolated and survives reopening',async t=>{
  const factory=new IDBFactory(),storage=new Map(),f=setup(t,factory,storage);await f.run('init()');
  f.run(dailyBase+`SM=0;SY=1405;ST.budgets={e7:200};ST.budgetMonths={'1404_11':{e7:300}};openFriendlyBudget();copyPreviousBudget()`);
  assert.equal(f.run('budgetDraft.e7'),300);assert.equal(f.run('budgetsAt().e7'),200);
  f.run('budgetDraft.e7=400');await f.run('saveFriendlyBudget()');
  assert.equal(f.run('budgetsAt(11,1404).e7'),300);assert.equal(f.run('budgetsAt(0,1405).e7'),400);
  const g=setup(t,factory,storage);await g.boot();assert.equal(g.run('budgetsAt(0,1405).e7'),400);
  f.run('openFriendlyBudget();budgetDraft={e7:0}');await f.run('saveFriendlyBudget()');
  assert.deepEqual(copy(f.run('budgetsAt()')),{});
});
const paymentBase=dailyBase+`ST.accounts[0].archived=true;ST.accounts[1].archived=true;
  ST.loans=[{id:'l',n:'وام آزمایشی',remaining:0,active:false,inst:100,day:10}];ST.bankBal={a:{ok:true}};
  ST.tx=[{id:'p',tp:'expense',cat:'loan',a:80,accId:'a',day:2,m:0,y:1405,nature:'loanPrincipal',loanId:'l',installmentId:'g',smsHash:'source'},
  {id:'i',tp:'expense',cat:'e8',a:20,accId:'a',day:2,m:0,y:1405,nature:'operating',loanId:'l',installmentId:'g'}];`;
test('settled loan payment on archived account can be corrected; only interest enters expenses',async t=>{
  const f=setup(t);await f.run('init()');f.run(paymentBase+`editInstallment('l','g')`);
  assert.ok(f.w.document.getElementById('loanpaym').classList.contains('on'));
  assert.equal(f.w.document.getElementById('loanpay-acc').value,'a');
  f.w.document.getElementById('loanpay-amt').value='70';f.w.document.getElementById('loanpay-int').value='10';
  await f.run('saveInstallmentEdit()');
  assert.equal(f.run('ST.loans[0].remaining'),20);assert.equal(f.run('ST.loans[0].active'),true);
  assert.equal(f.run(`calcAccBalance('a')`),-70);assert.equal(f.run('totals(ST.tx).e'),10);
  assert.equal(f.run('ST.bankBal.a.ok'),false);assert.equal(f.run('ST.tx.filter(t=>t.smsHash).length'),1);
  await f.run(`removeInstallment('l','g')`);
  assert.equal(f.run('ST.loans[0].remaining'),80);assert.equal(f.run(`calcAccBalance('a')`),0);assert.equal(f.run('totals(ST.tx).e'),0);
  await f.run('doUndo()');assert.equal(f.run('ST.loans[0].remaining'),20);assert.equal(f.run(`calcAccBalance('a')`),-70);
});
test('invalid installment date or excessive principal leaves payment and debt untouched',async t=>{
  const f=setup(t);await f.run('init()');f.run(paymentBase+`editInstallment('l','g');document.getElementById('loanpay-amt').value='200';document.getElementById('loanpay-int').value='0'`);
  const before=copy(f.run('ST'));await f.run('saveInstallmentEdit()');assert.deepEqual(copy(f.run('ST')),before);
  f.run(`document.getElementById('loanpay-amt').value='50';document.getElementById('loanpay-day').value=''`);
  await f.run('saveInstallmentEdit()');assert.deepEqual(copy(f.run('ST')),before);
});
test('bridge acknowledgment history is truthful, retains failures and strips local source from protocol',async t=>{
  const f=setup(t);await f.boot();f.run(dailyBase+`ST.sarafiOutbox=[{id:'q',sourceTxId:'p',a:50}];ST.tx=[{id:'p',sarafiSent:1}];ghOn=()=>true;ghInboxUpdate=async()=>false`);
  assert.match(f.run(`bridgeStateForTx(ST.tx[0])`),/در صف ارسال/);
  await f.run('flushSarafiOutbox()');assert.equal(f.run('ST.sarafiOutbox.length'),1);assert.equal(f.run('(ST.bridgeLog||[]).length'),0);
  assert.ok(f.run('ST.bridgeErrors.sarafi'));
  f.run(`ghInboxUpdate=async mut=>{const d={items:{}};mut(d);if('sourceTxId' in d.items.q)throw Error('protocol leak');return true}`);
  await f.run('flushSarafiOutbox()');assert.equal(f.run('ST.sarafiOutbox.length'),0);assert.equal(f.run('ST.bridgeLog.length'),1);
  assert.equal(f.run('ST.bridgeErrors.sarafi'),undefined);
  assert.match(f.run(`bridgeStateForTx(ST.tx[0])`),/ثبت نهایی را در مقصد بررسی کنید/);
});
test('investment flow separates principal transfers from revaluation and protection separates local save from backup',async t=>{
  const f=setup(t);await f.boot();f.run(dailyBase+`ST.tx=[{id:'o',accId:'a',tp:'income',a:100,nature:'opening'},
    {id:'t',accId:'a',tp:'income',a:70,nature:'transfer',isTransfer:true},
    {id:'v',accId:'a',tp:'expense',a:5,nature:'revaluation'}]`);
  assert.deepEqual(copy(f.run(`investmentFlows('a')`)),{incoming:70,outgoing:0,revaluation:-5});
  await f.run('sv()');f.run('openProtection()');const text=f.w.document.getElementById('protection-body').textContent;
  assert.match(text,/ذخیره روی دستگاه، پشتیبان خارج از دستگاه نیست/);assert.match(text,/هنوز ثبت نشده/);
});
test('learned SMS review keeps the simple path closed and saves the original source only once',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`ST.smsCatHint={'a|expense':'e7'};ST.smsKeys={known:'a'};
    ST.smsQueue=[{id:'q1',hash:'h1',raw:'فقط متن آزمایشی',sender:'BANK',p:{keys:['known'],bank:'بانک آزمایشی',a:50,tp:'expense',d:{y:1405,m:0,d:2}}}];openSmsQueue()`);
  assert.equal(f.w.document.getElementById('smsq-acc').value,'a');assert.equal(f.w.document.getElementById('smsq-cat').value,'e7');
  assert.equal(f.w.document.getElementById('smsq-details').open,false);
  await f.run('smsqSave()');assert.equal(f.run('ST.smsQueue.length'),0);assert.equal(f.run('ST.tx.length'),1);
  assert.equal(f.run('ST.tx[0].src.raw'),'فقط متن آزمایشی');assert.equal(f.run('ST.tx[0].smsHash'),'h1');
});
test('transfer bridge links the exact local transaction and keeps both financial legs unchanged',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`const eu=sarafiAcc(true);const id=eu.id;
    ST.tx=[{id:'f',tp:'expense',accId:'a',a:100,isTransfer:true,transferId:'g',day:2,m:0,y:1405},
    {id:'t',tp:'income',accId:id,a:100,isTransfer:true,transferId:'g',day:2,m:0,y:1405}];sfPushFromTransfer('a',id,100,{y:1405,m:0,d:2})`);
  assert.equal(f.run('ST.sarafiOutbox[0].sourceTxId'),'f');assert.equal(f.run('ST.tx.filter(t=>t.sarafiSent).length'),2);
  assert.equal(f.run(`calcAccBalance('a')`),-100);assert.equal(f.run('totals(ST.tx).e'),0);
});
test('new optional backup fields reject malformed data and accept valid month-specific plans',async t=>{
  const f=setup(t);await f.boot();assert.throws(()=>f.run(`validateBackup({...def(),budgetMonths:{'1405_12':{e7:50}}})`));
  assert.throws(()=>f.run(`validateBackup({...def(),budgetMonths:{'1405_0':{e7:'bad'}}})`));
  assert.throws(()=>f.run(`validateBackup({...def(),bridgeLog:[{id:'x',target:'unknown',at:1,a:50}]})`));
  assert.doesNotThrow(()=>f.run(`validateBackup({...def(),budgetMonths:{'1405_0':{e7:50}},bridgeLog:[{id:'x',target:'amlak',at:1,a:50}]})`));
});
test('new screens retain unique DOM identifiers and valid inline action syntax',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`rRep();openQuick();openProtection();openBridgeStatus()`);
  const ids=[...f.w.document.querySelectorAll('[id]')].map(n=>n.id),seen=new Set();
  for(const id of ids){assert.equal(seen.has(id),false,'duplicate id '+id);seen.add(id);}
  for(const node of f.w.document.querySelectorAll('*'))for(const a of node.attributes){if(a.name.startsWith('on'))assert.doesNotThrow(()=>new vm.Script('(function(event){'+a.value+'})'),a.name+': '+a.value);}
  assert.equal(f.w.document.querySelectorAll('button button').length,0);
});
