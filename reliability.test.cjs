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

test('simplified screens preserve financial data and keep advanced history accessible',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`ST.accounts[0].archived=true;
    ST.tx=[{id:'p',tp:'income',cat:'s1',a:500,accId:'a',day:2,m:0,y:1405,nature:'operating'}];
    ST.fx=[{id:'historic',status:'done',eur:2,pfee:0,pays:[]}];ST.loans=[{id:'l',n:'آزمایشی',remaining:50,inst:10,day:1}];`);
  const before=copy(f.run('ST'));
  f.run(`rDash();openSetSheet();openProtection()`);await f.run('refreshV1Row()');
  assert.deepEqual(copy(f.run('ST')),before);
  assert.equal(f.w.document.getElementById('settings-advanced').open,false);
  assert.equal(f.w.document.getElementById('settings-reset').open,false);
  assert.equal(f.w.document.getElementById('protection-advanced').open,false);
  assert.notEqual(f.w.document.getElementById('set-fx').style.display,'none');
  f.run(f.w.document.getElementById('set-fx').getAttribute('onclick'));
  assert.equal(f.w.document.getElementById('setm').classList.contains('on'),false);
  assert.equal(f.w.document.getElementById('fxm').classList.contains('on'),true);
  assert.equal(f.run(`calcAccBalance('a')`),500);
});

test('pre-upgrade snapshot remains discoverable, downloadable and restorable after cleanup',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`ST.schemaVersion=1;ST.appName='قبل از ارتقا';ST.tx=[{id:'old',tp:'income',cat:'s1',a:120,accId:'a',day:2,m:0,y:1405}];`);
  const old=copy(f.run('ST'));f.w.__old=old;
  await f.run(`saveSnapshot('state_v1_backup',{savedAt:1,state:__old})`);
  f.run(`ST=migrateState({...ST,appName:'اکنون'});ST.tx.push({id:'new',tp:'expense',cat:'e7',a:20,accId:'a',day:3,m:0,y:1405,nature:'operating'})`);await f.run('sv()');
  f.run('openProtection()');await f.run('refreshV1Row()');
  assert.equal(f.w.document.getElementById('v1-row').style.display,'flex');
  await f.run(f.w.document.getElementById('v1-row').getAttribute('onclick'));
  assert.equal(f.w.document.getElementById('protectionm').classList.contains('on'),false);
  assert.equal(f.w.document.getElementById('v1m').classList.contains('on'),true);
  let downloaded;f.w.__capture=(text)=>{downloaded=JSON.parse(text);return 'shared'};f.run('shareOrDownload=__capture');
  await f.run('downloadV1Backup()');assert.deepEqual(downloaded,old);
  f.w.confirm=()=>false;await f.run('rollbackToV1()');assert.equal(f.run(`calcAccBalance('a')`),100);
  f.w.confirm=()=>true;await f.run('rollbackToV1()');assert.equal(f.run(`calcAccBalance('a')`),120);
  assert.equal(f.run('ST.schemaVersion'),2);assert.equal(f.run('ST.appName'),'قبل از ارتقا');
  assert.deepEqual(copy(await f.run('getV1Backup()')),{savedAt:1,state:old});
  await f.run('undoRestore()');assert.equal(f.run(`calcAccBalance('a')`),100);
});

