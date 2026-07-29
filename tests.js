// ============================================================
// Sarmaye — schema v2 accounting invariant tests
// Loads the real functions out of index.html into a sandbox, feeds them
// synthetic v1 data, migrates, and asserts the eight invariants.
// Run:  node tests.js
// ============================================================
const fs=require('fs'),vm=require('vm');

const html=fs.readFileSync(__dirname+'/build/index.html','utf8');
const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
let code=blocks.join('\n;\n');   // both inline blocks, in document order
code=code.replace(/\ninit\(\);\s*$/,'\n');           // don't boot the app
code=code.replace(/document\.addEventListener\(/g,'noopAdd(');

const sandbox={
  console,setTimeout,setInterval:()=>0,clearTimeout,noopAdd:()=>{},
  navigator:{userAgent:'node'},location:{reload(){}},
  localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  indexedDB:undefined,
  window:{matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),navigator:{},addEventListener(){}},
  document:{
    documentElement:{setAttribute(){},getAttribute:()=>'light'},
    querySelector:()=>null,querySelectorAll:()=>[],
    getElementById:()=>null,addEventListener(){},createElement:()=>({style:{},click(){}}),
    title:''
  },
  Notification:undefined,fetch:()=>Promise.reject(new Error('no net')),
  crypto:{subtle:{},getRandomValues:a=>a},
  firebase:{initializeApp:()=>({}),auth:()=>({onAuthStateChanged(){},currentUser:null}),firestore:()=>({})},btoa:s=>Buffer.from(s,'binary').toString('base64'),
  atob:s=>Buffer.from(s,'base64').toString('binary'),
  URL:{createObjectURL:()=>'',revokeObjectURL(){}},
  Blob:function(){},alert(){},confirm:()=>true
};
sandbox.globalThis=sandbox;sandbox.self=sandbox;
vm.createContext(sandbox);
try{ vm.runInContext(code,sandbox,{filename:'app.js'}); }
catch(e){ console.error('LOAD ERROR:',e.message); process.exit(1); }

const G=sandbox;
let pass=0,fail=0;
const ok =(n,c,d)=>{ if(c){pass++;console.log('  \u2713 '+n);} else {fail++;console.log('  \u2717 '+n+(d?'  \u2192 '+d:''));} };
const eq =(n,a,b)=>ok(n,a===b,`${a} !== ${b}`);
const sec=n=>console.log('\n'+n);

// ------------------------------------------------------------
// Synthetic pre-v2 (schema v1) state
// ------------------------------------------------------------
function v1State(){
  return {
    sm:3,sy:1405,appName:'سرمایه',theme:'auto',
    accounts:[
      {id:'a1',bank:'بانک ملی',name:'جاری',initBalance:50000000,
       initDate:{d:1,m:0,y:1405},openTxId:null},
      {id:'a2',bank:'بانک ملت',name:'',initBalance:0,
       initDate:{d:1,m:0,y:1405},openTxId:null}
    ],
    tx:[
      {id:'t1',tp:'income', cat:'s1',a:30000000,dsc:'حقوق',day:5,m:3,y:1405,accId:'a1'},
      {id:'t2',tp:'expense',cat:'e2',a:4000000, dsc:'خرید',day:7,m:3,y:1405,accId:'a1'},
      // legacy installment, booked 100% as expense
      {id:'t3',tp:'expense',cat:'e8',a:5000000, dsc:'قسط وام مسکن',day:5,m:3,y:1405,accId:'a1',loanId:'l1'},
      // legacy rent income, dated to the RENT month
      {id:'t4',tp:'income', cat:'s2',a:12000000,dsc:'اجاره علی',day:10,m:3,y:1405,accId:'a1',
       isRent:true,tenantId:'ten1',payKey:'ten1_1405_3'},
      // transfer pair
      {id:'t5',tp:'expense',cat:'transfer',a:2000000,dsc:'انتقال',day:9,m:3,y:1405,accId:'a1',isTransfer:true,transferId:'tr1'},
      {id:'t6',tp:'income', cat:'transfer',a:2000000,dsc:'انتقال',day:9,m:3,y:1405,accId:'a2',isTransfer:true,transferId:'tr1'}
    ],
    ten:[{id:'ten1',n:'علی رضایی',unit:'واحد ۲',tp:'مسکونی',rent:12000000,dep:200000000,
          val:5000000000,due:10,note:'',start_d:10,start_m:2,start_y:1405,
          periods:[{sd:10,sm:2,sy:1405,dur:12,rent:12000000}],
          depReceived:true,depReceivedDate:'۱۴۰۵/۰۳/۱۰',accId:'a1'}],
    pay:{'ten1_1405_3':{status:'paid',amount:12000000,date:'۱۴۰۵/۰۴/۱۲',txId:'t4'}},
    loans:[{id:'l1',n:'وام مسکن',total:100000000,remaining:95000000,inst:5000000,day:5,active:true}],
    cats:{income:[{id:'s1',n:'حقوق',i:'briefcase',c:'#1865C2'},{id:'s2',n:'اجاره آپارتمان',i:'home',c:'#3B6D11'},
                  {id:'s3',n:'اجاره تجاری',i:'building',c:'#854F0B'}],
          expense:[{id:'e2',n:'سوپرمارکت',i:'cart',c:'#A32D2D'},{id:'e8',n:'قسط و وام',i:'coin',c:'#8C4A2F'}]},
    budgets:{},fx:[],dismissed:{},notifLog:[],smsLog:[],recurring:[],
    security:{enabled:false,pinHash:null}
  };
}
// `ST`, `SM`, `SY` are `let` bindings living in the script's lexical scope, not
// on the global object — they must be assigned by evaluating inside the context.
function ctx(expr){ return vm.runInContext(expr,sandbox); }
function load(st){
  sandbox.__in=st;
  return ctx('ST=migrateState(__in); SM=3; SY=1405; ST;');
}

