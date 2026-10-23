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