const reviewQueue=`ST.smsQueue=[{id:'q',hash:'h',raw:'خرید فروشگاه كيان ۱۲۳',sender:'BANK',p:{keys:['bank-key'],bank:'بانک آزمایشی',a:50,tp:'expense',balKnown:true,bal:950,d:{y:1405,m:0,d:2}}}];smsqIdx=0;openSmsQueue();`;
test('explicit SMS dismissal changes only queue and duplicate marker, with targeted undo preserving newer data',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`ST.bankBal={a:{bal:1000,d:{y:1405,m:0,d:1}}};ST.smsKeys={};ST.smsCatHint={};`+reviewQueue);
  const before=copy(f.run('[ST.tx,ST.bankBal,ST.smsKeys,ST.smsCatHint]'));
  assert.equal(await f.run('smsqDiscard()'),'sms-discarded');
  assert.equal(f.run('ST.smsQueue.length'),0);assert.equal(f.run('ST.smsSeen.h.act'),'ignore');
  assert.deepEqual(copy(f.run('[ST.tx,ST.bankBal,ST.smsKeys,ST.smsCatHint]')),before);
  // A new import and an unrelated financial record arrive before Undo.
  f.run(`ST.smsQueue.push({id:'newq',hash:'newh',p:{a:10,d:{y:1405,m:0,d:3},keys:[]},raw:'new'});ST.tx.push({id:'newtx',tp:'income',a:20,cat:'s1',day:3,m:0,y:1405,accId:'a'})`);await f.run('sv()');await f.run('doUndo()');
  assert.equal(f.run('ST.smsQueue.length'),2);assert.equal(f.run('ST.smsQueue[0].id'),'q');
  assert.equal(f.run('ST.tx[0].id'),'newtx');assert.equal(f.run('ST.smsSeen.h'),undefined);
});
test('ignore through the old selector uses targeted undo and a later expense still gets its own undo',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+reviewQueue+`smsqSetTp('ignore')`);
  await f.run('smsqSave()');assert.equal(f.run('typeof __undoAction'),'function');assert.equal(f.run('__undoSnap'),null);
  await f.run('doUndo()');assert.equal(f.run('ST.smsQueue.length'),1);
  await f.run('smsqDiscard()');f.run(`openQuick();qaCatPick('e7');document.getElementById('qa-amt').value='10';document.getElementById('qa-acc').value='a'`);await f.run('qaSave()');
  assert.equal(f.run('ST.tx.length'),1);assert.equal(f.run('__undoAction'),null);await f.run('doUndo()');assert.equal(f.run('ST.tx.length'),0);
  assert.equal(f.run('ST.smsSeen.h.act'),'ignore');
});
test('dismissed SMS is not re-imported and failed save keeps it recoverable',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+String.raw`smsImport('بانک ملی\nبرداشت: 500,000 ریال\nمانده: 9,500,000 ریال\n1405/01/02');openSmsQueue()`);
  assert.equal(f.run('ST.smsQueue.length'),1);await f.run('smsqDiscard()');
  assert.equal(f.run(String.raw`smsImport('بانک ملی\nبرداشت: 500,000 ریال\nمانده: 9,500,000 ریال\n1405/01/02').dup`),1);
  f.run(reviewQueue+`dbWriteState=async()=>{throw Error('disk')};localStorage.setItem=()=>{throw Error('quota')}`);
  await assert.rejects(f.run('smsqDiscard()'));assert.equal(f.run('ST.smsQueue[0].id'),'q');assert.equal(f.run('ST.smsSeen.h'),undefined);
});
test('category rename preserves ids, transactions, budgets, schedules and rules across reopen',async t=>{
  const factory=new IDBFactory(),storage=new Map(),f=setup(t,factory,storage);await f.run('init()');
  f.run(dailyBase+`SM=0;SY=1405;ST.tx=[{id:'e',tp:'expense',cat:'e7',a:50,accId:'a',day:2,m:0,y:1405,nature:'operating'}];ST.budgetMonths={'1405_0':{e7:100}};ST.recurring=[{id:'r',tp:'expense',cat:'e7',amt:50,day:2}];ST.smsRules=[{id:'rule',tp:'expense',cat:'e7',term:'فروشگاه',accId:'a',enabled:true}];openCatMgr('expense');openCat('expense','e7')`);
  assert.equal(f.w.document.getElementById('catmgr').classList.contains('on'),false);assert.equal(f.w.document.getElementById('ctyp').disabled,true);
  const txBefore=copy(f.run('ST.tx'));f.w.document.getElementById('cnm').value='هزینه شخصی';await f.run('saveCat()');
  assert.deepEqual(copy(f.run('ST.tx')),txBefore);assert.equal(f.run('ST.cats.expense.find(c=>c.id===\'e7\').n'),'هزینه شخصی');
  assert.equal(f.run('ST.budgetMonths[\'1405_0\'].e7'),100);assert.equal(f.run('ST.recurring[0].cat'),'e7');assert.equal(f.run('ST.smsRules[0].cat'),'e7');
  f.run(`openReportRows('expense',0,1405,'e7');openTxDetails('e')`);
  assert.match(f.w.document.getElementById('ledger-title').textContent,/هزینه شخصی/);assert.match(f.w.document.getElementById('txdetail-body').textContent,/هزینه شخصی/);
  const g=setup(t,factory,storage);await g.run('init()');assert.equal(g.run(`getCat('expense','e7').n`),'هزینه شخصی');assert.equal(g.run(`calcAccBalance('a')`),-50);
});
test('renaming rent and profit categories preserves semantics and statement imports resolve previous names',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`openCat('income','s2');document.getElementById('cnm').value='دریافتی ملک'`);await f.run('saveCat()');
  assert.equal(f.run(`categoryRole(getCat('income','s2'),'rent')`),true);
  f.run(`openQuick();qaTp('income');qaCatPick('s2')`);assert.equal(f.w.document.getElementById('qa-amlakw').style.display,'flex');
  assert.equal(f.run(`stmtCat(ST,'income','اجاره آپارتمان')`),'s2');
  f.run(`openCat('income','s4');document.getElementById('cnm').value='بازده دریافتی'`);await f.run('saveCat()');assert.equal(f.run(`categoryRole(getCat('income','s4'),'profit')`),true);
  // An ordinary category called 'rent' must not silently change accounting role after a rename.
  f.run(`openCat('income','s1');document.getElementById('cnm').value='اجاره نام نمایشی'`);await f.run('saveCat()');assert.equal(f.run(`categoryRole(getCat('income','s1'),'rent')`),false);
});
test('category validation rejects empty or duplicate names, blocks deleting used categories and cancellation is read-only',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`ST.tx=[{id:'e',tp:'expense',cat:'e7',a:50,day:2,m:0,y:1405}];openCat('expense','e7');document.getElementById('cnm').value=' '`);
  const before=copy(f.run('ST'));await f.run('saveCat()');assert.deepEqual(copy(f.run('ST')),before);
  f.run(`document.getElementById('cnm').value=ST.cats.expense[0].n`);await f.run('saveCat()');assert.deepEqual(copy(f.run('ST')),before);
  await f.run(`delCat('expense','e7')`);assert.deepEqual(copy(f.run('ST')),before);
  f.run(`document.getElementById('cnm').value='تغییر لغوشده';cancelCatEditor()`);assert.deepEqual(copy(f.run('ST')),before);
});
const sampleRules=`ST.smsRules=[{id:'r',tp:'expense',cat:'e2',term:'فروشگاه کیان 123',accId:'a',enabled:true}];`;
test('literal SMS rules normalize Persian and Arabic, respect account and type, and only propose categories',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+sampleRules+`ST.smsKeys={'bank-key':'a'};ST.smsCatHint={'a|expense':'e7'};`+reviewQueue);
  assert.equal(f.w.document.getElementById('smsq-cat').value,'e2');assert.match(f.w.document.getElementById('smsq-cat-suggestion').textContent,/پیشنهاد قاعده/);
  assert.equal(f.run('ST.tx.length'),0);assert.equal(f.run(`smsCategorySuggestion(ST.smsQueue[0],'expense','b').cat`),'');assert.equal(f.run(`smsCategorySuggestion(ST.smsQueue[0],'income','a').cat`),'');
  f.run(`document.getElementById('smsq-cat').value='e7'`);await f.run('smsqSave()');assert.equal(f.run('ST.tx[0].cat'),'e7');assert.equal(f.run('ST.smsRules[0].cat'),'e2');
});
test('conflicting rules require explicit choice; disabled rules stop suggesting; ordinary account hint remains a fallback',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+sampleRules+`ST.smsRules.push({id:'r2',tp:'expense',cat:'e5',term:'فروشگاه',accId:'',enabled:true});ST.smsKeys={'bank-key':'a'};ST.smsCatHint={'a|expense':'e7'};`+reviewQueue);
  assert.equal(f.w.document.getElementById('smsq-cat').value,'');assert.match(f.w.document.getElementById('smsq-cat-suggestion').textContent,/چند قاعده/);
  await f.run('smsqSave()');assert.equal(f.run('ST.tx.length'),0);
  f.run(`ST.smsRules[1].enabled=false;smsqSetTp('expense')`);assert.equal(f.w.document.getElementById('smsq-cat').value,'e2');
  f.run(`ST.smsRules[0].enabled=false;smsqSetTp('expense')`);assert.equal(f.w.document.getElementById('smsq-cat').value,'e7');
});
test('rule editor supports save, edit, disable and delete, persists and never changes existing transactions',async t=>{
  const factory=new IDBFactory(),storage=new Map(),f=setup(t,factory,storage);await f.run('init()');
  f.run(dailyBase+`openSmsRules('expense');document.getElementById('smsrule-term').value='فروشگاه';document.getElementById('smsrule-acc').value='a';document.getElementById('smsrule-cat').value='e2'`);await f.run('saveSmsRule()');assert.equal(f.run('ST.smsRules.length'),1);
  const g=setup(t,factory,storage);await g.run('init()');assert.equal(g.run('ST.smsRules[0].term'),'فروشگاه');
  f.run(`editSmsRule(ST.smsRules[0].id);document.getElementById('smsrule-cat').value='e5'`);await f.run('saveSmsRule()');assert.equal(f.run('ST.smsRules[0].cat'),'e5');
  await f.run('toggleSmsRule(ST.smsRules[0].id)');assert.equal(f.run('ST.smsRules[0].enabled'),false);
  await f.run('deleteSmsRule(ST.smsRules[0].id)');assert.equal(f.run('ST.smsRules.length'),0);assert.equal(f.run('ST.tx.length'),0);
});
test('rule editor rejects malformed and duplicate rules and safely displays HTML-like text',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`openSmsRules('expense');document.getElementById('smsrule-term').value='از';document.getElementById('smsrule-cat').value='e2'`);await f.run('saveSmsRule()');assert.equal(f.run('ST.smsRules.length'),0);
  f.run(`document.getElementById('smsrule-term').value='<img src=x onerror=alert(1)>'`);await f.run('saveSmsRule()');assert.equal(f.run('ST.smsRules.length'),1);assert.equal(f.w.document.querySelector('#smsrule-list img'),null);
  f.run(`document.getElementById('smsrule-term').value='<img src=x onerror=alert(1)>';document.getElementById('smsrule-cat').value='e5'`);await f.run('saveSmsRule()');assert.equal(f.run('ST.smsRules.length'),1);assert.match(f.w.document.getElementById('smsrule-msg').textContent,/وجود دارد/);
});
test('rule screen retains SMS amount and notes, and new fields survive backup restore without breaking older backups',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+`ST.smsKeys={'bank-key':'a'};`+reviewQueue+`document.getElementById('smsq-amt').value='75';document.getElementById('smsq-dsc').value='یادداشت';document.getElementById('smsq-cat').value='e5';openSmsRules('expense',true);closeSmsRules()`);
  assert.equal(f.w.document.getElementById('smsq-amt').value,'75');assert.equal(f.w.document.getElementById('smsq-dsc').value,'یادداشت');assert.equal(f.w.document.getElementById('smsq-cat').value,'e5');
  f.run(sampleRules);const backup=copy(f.run('ST'));f.w.__backup=backup;await f.run('applyBackupObject(__backup)');assert.equal(f.run('ST.smsRules[0].id'),'r');
  const old=copy(f.run('def()'));delete old.smsRules;f.w.__backup=old;await f.run('applyBackupObject(__backup)');assert.deepEqual(copy(f.run('ST.smsRules')),[]);
  assert.throws(()=>f.run(`validateBackup({...def(),smsRules:[{id:'x',tp:'expense',cat:'missing',term:'term',accId:'',enabled:true}]})`));
  assert.throws(()=>f.run(`validateBackup({...def(),smsRules:'bad'})`));
});
test('double tap on discard removes only the displayed SMS while storage is pending',async t=>{
  const f=setup(t);await f.run('init()');f.run(dailyBase+reviewQueue+`ST.smsQueue.push({...ST.smsQueue[0],id:'second',hash:'secondhash'})`);
  let release;f.w.__hold=()=>new Promise(resolve=>release=resolve);f.run('const originalSave=sv;sv=__hold');
  const first=f.run('smsqDiscard()');await f.run('smsqDiscard()');assert.equal(f.run('ST.smsQueue.length'),1);assert.equal(f.run('ST.smsQueue[0].id'),'second');
  release();await first;f.run('sv=originalSave');await f.run('sv()');
  await f.run('doUndo()');assert.equal(f.run('ST.smsQueue.length'),2);
});