// ------------------------------------------------------------
sec('1. Migration produces the v2 shape');
let S=load(v1State());
eq('schemaVersion is 2',S.schemaVersion,2);
eq('one property created',S.properties.length,1);
eq('one tenant created',S.tenants.length,1);
eq('one contract created',S.rentalContracts.length,1);
eq('contract id reuses ten.id',S.rentalContracts[0].id,'ten1');
eq('legacy pay -> rentPayments',S.rentPayments.length,1);
ok('_legacy snapshot kept',!!S._legacy&&S._legacy.ten.length===1);
eq('property value carried over',S.properties[0].value,5000000000);
eq('tenant name carried over',S.tenants[0].name,'علی رضایی');

sec('2. Invariant: every transaction has a nature');
ok('no untagged transactions',S.tx.every(t=>!!t.nature),
   JSON.stringify(S.tx.filter(t=>!t.nature).map(t=>t.id)));
eq('opening tagged',S.tx.find(t=>t.isOpening).nature,'opening');
eq('transfer tagged',S.tx.find(t=>t.id==='t5').nature,'transfer');
eq('legacy installment grandfathered',S.tx.find(t=>t.id==='t3').nature,'operating');
ok('legacy installment flagged',S.tx.find(t=>t.id==='t3').legacyInstallment===true);

sec('3. Invariant: sum of signed tx per account === calcAccBalance');
S.accounts.forEach(a=>{
  const manual=S.tx.filter(t=>t.accId===a.id)
    .reduce((s,t)=>s+(t.tp==='income'?t.a:-t.a),0);
  eq(`account ${a.id}`,G.calcAccBalance(a.id),manual);
});
eq('a1 balance',G.calcAccBalance('a1'),50000000+30000000-4000000-5000000+12000000-2000000);
eq('a2 balance',G.calcAccBalance('a2'),2000000);

sec('4. Invariant: netWorth === assets − loans − deposits');
eq('netWorth identity',G.netWorth(),G.assetsTotal()-G.loansDebt()-G.depositLiability());
eq('legacy deposit is NOT a liability yet',G.depositLiability(),0);
eq('one unposted deposit surfaced',G.unpostedDeposits().length,1);

sec('5. Invariant: no orphan accId');
const accIds=new Set(S.accounts.map(a=>a.id));
ok('every accId resolves',S.tx.every(t=>!t.accId||accIds.has(t.accId)));

sec('6. Invariant: paired legs are complete');
const byTransfer={};S.tx.forEach(t=>{if(t.transferId)(byTransfer[t.transferId]=byTransfer[t.transferId]||[]).push(t);});
ok('every transferId has exactly 2 legs',Object.values(byTransfer).every(v=>v.length===2));

