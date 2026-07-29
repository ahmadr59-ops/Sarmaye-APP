// Render smoke test: run the screen renderers against a stub DOM and make sure
// none of them throw with realistic v2 data.
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(__dirname+'/build/index.html','utf8');
let code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n')
  .replace(/\ninit\(\);\s*$/,'\n');
const mk=()=>({style:{},classList:{add(){},remove(){},toggle(){},contains:()=>false},
  value:'',textContent:'',innerHTML:'',dataset:{},checked:false,
  appendChild(){},setAttribute(){},getAttribute:()=>null,addEventListener(){},
  querySelector:()=>mk(),querySelectorAll:()=>[],scrollIntoView(){},click(){},
  getBoundingClientRect:()=>({left:0,top:0,width:0,height:0})});
const sb={console,setTimeout:()=>0,setInterval:()=>0,clearTimeout,
  navigator:{userAgent:'node',standalone:false},location:{reload(){}},
  localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  window:{matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),navigator:{},addEventListener(){}},
  document:{documentElement:mk(),title:'',getElementById:()=>mk(),
    querySelector:()=>mk(),querySelectorAll:()=>[],addEventListener(){},createElement:mk},
  Notification:{permission:'denied'},
  firebase:{initializeApp:()=>({}),auth:()=>({onAuthStateChanged(){},currentUser:null}),firestore:()=>({})},
  btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
  crypto:{subtle:{},getRandomValues:a=>a},URL:{createObjectURL:()=>'',revokeObjectURL(){}},
  Blob:function(){},alert(){},confirm:()=>true,fetch:()=>Promise.reject(new Error('x'))};
sb.globalThis=sb;sb.self=sb;vm.createContext(sb);
vm.runInContext(code,sb,{filename:'app.js'});

const st={sm:3,sy:1405,theme:'auto',
  accounts:[{id:'a1',bank:'بانک ملی',name:'',initBalance:50000000,initDate:{d:1,m:0,y:1405},openTxId:null},
            {id:'a2',bank:'بانک ملت',name:'',initBalance:0,initDate:{d:1,m:0,y:1405},openTxId:null,archived:true}],
  tx:[{id:'t1',tp:'income',cat:'s1',a:30000000,dsc:'حقوق',day:5,m:3,y:1405,accId:'a1'},
      {id:'t4',tp:'income',cat:'s2',a:12000000,dsc:'اجاره',day:10,m:3,y:1405,accId:'a1',isRent:true,tenantId:'ten1',payKey:'ten1_1405_3'}],
  ten:[{id:'ten1',n:'علی',unit:'واحد ۲',tp:'مسکونی',rent:12000000,dep:200000000,val:5000000000,
        due:10,start_d:10,start_m:2,start_y:1405,periods:[{sd:10,sm:2,sy:1405,dur:12,rent:12000000}],
        depReceived:true,depReceivedDate:'۱۴۰۵/۰۳/۱۰',accId:'a1'}],
  pay:{'ten1_1405_3':{status:'paid',amount:12000000,date:'۱۴۰۵/۰۴/۱۲',txId:'t4'}},
  loans:[{id:'l1',n:'وام مسکن',total:100000000,remaining:95000000,inst:5000000,day:5,active:true}],
  cats:{income:[{id:'s1',n:'حقوق',i:'briefcase',c:'#1865C2'},{id:'s2',n:'اجاره',i:'home',c:'#3B6D11'},{id:'s3',n:'اجاره تجاری',i:'building',c:'#854F0B'}],
        expense:[{id:'e2',n:'خرید',i:'cart',c:'#A32D2D'},{id:'e8',n:'قسط و وام',i:'coin',c:'#8C4A2F'}]},
  budgets:{e2:5000000},fx:[],dismissed:{},notifLog:[],smsLog:[],recurring:[],security:{}};
sb.__in=st;
vm.runInContext('ST=migrateState(__in);SM=3;SY=1405;',sb);

let fail=0;
for(const fn of ['rDash','rTx','rTen','rRep','rPropTable','rBudgets','rSavingsAndTrend',
                 'openPay','openLoanList','openAccList','openTM','openLoanForm',
                 'openDepDateModal','renderDepositNotice','chkDue','chkNotifBadge','exportCSV','updateLoanCount']){
  try{
    if(fn==='openPay') vm.runInContext(`openPay('ten1')`,sb);
    else if(fn==='openTM') vm.runInContext(`openTM('ten1')`,sb);
    else if(fn==='openDepDateModal') vm.runInContext(`openDepDateModal('ten1','received')`,sb);
    else if(fn==='openLoanForm') vm.runInContext(`openLoanForm()`,sb);
    else vm.runInContext(fn+'()',sb);
    console.log('  \u2713 '+fn);
  }catch(e){ fail++; console.log('  \u2717 '+fn+' \u2192 '+e.message); }
}
console.log(fail?`\nSMOKE FAILURES: ${fail}`:'\nALL RENDERERS OK');
process.exit(fail?1:0);