const scheduledLoanBase=dailyBase+`today=()=>({y:1405,m:2,d:20,wd:'آزمایشی'});SM=1;SY=1405;ST.notifLog=[];ST.smsAuditDone=true;ST.loans=[{id:'l',n:'وام نمونه',remaining:1000,principalTotal:1000,total:1000,inst:100,day:10,defaultInterest:0,active:true}];upsertOpeningTx(ST.accounts[0],2000);`;
async function configureLoan(f,month=1,day=10,year=1405){
  f.run(`openLoanSchedule('l');document.getElementById('loan-start-year').value='${year}';fillMon('loan-start-mon',${month});document.getElementById('loan-start-day').value='${day}'`);
  await f.run('saveLoanSchedule()');assert.ok(f.run('Array.isArray(ST.loans[0].schedule)'));
}
async function payLoan(f,amount,interest=0,month=1,day=5,multi=false,index=0){
  f.run(`payInstallment('l',false,'',ST.loans[0].schedule[${index}].id);document.getElementById('loanpay-amt').value='${amount}';document.getElementById('loanpay-int').value='${interest}';document.getElementById('loanpay-acc').value='a';fillMon('loanpay-mon',${month});document.getElementById('loanpay-day').value='${day}';document.getElementById('loanpay-yr').value='1405';document.getElementById('loanpay-multi').checked=${multi}`);
  await f.run('confirmPayInstallment()');
}
test('legacy loan requests explicit tracking start; configuring a schedule never changes cash or existing debt',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`rDash()`);
  assert.match(f.w.document.getElementById('dashTodo').textContent,/تعیین اولین قسط/);
  const before=copy(f.run('[ST.tx,ST.loans[0].remaining]'));await configureLoan(f);
  assert.deepEqual(copy(f.run('[ST.tx,ST.loans[0].remaining]')),before);
  assert.equal(f.run('ST.loans[0].schedule.length'),10);assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),100);
});
test('late entry with a previous-month payment settles the selected current-month due and posts interest on actual date',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.loans[0].defaultInterest=20`);await configureLoan(f);
  await payLoan(f,100,20,0,25);
  assert.equal(f.run('loanDueItems(ST.loans[0])[0].status'),'paid');assert.equal(f.run('loanDueItems(ST.loans[0]).filter(s=>s.isDue).length'),0);
  assert.equal(f.run(`calcAccBalance('a')`),1900);assert.equal(f.run('ST.loans[0].remaining'),920);
  assert.equal(f.run('totals(getTx(0,1405)).e'),20);assert.equal(f.run('totals(getTx(1,1405)).e'),0);
  assert.equal(f.run("loanInstallments('l')[0].m"),0);assert.equal(f.run("loanGroupAllocations(loanInstallments('l')[0])[0].dueId"),f.run('ST.loans[0].schedule[0].id'));
});
test('partial payments retain reminder until total is covered; old notification becomes resolved and never duplicates daily',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f);await f.run('chkLoansDue()');
  assert.equal(f.run('ST.notifLog.length'),1);await payLoan(f,25);
  assert.equal(f.run('loanDueItems(ST.loans[0])[0].status'),'partial');assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),75);
  assert.equal(f.run('loanNoticeActive(ST.notifLog[0])'),true);assert.match(f.w.document.getElementById('dashTodo').textContent,/قسط نیازمند پرداخت/);
  await payLoan(f,75);assert.equal(f.run('loanDueItems(ST.loans[0])[0].status'),'paid');assert.equal(f.run('ST.loans[0].remaining'),900);
  assert.equal(f.run('loanNoticeActive(ST.notifLog[0])'),false);f.run('openNotifPanel()');assert.match(f.w.document.getElementById('notif-panel-list').textContent,/پرداخت‌شده/);
  f.run(`today=()=>({y:1405,m:2,d:21,wd:'آزمایشی'})`);await f.run('chkLoansDue()');assert.equal(f.run('ST.notifLog.length'),1);
});
test('one payment can cover multiple dues only with explicit multi-period selection',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f);
  await payLoan(f,250,0,1,5,false);assert.equal(f.run('ST.loans[0].remaining'),1000);
  await payLoan(f,250,0,1,5,true);assert.deepEqual(copy(f.run('loanDueItems(ST.loans[0]).slice(0,3).map(s=>s.left)')),[0,0,50]);
  assert.equal(f.run('ST.loans[0].remaining'),750);assert.equal(f.run("loanGroupAllocations(loanInstallments('l')[0]).length"),3);
});
test('payment correction and deletion reopen only their allocated dues, update notices and support undo',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f);await f.run('chkLoansDue()');await payLoan(f,100);
  f.run(`editInstallment('l',loanInstallments('l')[0].id);document.getElementById('loanpay-amt').value='40'`);await f.run('saveInstallmentEdit()');
  assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),60);assert.equal(f.run('ST.loans[0].remaining'),960);assert.equal(f.run('loanNoticeActive(ST.notifLog[0])'),true);
  await f.run(`removeInstallment('l',loanInstallments('l')[0].id)`);assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),100);assert.equal(f.run(`calcAccBalance('a')`),2000);
  await f.run('doUndo()');assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),60);assert.equal(f.run('ST.loans[0].remaining'),960);
});
test('an already-recorded debit is reclassified as principal and interest without debiting cash twice; detach restores it',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.loans[0].defaultInterest=20;ST.tx.push({id:'bank',tp:'expense',cat:'e7',a:100,accId:'a',day:25,m:0,y:1405,nature:'operating',smsHash:'bankhash',src:{k:'sms',raw:'آزمایشی'}})`);await configureLoan(f);
  f.run(`payInstallment('l');document.getElementById('loanpay-existing').value='bank';chooseLoanExisting();document.getElementById('loanpay-int').value='20'`);await f.run('confirmPayInstallment()');
  assert.equal(f.run(`calcAccBalance('a')`),1900);assert.equal(f.run('ST.loans[0].remaining'),920);assert.equal(f.run('totals(ST.tx).e'),20);
  assert.equal(f.run(`ST.tx.find(t=>t.id==='bank').smsHash`),'bankhash');assert.equal(f.run('ST.tx.filter(t=>t.loanOriginalTx).length'),1);
  await f.run(`removeInstallment('l',loanInstallments('l')[0].id)`);assert.equal(f.run(`calcAccBalance('a')`),1900);assert.equal(f.run('ST.loans[0].remaining'),1000);assert.equal(f.run('totals(ST.tx).e'),100);
  await f.run('doUndo()');assert.equal(f.run('ST.loans[0].remaining'),920);assert.equal(f.run('totals(ST.tx).e'),20);
});
test('setup can explicitly allocate previous receipts without reposting cash or reducing principal again',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.loans[0].remaining=900;ST.tx.push({id:'oldpayment',tp:'expense',cat:'loan',nature:'loanPrincipal',loanId:'l',installmentId:'oldgroup',a:100,accId:'a',day:25,m:0,y:1405});openLoanSchedule('l');fillMon('loan-start-mon',1);document.getElementById('loan-start-day').value='10';document.getElementById('loan-start-year').value='1405'`);
  const cash=f.run(`calcAccBalance('a')`);f.w.document.querySelector('[name="loan-include-payment"]').checked=true;await f.run('saveLoanSchedule()');
  assert.equal(f.run('ST.loans[0].remaining'),900);assert.equal(f.run(`calcAccBalance('a')`),cash);assert.equal(f.run('ST.loans[0].schedule.length'),10);assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),0);
});
test('SMS loan payment uses selected due and can attach an exact existing debit without duplication',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.tx.push({id:'bank',tp:'expense',cat:'e7',a:50,accId:'a',day:2,m:0,y:1405,nature:'operating'});ST.smsKeys={'bank-key':'a'};`);await configureLoan(f);
  f.run(reviewQueue+`smsqSetTp('loan');document.getElementById('smsq-int').value='0';document.getElementById('smsq-loan-existing').value='bank'`);await f.run('smsqSave()');
  assert.equal(f.run('ST.smsQueue.length'),0);assert.equal(f.run(`calcAccBalance('a')`),1950);assert.equal(f.run('ST.loans[0].remaining'),950);assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),50);assert.equal(f.run('totals(ST.tx).e'),0);
});
test('schedule clamps month lengths, validates edits, and never changes receipts when a due date moves',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f,5,31);
  assert.equal(f.run('ST.loans[0].schedule[1].day'),30);assert.equal(f.run('ST.loans[0].schedule[6].day'),f.run('jMaxDay(11,1405)'));
  await payLoan(f,100,0,5,20);const rows=copy(f.run('ST.tx'));
  f.run(`openLoanSchedule('l');editScheduleItem(ST.loans[0].schedule[0].id);document.getElementById('due-edit-amount').value='50'`);await f.run('saveScheduleItem()');assert.equal(f.run('ST.loans[0].schedule[0].a'),100);
  f.run(`document.getElementById('due-edit-amount').value='100';document.getElementById('due-edit-day').value='29'`);await f.run('saveScheduleItem()');assert.deepEqual(copy(f.run('ST.tx')),rows);assert.equal(f.run('ST.loans[0].schedule[0].day'),29);
});
test('interest-only receipt can settle a fee due without changing principal, including edit to a split receipt',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.loans[0].schedule=[{id:'fee',y:1405,m:1,day:10,a:20,interest:20}];ST.loans[0].remaining=0;ST.loans[0].active=false;`);
  await payLoan(f,20,20);assert.equal(f.run('ST.loans[0].remaining'),0);assert.equal(f.run('loanDueItems(ST.loans[0])[0].status'),'paid');assert.equal(f.run('totals(ST.tx).e'),20);
  f.run(`ST.loans[0].remaining=10;editInstallment('l',loanInstallments('l')[0].id);document.getElementById('loanpay-int').value='10'`);await f.run('saveInstallmentEdit()');assert.equal(f.run('new Set(ST.tx.map(t=>t.id)).size'),f.run('ST.tx.length'));
});
test('schedule and allocations survive reopen and backup, rejecting malformed or overallocated input',async t=>{
  const factory=new IDBFactory(),storage=new Map(),f=setup(t,factory,storage);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f);await payLoan(f,100);
  assert.doesNotThrow(()=>f.run('validateBackup(ST)'));const g=setup(t,factory,storage);await g.run('init()');assert.equal(g.run('loanDueItems(ST.loans[0])[0].status'),'paid');
  const backup=copy(f.run('ST'));f.w.__loanbackup=backup;await f.run('applyBackupObject(__loanbackup)');assert.equal(f.run('loanDueItems(ST.loans[0])[0].status'),'paid');
  assert.throws(()=>f.run(`validateBackup({...ST,loans:ST.loans.map(l=>({...l,schedule:[{id:'x',y:1405,m:11,day:31,a:100,interest:0}]}))})`));
  assert.throws(()=>f.run(`validateBackup({...ST,tx:ST.tx.map(t=>t.dueAllocations?{...t,dueAllocations:[{dueId:ST.loans[0].schedule[0].id,a:200}]}:t)})`));
});
test('rapid repeated manual payment cannot consume the next installment while save is pending',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f);f.run(`payInstallment('l');document.getElementById('loanpay-amt').value='100';document.getElementById('loanpay-int').value='0'`);
  let release;f.w.__hold=()=>new Promise(resolve=>release=resolve);f.run('const loanRealSave=sv;sv=__hold');const first=f.run('confirmPayInstallment()');await f.run('confirmPayInstallment()');assert.equal(f.run('ST.loans[0].remaining'),900);release();await first;f.run('sv=loanRealSave');await f.run('sv()');assert.equal(f.run("loanInstallments('l').length"),1);
});
test('a second partial payment requires actual interest rather than charging the full default interest again',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.loans[0].defaultInterest=20`);await configureLoan(f);await payLoan(f,25,20);
  f.run(`payInstallment('l')`);assert.equal(f.w.document.getElementById('loanpay-int').value,'');const before=f.run('ST.loans[0].remaining');await f.run('confirmPayInstallment()');assert.equal(f.run('ST.loans[0].remaining'),before);
  f.run(`document.getElementById('loanpay-int').value='0'`);await f.run('confirmPayInstallment()');assert.equal(f.run('ST.loans[0].remaining'),920);assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),0);
});
test('SMS loan submit is single-flight and cannot post the next queued SMS while storage is pending',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.smsKeys={'bank-key':'a'};`);await configureLoan(f);
  f.run(reviewQueue+`ST.smsQueue.push({...ST.smsQueue[0],id:'next',hash:'next-hash'});smsqSetTp('loan');document.getElementById('smsq-int').value='0'`);
  let release;f.w.__hold=()=>new Promise(resolve=>release=resolve);f.run('const smsLoanSave=sv;sv=__hold');const first=f.run('smsqSave()');await f.run('smsqSave()');assert.equal(f.run('ST.loans[0].remaining'),950);assert.equal(f.run('ST.smsQueue.length'),1);release();await first;f.run('sv=smsLoanSave');await f.run('sv()');
});
test('linked receipt backup validates and retains the original account and category for safe detach',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.tx.push({id:'debit',tp:'expense',cat:'e7',a:100,accId:'a',day:2,m:0,y:1405,nature:'operating'})`);await configureLoan(f);
  f.run(`payInstallment('l');document.getElementById('loanpay-existing').value='debit';chooseLoanExisting();document.getElementById('loanpay-int').value='0'`);await f.run('confirmPayInstallment()');
  assert.doesNotThrow(()=>f.run('validateBackup(ST)'));assert.equal(f.run(`categoryInUse('expense','e7')`),true);
  const backup=copy(f.run('ST'));f.w.__linkedBackup=backup;await f.run('applyBackupObject(__linkedBackup)');await f.run(`removeInstallment('l',loanInstallments('l')[0].id)`);assert.equal(f.run(`ST.tx.find(t=>t.id==='debit').cat`),'e7');assert.equal(f.run('ST.loans[0].remaining'),1000);
});
test('statement re-import matches a loan receipt as one bank debit without rewriting principal or interest',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.loans[0].defaultInterest=20`);await configureLoan(f);await payLoan(f,100,20);
  f.run(`STI={mainId:'a',choice:{},keepOrphan:{},fix:true,pkg:{bank:'آزمایشی',acctNo:'test',period:{from:{y:1405,m:1,d:1},to:{y:1405,m:1,d:30}},opening:{y:1405,m:0,d:1,a:2000},closing:1900,accounts:{},rows:[{n:1,dir:'out',a:100,date:{y:1405,m:1,d:5},nature:'operating',tp:'expense',cat:'متفرقه'}]}}`);
  const receipt=copy(f.run('ST.tx.filter(t=>t.loanId)')),result=f.run('stmtBuild()');assert.equal(result.err,undefined);assert.equal(result.st.diff,0);assert.equal(result.st.created,0);
  assert.deepEqual(copy(result.S.tx.filter(t=>t.loanId).map(t=>({a:t.a,nature:t.nature}))),receipt.map(t=>({a:t.a,nature:t.nature})));
  f.w.__statementState=copy(result.S);f.run('ST=__statementState');assert.equal(f.run('totals(ST.tx).e'),20);assert.equal(f.run('ST.loans[0].remaining'),920);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
  f.run('STI.pkg.rows[0].a=101');const mismatch=f.run('stmtBuild()');assert.ok(mismatch.err);assert.equal(mismatch.S,null);
});
test('SMS can acknowledge an already-recorded loan receipt without paying the next due or withdrawing twice',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`ST.smsKeys={'bank-key':'a'};`);await configureLoan(f);await payLoan(f,100);
  f.run(`ST.smsQueue=[{id:'bank-q',hash:'bank-h',raw:'پیام آزمایشی قسط',p:{keys:['bank-key'],a:100,tp:'expense',d:{y:1405,m:1,d:5}}}];smsqIdx=0;openSmsQueue();smsqSetTp('loan');document.getElementById('smsq-loan-existing').value='payment:'+loanInstallments('l')[0].id`);
  const before=copy(f.run('[calcAccBalance(\'a\'),ST.loans[0].remaining,loanDueItems(ST.loans[0]).map(s=>s.left)]'));await f.run('smsqSave()');
  assert.deepEqual(copy(f.run('[calcAccBalance(\'a\'),ST.loans[0].remaining,loanDueItems(ST.loans[0]).map(s=>s.left)]')),before);assert.equal(f.run('ST.smsSeen[\'bank-h\'].act'),'loan-linked');assert.equal(f.run("loanInstallments('l').length"),1);
});
test('loan with financial payment history cannot be deleted and orphan its principal or linked source',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f);await payLoan(f,100);const before=copy(f.run('ST'));f.run(`eLoanId='l'`);await f.run('delLoan()');assert.deepEqual(copy(f.run('ST')),before);
});
test('returning from background refreshes dues after a date change without clearing a payment form',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase+`today=()=>({y:1405,m:2,d:5,wd:'آزمایشی'})`);await configureLoan(f);f.run(`payInstallment('l');document.getElementById('loanpay-amt').value='45';today=()=>({y:1405,m:2,d:20,wd:'آزمایشی'})`);
  Object.defineProperty(f.w.document,'visibilityState',{value:'visible',configurable:true});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));await f.run('saveQueue');
  assert.match(f.w.document.getElementById('dashTodo').textContent,/قسط نیازمند پرداخت/);assert.equal(f.w.document.getElementById('loanpay-amt').value,'45');assert.equal(f.run('ST.notifLog.filter(n=>n.type===\'loan\').length'),1);
});

// Synthetic loans only: no real user names, amounts or contract data.
async function simpleLoan(t,values={},factory=new IDBFactory(),storage=new Map()){
  const f=setup(t,factory,storage);await f.run('init()');f.run(dailyBase+`ST.loans=[];ST.notifLog=[];today=()=>({y:1405,m:2,d:20,wd:'آزمایشی'});SM=1;SY=1405;upsertOpeningTx(ST.accounts[0],2000);openLoanForm();`);
  const fields={'loan-n':'وام آزمایشی','loan-left-count':'2','loan-paid-count':'3','loan-total-count':'5','loan-simple-amount':'100','loan-simple-day':'10','loan-simple-year':'1405',...values};
  for(const [id,value] of Object.entries(fields))f.w.document.getElementById(id).value=value;
  f.run("fillMon('loan-simple-mon',1);loanKindChanged()");await f.run('saveLoan()');
  if(f.run('ST.loans.length'))f.run("ST.tx.forEach(t=>{if(t.loanId===ST.loans[0].id)t.loanId='l'});ST.loans[0].id='l'");
  return f;
}
test('existing-loan count entry builds numbered monthly dues without posting past payments or inventing principal',async t=>{
  const f=await simpleLoan(t);
  assert.equal(f.run('ST.loans.length'),1);assert.equal(f.run('ST.loans[0].trackingMode'),'simple');
  assert.deepEqual(copy(f.run('ST.loans[0].schedule.map(s=>s.number)')),[4,5]);
  assert.equal(f.run("calcAccBalance('a')"),2000);assert.equal(f.run('ST.tx.filter(t=>t.loanId).length'),0);assert.equal(f.run('loansDebt()'),0);
  f.run('NW_SHOW=true;rDash();openLoanList()');assert.match(f.w.document.getElementById('home-assets-total').textContent,/نامشخص/);assert.equal(f.run('activeLoans().length'),1);
  assert.match(f.w.document.getElementById('loan-list').textContent,/۲ قسط باقی/);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
});
test('unknown historical total remains unknown; supplying total alone safely derives already-paid count',async t=>{
  const f=await simpleLoan(t,{'loan-total-count':'','loan-paid-count':''});assert.equal(f.run('ST.loans[0].totalInstallments'),null);assert.equal(f.run('ST.loans[0].paidBefore'),null);assert.equal(f.run('ST.loans[0].schedule[0].number'),undefined);
  const g=await simpleLoan(t,{'loan-total-count':'5','loan-paid-count':''});assert.equal(g.run('ST.loans[0].paidBefore'),3);
});
test('inconsistent counts, fractions, unsafe totals and invalid Jalali dates never mutate state',async t=>{
  const f=await simpleLoan(t,{'loan-total-count':'6'});assert.equal(f.run('ST.loans.length'),0);
  for(const value of ['1.5','-2','0','601','9007199254740992','abc']){
    f.w.document.getElementById('loan-left-count').value=value;await f.run('saveLoan()');assert.equal(f.run('ST.loans.length'),0,value);
  }
  f.run("document.getElementById('loan-left-count').value='2';document.getElementById('loan-total-count').value='5';fillMon('loan-simple-mon',11);document.getElementById('loan-simple-day').value='31'");await f.run('saveLoan()');assert.equal(f.run('ST.loans.length'),0);
  f.run("fillMon('loan-simple-mon',1);document.getElementById('loan-simple-day').value='10';document.getElementById('loan-simple-amount').value='9007199254740991'");await f.run('saveLoan()');assert.equal(f.run('ST.loans.length'),0);
});
test('Persian and Arabic digits work for counts, money and Jalali date fields',async t=>{
  const f=await simpleLoan(t,{'loan-left-count':'۲','loan-paid-count':'٣','loan-total-count':'۵','loan-simple-amount':'۱۰۰','loan-simple-day':'۱۰','loan-simple-year':'۱۴۰۵'});
  assert.equal(f.run('ST.loans[0].schedule[0].a'),100);assert.equal(f.run('ST.loans[0].paidBefore'),3);
});
test('late entry settles selected due, clears its reminder and reports unknown split separately on actual payment date',async t=>{
  const f=await simpleLoan(t);await f.run('chkLoansDue()');assert.equal(f.run('loanNoticeActive(ST.notifLog[0])'),true);
  await payLoan(f,100,0,0,25);
  assert.equal(f.run('loanDueItems(ST.loans[0])[0].status'),'paid');assert.equal(f.run('loanNoticeActive(ST.notifLog[0])'),false);
  assert.equal(f.run("calcAccBalance('a')"),1900);assert.equal(f.run('loansDebt()'),0);assert.equal(f.run('totals(ST.tx).e'),0);
  assert.equal(f.run("loanInstallments('l')[0].unsplit"),100);assert.equal(f.run("ST.tx.find(t=>t.loanId).nature"),'loanUnsplit');
  f.run('SM=0;rRep();openUnsplitLoanRows()');assert.match(f.w.document.getElementById('ys').textContent,/اقساط بدون تفکیک/);assert.match(f.w.document.getElementById('home-month-net').textContent,/مازاد درآمد/);assert.match(f.w.document.getElementById('report-overview').textContent,/۱۰۰ تومان/);assert.match(f.w.document.getElementById('ledger-summary').textContent,/۱۰۰ تومان/);
  assert.equal(f.run("ledgerEntries({mode:'loanUnsplit',m:0,y:1405}).length"),1);
  f.run("openTxDetails(ST.tx.find(t=>t.loanId).id)");assert.match(f.w.document.getElementById('txdetail-body').textContent,/اصل و سود مشخص نیست/);
});
test('partial and multi-due simple payments, correction, deletion and undo affect only chosen dues and cash',async t=>{
  const f=await simpleLoan(t);await payLoan(f,40);assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),60);
  f.run("editInstallment('l',loanInstallments('l')[0].id);document.getElementById('loanpay-amt').value='25'");await f.run('saveInstallmentEdit()');assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),75);assert.equal(f.run("calcAccBalance('a')"),1975);
  await f.run("removeInstallment('l',loanInstallments('l')[0].id)");assert.equal(f.run("calcAccBalance('a')"),2000);await f.run('doUndo()');assert.equal(f.run("calcAccBalance('a')"),1975);
  await payLoan(f,175,0,1,5,false);assert.equal(f.run("calcAccBalance('a')"),1975);
  await payLoan(f,175,0,1,5,true);assert.equal(f.run("calcAccBalance('a')"),1800);assert.equal(f.run('activeLoans().length'),0);assert.equal(f.run('hasUnknownLoanDebt()'),false);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
});
test('attaching an ordinary debit to a simple installment never withdraws twice, and detach restores original classification',async t=>{
  const f=await simpleLoan(t);f.run("ST.tx.push({id:'debit-simple',tp:'expense',cat:'e7',nature:'operating',a:100,accId:'a',day:25,m:0,y:1405});payInstallment('l');document.getElementById('loanpay-existing').value='debit-simple';chooseLoanExisting()");await f.run('confirmPayInstallment()');
  assert.equal(f.run("calcAccBalance('a')"),1900);assert.equal(f.run('totals(ST.tx).e'),0);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
  await f.run("removeInstallment('l',loanInstallments('l')[0].id)");assert.equal(f.run("calcAccBalance('a')"),1900);assert.equal(f.run('totals(ST.tx).e'),100);assert.equal(f.run('loanDueItems(ST.loans[0])[0].left'),100);
});
test('new loan requires receipt information, records optional dated deposit once and does not count it as income',async t=>{
  const f=await simpleLoan(t,{'loan-kind':'new','loan-total-count':'2','loan-received-amount':'150','loan-received-day':'1','loan-received-year':'1405','loan-received-acc':'a'});
  assert.equal(f.run('ST.loans.length'),1);assert.equal(f.run('ST.loans[0].entryKind'),'new');assert.equal(f.run('ST.loans[0].paidBefore'),0);assert.equal(f.run("calcAccBalance('a')"),2150);assert.equal(f.run('totals(ST.tx).i'),0);
  assert.equal(f.run('ST.tx.find(t=>t.loanId).day'),1);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
  f.run("openLoanForm('l');document.getElementById('loan-n').value='نام اصلاح‌شده'");await f.run('saveLoan()');assert.equal(f.run("calcAccBalance('a')"),2150);assert.equal(f.run('ST.tx.filter(t=>t.loanId).length'),1);
  await f.run("eLoanId='l';delLoan()");assert.equal(f.run("calcAccBalance('a')"),2000);
});
test('new-loan receipt already reflected in balances creates no duplicate deposit; invalid/missing receipt blocks creation',async t=>{
  const f=await simpleLoan(t,{'loan-kind':'new','loan-total-count':'2','loan-received-amount':'150','loan-received-day':'1','loan-received-year':'1405'});assert.equal(f.run("calcAccBalance('a')"),2000);assert.equal(f.run('ST.tx.filter(t=>t.loanId).length'),0);
  const g=await simpleLoan(t,{'loan-kind':'new','loan-total-count':'2','loan-received-amount':''});assert.equal(g.run('ST.loans.length'),0);
  g.run("document.getElementById('loan-received-amount').value='300'");await g.run('saveLoan()');assert.equal(g.run('ST.loans.length'),0);
  g.run("document.getElementById('loan-received-amount').value='150';document.getElementById('loan-received-day').value='21'");await g.run('saveLoan()');assert.equal(g.run('ST.loans.length'),0);
});
test('simple form exposes standard relevant fields, keeps optional details optional and prevents accidental schedule replacement',async t=>{
  const f=await simpleLoan(t);f.run("openLoanForm('l')");assert.equal(f.w.document.getElementById('loan-simple-fields').hidden,false);assert.equal(f.w.document.getElementById('loan-advanced-fields').hidden,true);
  assert.equal(f.w.document.getElementById('loan-simple-amount').disabled,true);assert.equal(f.w.document.getElementById('loan-new-receipt').hidden,true);
  const plan=copy(f.run('ST.loans[0].schedule'));f.run("document.getElementById('loan-left-count').value='99';document.getElementById('loan-n').value='نام تازه'");await f.run('saveLoan()');assert.deepEqual(copy(f.run('ST.loans[0].schedule')),plan);
  f.run('openLoanForm()');assert.equal(f.w.document.getElementById('loan-left-count').disabled,false);f.run("document.getElementById('loan-kind').value='new';loanKindChanged()");assert.equal(f.w.document.getElementById('loan-old-counts').hidden,true);assert.equal(f.w.document.getElementById('loan-new-receipt').hidden,false);
});
test('explicit conversion archives legacy schedule without changing receipts, cash or their known split; cancellation is inert',async t=>{
  const f=setup(t);await f.run('init()');f.run(scheduledLoanBase);await configureLoan(f);await payLoan(f,100);const receipts=copy(f.run('ST.tx')),balance=f.run("calcAccBalance('a')");
  f.run("openLoanForm('l');startSimpleLoanConversion();document.getElementById('loan-left-count').value='2';document.getElementById('loan-total-count').value='5';document.getElementById('loan-paid-count').value='3';document.getElementById('loan-simple-amount').value='100';document.getElementById('loan-simple-day').value='10';fillMon('loan-simple-mon',2)");
  f.w.confirm=()=>false;await f.run('saveLoan()');assert.deepEqual(copy(f.run('ST.tx')),receipts);assert.equal(f.run('ST.loans[0].trackingMode'),undefined);
  f.w.confirm=()=>true;await f.run('saveLoan()');assert.equal(f.run('ST.loans[0].trackingMode'),'simple');assert.equal(f.run("calcAccBalance('a')"),balance);assert.equal(f.run('ST.loans[0].previousTracking.schedule.length'),10);assert.equal(f.run('ST.tx.find(t=>t.loanId).priorDueAllocations.length'),1);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
  f.run("editInstallment('l',loanInstallments('l')[0].id)");assert.equal(f.w.document.getElementById('loanpay-interest-wrap').hidden,false);await f.run('saveInstallmentEdit()');assert.equal(f.run('ST.tx.find(t=>t.loanId).nature'),'loanPrincipal');assert.equal(f.run('ST.tx.find(t=>t.loanId).priorDueAllocations.length'),1);assert.equal(f.run("calcAccBalance('a')"),balance);
});
test('simple schedule survives persistence, restore and malformed count rejection',async t=>{
  const factory=new IDBFactory(),storage=new Map(),f=await simpleLoan(t,{},factory,storage);await payLoan(f,100);const reopened=setup(t,factory,storage);await reopened.run('init()');assert.equal(reopened.run('loanDueItems(ST.loans[0])[0].status'),'paid');const g=setup(t,new IDBFactory(),new Map());await g.run('init()');g.w.__simpleBackup=copy(f.run('ST'));await g.run('applyBackupObject(__simpleBackup)');
  assert.equal(g.run('loanDueItems(ST.loans[0])[0].status'),'paid');assert.equal(g.run("calcAccBalance('a')"),1900);assert.equal(g.run("loanInstallments('l')[0].unsplit"),100);
  assert.throws(()=>g.run('validateBackup({...ST,loans:ST.loans.map(l=>({...l,installmentCount:20}))})'));
  assert.throws(()=>g.run('validateBackup({...ST,loans:ST.loans.map(l=>({...l,paidBefore:99}))})'));
});
test('SMS acknowledges existing simple payment and posts new unsplit installment without requiring invented interest',async t=>{
  const f=await simpleLoan(t);f.run("ST.smsKeys={'bank-key':'a'}");await payLoan(f,100,0,1,5);
  f.run("ST.smsQueue=[{id:'simple-q',hash:'simple-h',raw:'پیام آزمایشی',p:{keys:['bank-key'],a:100,tp:'expense',d:{y:1405,m:1,d:5}}}];smsqIdx=0;openSmsQueue();smsqSetTp('loan');document.getElementById('smsq-loan-existing').value='payment:'+loanInstallments('l')[0].id");await f.run('smsqSave()');assert.equal(f.run("calcAccBalance('a')"),1900);assert.equal(f.run("loanInstallments('l').length"),1);
  f.run("ST.smsQueue=[{id:'simple-q2',hash:'simple-h2',raw:'پیام آزمایشی',p:{keys:['bank-key'],a:100,tp:'expense',d:{y:1405,m:2,d:5}}}];smsqIdx=0;openSmsQueue();smsqSetTp('loan');document.getElementById('smsq-int').value=''");await f.run('smsqSave()');assert.equal(f.run("calcAccBalance('a')"),1800);assert.equal(f.run('activeLoans().length'),0);assert.equal(f.run('totals(ST.tx).e'),0);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
});
test('new simple loan creation is single-flight, cancellation is inert and unsupported storage never creates data',async t=>{
  const f=await simpleLoan(t);f.run("openLoanForm();document.getElementById('loan-n').value='وام آزمایشی دوم';document.getElementById('loan-left-count').value='2';document.getElementById('loan-simple-amount').value='100';document.getElementById('loan-simple-day').value='10'");
  f.w.confirm=()=>false;await f.run('saveLoan()');assert.equal(f.run('ST.loans.length'),1);f.w.confirm=()=>true;
  f.run('storageHealthy=false');await f.run('saveLoan()');assert.equal(f.run('ST.loans.length'),1);f.run('storageHealthy=true');
  let release;f.w.__hold=()=>new Promise(resolve=>release=resolve);f.run('const realSimpleSave=sv;sv=__hold');const first=f.run('saveLoan()');await f.run('saveLoan()');assert.equal(f.run('ST.loans.length'),2);release();await first;f.run('sv=realSimpleSave');await f.run('sv()');
});
test('count-based monthly schedule clamps short months and amount edits retain count, numbering and previous cash entries',async t=>{
  const f=await simpleLoan(t);f.run("openLoanForm();document.getElementById('loan-n').value='وام ماهانه آزمایشی';document.getElementById('loan-left-count').value='8';document.getElementById('loan-paid-count').value='2';document.getElementById('loan-total-count').value='10';document.getElementById('loan-simple-amount').value='100';document.getElementById('loan-simple-day').value='31';fillMon('loan-simple-mon',5)");await f.run('saveLoan()');
  assert.equal(f.run('ST.loans[1].schedule[1].day'),30);assert.equal(f.run('ST.loans[1].schedule[6].day'),f.run('jMaxDay(11,1405)'));assert.equal(f.run('ST.loans[1].schedule[7].day'),31);
  const before=copy(f.run('ST.tx'));f.run("openLoanSchedule(ST.loans[1].id);editScheduleItem(ST.loans[1].schedule[7].id);document.getElementById('due-edit-amount').value='120'");await f.run('saveScheduleItem()');assert.equal(f.run('ST.loans[1].schedule[7].a'),120);assert.equal(f.run('ST.loans[1].schedule[7].number'),10);assert.deepEqual(copy(f.run('ST.tx')),before);assert.doesNotThrow(()=>f.run('validateBackup(ST)'));
});

test('cash-flow reporting includes loan and deposit movements without treating internal transfers or valuations as spending',async t=>{
 const f=setup(t);await f.run('init()');f.run(dailyBase+`SM=1;SY=1405;ST.tx=[
 {id:'inc',tp:'income',a:1000,nature:'operating'},
 {id:'receipt',tp:'income',a:500,nature:'loanDisbursement'},
 {id:'dep',tp:'income',a:200,nature:'deposit'},
 {id:'expense',tp:'expense',a:100,nature:'operating'},
 {id:'principal',tp:'expense',a:80,nature:'loanPrincipal'},
 {id:'unsplit',tp:'expense',a:60,nature:'loanUnsplit'},
 {id:'opening',tp:'income',a:900,nature:'opening'},
 {id:'value',tp:'income',a:400,nature:'revaluation'},
 {id:'out',tp:'expense',a:250,nature:'transfer',isTransfer:true},
 {id:'in',tp:'income',a:250,nature:'transfer',isTransfer:true}
 ].map(t=>({...t,accId:'a',day:5,m:1,y:1405,cat:'e7'}));
 ST.tx.push({id:'unlinked',tp:'expense',a:100,day:5,m:1,y:1405,nature:'operating'});`);
 assert.deepEqual(copy(f.run('cashFlowSummary()')),{incoming:1700,outgoing:240,net:1460});
 const before=copy(f.run('ST'));f.run("rReportOverview();openCashFlowRows('expense')");assert.equal(f.run('ledgerEntries(ledgerQuery).length'),3);assert.match(f.w.document.getElementById('ledger-summary').textContent,/۲۴۰ تومان/);assert.deepEqual(copy(f.run('ST')),before);
 assert.equal(f.run('cashFlowSummary(2,1405).outgoing'),0);
});
test('legacy rent navigation activates More, never the create action, and other tabs remain correctly mapped',async t=>{
 const f=setup(t);await f.run('init()');f.run('nav(2)');assert.equal(f.w.document.querySelector('.nb.on').textContent.trim(),'بیشتر');assert.equal(f.w.document.querySelector('.nb-plus').classList.contains('on'),false);
 f.run('nav(1)');assert.equal(f.w.document.querySelector('.nb[aria-current="page"]').textContent.trim(),'تراکنش‌ها');assert.equal(f.w.document.querySelectorAll('.nb.on').length,1);
});
test('generalized connection UI preserves existing credentials, pending queues and automatic SMS endpoint',async t=>{
 const f=setup(t);await f.run('init()');f.run(`localStorage.setItem(GH_KEY,JSON.stringify({owner:'sample-owner',repo:'private-data',token:'synthetic-token',lastSha:'saved-sha'}));ST.amlakOutbox=[{id:'pending-a',a:1}];ST.sarafiOutbox=[{id:'pending-b',a:2}];`);
 const before=copy(f.run('[ST,ghCfg()]'));f.run('openSms();openBridgeStatus();openProtection();openGhModal()');assert.equal(f.w.document.getElementById('sms-inbox-url').textContent,'https://api.github.com/repos/sample-owner/private-data/contents/sms/');assert.equal(f.w.document.getElementById('gh-owner').value,'sample-owner');assert.deepEqual(copy(f.run('[ST,ghCfg()]')),before);
 assert.match(f.w.document.getElementById('protection-body').textContent,/Firebase/);assert.match(f.w.document.getElementById('bridge-body').textContent,/املاک/);assert.match(f.w.document.getElementById('bridge-body').textContent,/صرافی/);
 f.run('localStorage.removeItem(GH_KEY);openGhModal();openSms()');assert.equal(f.w.document.getElementById('gh-owner').value,'');assert.match(f.w.document.getElementById('sms-inbox-url').textContent,/OWNER\/REPOSITORY/);
});
test('loan list filters and pagination never change dues, payments or balances',async t=>{
 const f=await simpleLoan(t);await payLoan(f,100);const before=copy(f.run('ST'));
 f.run("openLoanSchedule('l')");assert.equal(f.run('loanVisibleDues(loanDueItems(ST.loans[0])).length'),1);
 f.run("setLoanView('paid')");assert.equal(f.run('loanVisibleDues(loanDueItems(ST.loans[0]))[0].status'),'paid');
 f.run("setLoanView('all')");assert.equal(f.run('loanVisibleDues(loanDueItems(ST.loans[0])).length'),2);assert.deepEqual(copy(f.run('ST')),before);
});