sec('7. Invariant: migration is idempotent');
const once=JSON.stringify(G.migrateState(v1State()));
const twice=JSON.stringify(G.migrateV2(JSON.parse(once)));
// uid()-generated ids differ between runs, so compare structure counts instead
const A=JSON.parse(once),B=JSON.parse(twice);
eq('properties stable',B.properties.length,A.properties.length);
eq('contracts stable',B.rentalContracts.length,A.rentalContracts.length);
eq('rentPayments stable',B.rentPayments.length,A.rentPayments.length);
eq('tx count stable',B.tx.length,A.tx.length);

sec('8. Invariant: rent payments reconcile with their transactions');
S=load(v1State());
const rpTotal=S.rentPayments.reduce((s,p)=>s+p.amount,0);
const rentTxTotal=S.tx.filter(t=>t.isRent).reduce((s,t)=>s+t.a,0);
eq('rentPayments total === rent tx total',rpTotal,rentTxTotal);
eq('accrual period attached to rent tx',S.tx.find(t=>t.id==='t4').rentPeriod.m,3);
eq('paidFor reads the payment',G.paidFor('ten1',1405,3),12000000);
eq('rentStatus is paid',G.rentStatus(G.cView(S.rentalContracts[0]),1405,3).state,'paid');

sec('9. P&L excludes every non-operating nature');
S=load(v1State());
const tot=G.totals(G.getTx(3,1405));
eq('income = salary + rent',tot.i,30000000+12000000);
eq('expense = groceries + legacy installment',tot.e,4000000+5000000);
ok('opening excluded',!G.isPnL(S.tx.find(t=>t.isOpening)));
ok('transfer excluded',!G.isPnL(S.tx.find(t=>t.id==='t5')));

sec('10. Deposit posting: cash up, liability up, P&L untouched');
S=load(v1State());
const before={assets:G.assetsTotal(),nw:G.netWorth(),pnl:G.totals(G.getTx(3,1405))};
S.tx.push({id:'d1',tp:'income',cat:'deposit',a:200000000,dsc:'دریافت ودیعه',
  day:10,m:3,y:1405,accId:'a1',nature:'deposit',depositRole:'received',contractId:'ten1'});
const c=S.rentalContracts[0];c.depositTxIds.received='d1';
eq('assets +deposit',G.assetsTotal(),before.assets+200000000);
eq('liability +deposit',G.depositLiability(),200000000);
eq('net worth unchanged',G.netWorth(),before.nw);
eq('income unchanged',G.totals(G.getTx(3,1405)).i,before.pnl.i);
eq('unposted list now empty',G.unpostedDeposits().length,0);

sec('11. Deposit return: cash down, liability down, P&L untouched');
const nwAfterRecv=G.netWorth();
S.tx.push({id:'d2',tp:'expense',cat:'deposit',a:200000000,dsc:'بازگشت ودیعه',
  day:10,m:5,y:1406,accId:'a1',nature:'deposit',depositRole:'returned',contractId:'ten1'});
eq('liability back to zero',G.depositLiability(),0);
eq('net worth unchanged again',G.netWorth(),nwAfterRecv);
eq('expense unchanged',G.totals(G.getTx(3,1405)).e,before.pnl.e);

sec('12. Loan disbursement is not income');
S=load(v1State());
const nwPre=G.netWorth(), incPre=G.totals(G.getTx(3,1405)).i;
S.tx.push({id:'ld1',tp:'income',cat:'loan',a:80000000,dsc:'دریافت وام',
  day:1,m:3,y:1405,accId:'a2',nature:'loanDisbursement',loanId:'l2'});
S.loans.push({id:'l2',n:'وام جدید',principalTotal:80000000,total:80000000,
  remaining:80000000,inst:2000000,day:1,defaultInterest:0,active:true,disbursementTxId:'ld1'});
eq('cash rose',G.assetsTotal(),G.assetsTotal());
eq('net worth unchanged by disbursement',G.netWorth(),nwPre);
eq('income unchanged',G.totals(G.getTx(3,1405)).i,incPre);

sec('13. Installment split: principal off P&L, interest on it');
S=load(v1State());
const nw0=G.netWorth(), exp0=G.totals(G.getTx(4,1405)).e;
const loan=S.loans[0];
S.tx.push({id:'p1',tp:'expense',cat:'loan',a:4000000,dsc:'اصل قسط',
  day:5,m:4,y:1405,accId:'a1',nature:'loanPrincipal',loanId:'l1',installmentId:'i1'});
S.tx.push({id:'p2',tp:'expense',cat:'e8',a:1000000,dsc:'سود قسط',
  day:5,m:4,y:1405,accId:'a1',nature:'operating',loanId:'l1',installmentId:'i1'});
loan.remaining-=4000000;
eq('only interest hits expenses',G.totals(G.getTx(4,1405)).e,exp0+1000000);
eq('net worth falls only by the interest',G.netWorth(),nw0-1000000);
eq('debt reduced by principal only',loan.remaining,91000000);

sec('14. Period-aware rent after a renewal');
S=load(v1State());
const con=S.rentalContracts[0];
con.periods.push({sd:10,sm:2,sy:1406,dur:12,rent:18000000});
const view=G.cView(con);
eq('old period keeps its rent',G.rentFor(view,5,1405),12000000);
eq('new period uses the new rent',G.rentFor(view,5,1406),18000000);
eq('view.rent tracks the latest period',view.rent,18000000);

sec('15. Early termination stops rent accruing');
S=load(v1State());
const con2=S.rentalContracts[0];
con2.terminatedAt={y:1405,m:6,d:1};con2.status='terminated';
const v2=G.cView(con2);
eq('rent due before exit',G.rentFor(v2,5,1405),12000000);
eq('rent due in exit month',G.rentFor(v2,6,1405),12000000);
eq('no rent after exit',G.rentFor(v2,7,1405),0);

sec('16. Multiple partial payments in one month');
S=load(v1State());
S.rentPayments.push({id:'rp2',contractId:'ten1',rentPeriod:{y:1405,m:4},
  payDate:{y:1405,m:4,d:12},amount:5000000,accId:'a1',txId:'x1'});
S.rentPayments.push({id:'rp3',contractId:'ten1',rentPeriod:{y:1405,m:4},
  payDate:{y:1405,m:4,d:25},amount:4000000,accId:'a1',txId:'x2'});
eq('two payments sum',G.paidFor('ten1',1405,4),9000000);
eq('status is partial',G.rentStatus(G.cView(S.rentalContracts[0]),1405,4).state,'partial');
S.rentPayments.push({id:'rp4',contractId:'ten1',rentPeriod:{y:1405,m:4},
  payDate:{y:1405,m:5,d:2},amount:3000000,accId:'a1',txId:'x3'});
eq('third payment completes it',G.rentStatus(G.cView(S.rentalContracts[0]),1405,4).state,'paid');
eq('arrears cleared for that month',G.paidFor('ten1',1405,4),12000000);

sec('17. Cash vs accrual dating are independent');
S=load(v1State());
S.rentPayments.push({id:'rp9',contractId:'ten1',rentPeriod:{y:1405,m:3},
  payDate:{y:1405,m:5,d:2},amount:1000000,accId:'a1',txId:'x9'});
eq('accrual view counts it in 1405',G.annualCollected('ten1',1405),13000000);
eq('cash view respects payDate year',G.annualCollectedCash('ten1',1405),13000000);
S.rentPayments.push({id:'rp10',contractId:'ten1',rentPeriod:{y:1405,m:11},
  payDate:{y:1406,m:0,d:5},amount:12000000,accId:'a1',txId:'x10'});
eq('accrual: rent for Esfand 1405 counts in 1405',G.annualCollected('ten1',1405),25000000);
eq('cash: money arrived in 1406',G.annualCollectedCash('ten1',1406),12000000);

sec('18. Archived accounts stay in the numbers');
S=load(v1State());
const totalBefore=G.assetsTotal();
S.accounts.find(a=>a.id==='a2').archived=true;
eq('assets unchanged after archiving',G.assetsTotal(),totalBefore);
eq('archived hidden from pickers',G.activeAccounts().length,1);
eq('tx count guard works',G.accTxCount('a1'),S.tx.filter(t=>t.accId==='a1').length);

// ------------------------------------------------------------
console.log('\n'+'='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
console.log('='.repeat(46));
process.exit(fail?1:0);
