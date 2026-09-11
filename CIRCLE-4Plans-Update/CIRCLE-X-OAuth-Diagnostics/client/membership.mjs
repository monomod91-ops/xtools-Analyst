import {login, signup, logout, getUser, handleAuthCallback, requestPasswordRecovery, updateUser, onAuthChange} from '@netlify/identity';

const shell = document.getElementById('membership'), root = document.getElementById('root');
const money = n => new Intl.NumberFormat('ja-JP', {style:'currency',currency:'JPY'}).format(n);
const date = n => new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long',day:'numeric'}).format(n);
let plan, plans=[], selectedPlanId='standard', member, current, mode='login', appLoaded=false, busy=false, refreshTimer, rendering=false, notice=null;
let authQueue=Promise.resolve(), lastAuthLocation;
const nativeFetch = window.fetch.bind(window);
// Refresh only the usage display; do not repeat X requests to update counters.
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  const target=typeof args[0]==='string'?args[0]:args[0]?.url;
  if(target?.includes('/api/x/')) {
    clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refreshStatus().catch(()=>{}),700);
  }
  return response;
};
function el(tag, text, className) {
  const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;
}
function button(text, action, style='circle-button') {
  const b=el('button',text,style);b.type='button';b.addEventListener('click',()=>run(action,b));return b;
}
function showNotice() {
  if(!notice)return;
  let box=document.getElementById('circle-notice');
  if(!box){box=el('p');box.id='circle-notice';(shell.querySelector('.circle-auth')||shell).prepend(box);}
  box.className=notice.error?'circle-notice circle-error':'circle-notice';
  box.setAttribute('role',notice.error?'alert':'status');box.textContent=notice.text;
  return box;
}
function message(text, error=false) {
  notice={text,error};const box=showNotice();
  if(box){box.tabIndex=-1;box.focus({preventScroll:true});box.scrollIntoView({block:'center'});}
}
async function run(action, b) {
  if(busy)return;busy=true;notice=null;document.getElementById('circle-notice')?.remove();
  const label=b?.textContent;
  if(b){b.disabled=true;if(b.type==='submit')b.textContent=mode==='login'?'ログイン中…':'処理中…';}
  try{await action();}catch(error){message(error.message||'処理できませんでした。時間をおいて再度お試しください。',true);}
  finally{busy=false;if(b){b.disabled=false;b.textContent=label;}}
}
async function api(route, post=false, body) {
  const response=await nativeFetch('/api/billing/'+route,{method:post?'POST':'GET',credentials:'same-origin',
    signal:AbortSignal.timeout(30000),headers:post?{'X-Circle-Request':'membership','Content-Type':'application/json'}:{},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'契約を確認できません。'),{status:response.status,code:data.code});return data;
}
function redirect(url, host) {
  const u=new URL(url);if(u.protocol!=='https:'||u.hostname!==host)throw Error('決済画面を確認できません。');location.assign(u.href);
}
async function manage() {const result=await api('portal',true);redirect(result.url,'billing.stripe.com');}
async function exit() {await logout();location.assign('/');}
function legalLinks() {
  const nav=el('nav',undefined,'circle-legal');nav.setAttribute('aria-label','ご利用にあたって');
  for(const [name,url] of [['利用条件','/membership-terms.html'],['プライバシー','/membership-privacy.html'],['販売者情報','/seller.html']]){
    const a=el('a',name);a.href=url;nav.append(a);
  }return nav;
}
function header() {
  const h=el('header',undefined,'circle-member-header'),brand=el('a','◎ CIRCLE','circle-brand');brand.href='/';
  h.append(brand);if(member){h.append(el('span',member.email,'circle-email'),button('ログアウト',exit,'circle-link'));}return h;
}
function selectedPlan() {return plans.find(p=>p.id===selectedPlanId)||plan;}
function pricing() {
  const box=el('section',undefined,'circle-pricing');
  box.append(el('p','YOUR X CONNECTIONS','circle-eyebrow'),el('h1','つながりを、自分のペースで。'));
  box.append(el('p','最近の投稿からフォローの活動状況を確認。必要な人数に合わせて、4つのプランから選べます。','circle-intro'));
  const grid=el('div',undefined,'circle-plan-grid');
  for(const p of plans) {
    const card=el('section',undefined,'circle-plan'+(p.id===selectedPlanId?' is-selected':'')+(p.id==='max1000'?' circle-plan-max':''));
    card.setAttribute('aria-label',p.name);
    if(p.id==='standard')card.append(el('p','おすすめ','circle-plan-badge'));
    card.append(el('h2',p.name,'circle-plan-name'));
    const price=el('p',undefined,'circle-price');price.append(el('strong',money(p.amount)),el('span',' / 月（税込）'));card.append(price);
    card.append(el('p','毎月 '+p.limits.analysis.toLocaleString('ja-JP')+' 人分を分析','circle-plan-lead'));
    const list=el('ul');
    for(const text of ['一覧取得：延べ'+p.limits.list.toLocaleString('ja-JP')+'人分／契約月','解除前の確認・解除：'+p.limits.action+'人分／契約月','初回連携・再連携：'+p.limits.link+'回／契約月','連携できるXアカウント：1つ'])
      list.append(el('li',text));
    const choose=button(p.id===selectedPlanId?'選択中':'このプランを選ぶ',()=>{
      selectedPlanId=p.id;render();shell.querySelector('.circle-auth')?.scrollIntoView({behavior:'smooth',block:'start'});
    },p.id===selectedPlanId?'circle-button':'circle-secondary');
    choose.setAttribute('aria-pressed',String(p.id===selectedPlanId));
    card.append(list,choose);grid.append(card);
  }
  box.append(grid,el('p','分析1人分で直近最大5投稿を確認します。同じ一覧・同じ条件の結果は24時間再利用。保存済みの結果を見るだけなら枠は減りません。','circle-small'));
  box.append(el('p','一覧は1ページ最大100人で、再取得・次ページ・ブロック一覧も延べ取得人数に含みます。通信失敗で取得人数が不明な場合は、取得開始時に予約した人数分を消費します。','circle-small'));
  box.append(el('p','毎月自動更新。未使用枠の繰越・自動追加課金はありません。契約管理画面でいつでも次回更新を停止でき、支払済みの期間末まで利用できます。','circle-small'));
  return box;
}
function form() {
  const panel=el('section',undefined,'circle-auth');
  if(member && mode!=='reset'){
    panel.append(el('p','MEMBERSHIP','circle-eyebrow'),el('h2',current?.subscriptionStatus==='none'?'プランをはじめる':'契約をご確認ください'));
    if(current?.subscriptionStatus!=='none')panel.append(button('契約・お支払いを管理',manage));
    const chosen=selectedPlan();
    const selectLabel=el('label','お申し込みプラン','circle-select-label'), select=el('select');
    select.setAttribute('aria-label','お申し込みプラン');
    for(const p of plans){const option=el('option',p.name+' — '+money(p.amount)+' / 月（税込）');option.value=p.id;option.selected=p.id===chosen.id;select.append(option);}
    select.addEventListener('change',()=>{selectedPlanId=select.value;render();});
    selectLabel.append(select);panel.append(selectLabel);
    const consent=el('label',undefined,'circle-consent'), check=el('input');check.type='checkbox';
    consent.append(check,el('span','利用条件・プライバシー・販売者情報を確認し、毎月の自動更新に同意します。'));panel.append(consent);
    const buy=button(money(chosen.amount)+' / 月で申し込む',async()=>{if(!check.checked)throw Error('利用条件をご確認のうえチェックしてください。');const r=await api('checkout',true,{planId:chosen.id});redirect(r.url,'checkout.stripe.com');});
    buy.disabled=!current?.acceptingPayments||!chosen.acceptingPayments;
    if(buy.disabled){buy.textContent='ただいま受付準備中';panel.append(el('p','受付が始まると、ここからお申し込みいただけます。現在は料金が発生しません。','circle-small'));}
    panel.append(buy,button('支払い状況を確認',async()=>{await api('sync',true);await refreshStatus();if(!current.active)message('まだお支払いを確認できません。決済直後は少し待ってからお試しください。');},'circle-secondary'));
    return panel;
  }
  const recovery=mode==='recovery', reset=mode==='reset', register=mode==='signup';
  panel.append(el('p','MEMBERSHIP','circle-eyebrow'),el('h2',reset?'新しいパスワード':recovery?'パスワードの再設定':register?'アカウント作成':'ログイン'));
  const f=el('form');
  const field=(label,type,name,auto)=>{const l=el('label',label),input=el('input');input.name=name;input.type=type;input.autocomplete=auto;input.required=true;l.append(input);f.append(l);return input;};
  let email,password;
  if(!reset)email=field('メールアドレス','email','email','email');
  if(!recovery){password=field('パスワード','password','password',register||reset?'new-password':'current-password');if(register||reset)password.minLength=12;}
  const submit=el('button',reset?'パスワードを保存':recovery?'再設定メールを送る':register?'確認メールを送る':'ログイン','circle-button');submit.type='submit';
  f.append(submit);f.addEventListener('submit',e=>{e.preventDefault();run(async()=>{
    if(recovery){await requestPasswordRecovery(email.value.trim());message('登録済みのメールアドレスへ再設定の案内を送信します。');return;}
    if(reset){await updateUser({password:password.value});mode='login';await initialize();return;}
    if(register){await signup(email.value.trim(),password.value);message('確認メールを送信しました。メール内のリンクを開いて登録を完了してください。');return;}
    const user=await login(email.value.trim(),password.value);await initialize(user,true);
  },submit);});
  panel.append(f);
  if(!reset){panel.append(button(register||recovery?'ログインに戻る':'はじめての方はこちら',()=>{mode=register||recovery?'login':'signup';render();},'circle-link'));
    if(!register&&!recovery)panel.append(button('パスワードを忘れた方',()=>{mode='recovery';render();},'circle-link'));}
  return panel;
}
function usageBar() {
  const bar=el('section',undefined,'circle-usage');bar.setAttribute('aria-label','この契約期間の利用枠');
  const planName=current.plan?.name||'CIRCLE';
  for(const [key,label,unit] of [['analysis','分析','人分'],['list','一覧取得',current.listUnit==='people'?'人分':'回']]){
    const u=current.usage[key],remaining=Math.max(0,u.limit-u.used),meter=el('div');
    meter.append(el('span',key==='analysis'?planName+' · 今月の分析':label),el('strong','残り '+remaining.toLocaleString('ja-JP')+' / '+u.limit.toLocaleString('ja-JP')+' '+unit));
    const progress=el('progress');progress.max=u.limit;progress.value=u.used;
    progress.setAttribute('aria-label',label+' '+u.used+unit+'使用');meter.append(progress);bar.append(meter);
  }
  const end=current.periodEnd?date(current.periodEnd):'確認中';
  bar.append(el('p',current.cancelAtPeriodEnd?end+'まで利用可能・更新停止済み':end+'に更新','circle-small'));
  const details=el('details');details.append(el('summary','その他の利用枠'));
  for(const [key,name,unit] of [['action','解除前の確認・解除','人分'],['link','初回連携・再連携','回']]){
    const u=current.usage[key];details.append(el('p',name+'：残り '+Math.max(0,u.limit-u.used)+' / '+u.limit+' '+unit));
  }
  bar.append(details,button('契約・解約',manage,'circle-secondary'));
  return bar;
}
function render() {
  if(rendering||!plan)return;rendering=true;
  shell.replaceChildren(header());
  if(member&&current?.active&&mode!=='reset') {
    shell.append(usageBar());root.hidden=false;
    if(current.apiPaused)message('現在、分析を一時停止しています。契約・解約は利用できます。');
    if(!appLoaded){appLoaded=true;const script=el('script');script.src='/assets/circle-app.js';script.onerror=()=>message('画面を読み込めませんでした。ページを更新してください。',true);document.body.append(script);}
  } else {
    root.hidden=true;const main=el('main',undefined,'circle-membership-grid');main.append(pricing(),form());shell.append(main,legalLinks());
  }
  showNotice();rendering=false;
}
async function refreshStatus() {
  if(!member)return;
  try {current=await api('status');render();}
  catch(error){if(error.status===401){root.hidden=true;member=null;current=null;render();}throw error;}
}
async function initialize(authenticatedUser, requireSession=false) {
  const user=authenticatedUser??await getUser();
  if(requireSession&&!user)throw Error('ログイン情報を保持できませんでした。ページを更新してから再度ログインしてください。');
  // The server validates the signed session and email confirmation itself.
  // A missing/stale browser-side flag must not prevent that authoritative check.
  let status=null;
  try{if(user)status=await api('status');}
  catch(error){
    if(error.status===401){member=null;current=null;root.hidden=true;}
    throw error;
  }
  member=user;current=status;render();
}
async function start() {
  // Email links can update only the fragment of an already open Safari tab.
  // A pageshow event also covers a tab restored from the back/forward cache.
  window.addEventListener('hashchange',()=>processAuthLocation());
  window.addEventListener('pageshow',()=>processAuthLocation());
  onAuthChange((event)=>{if(event==='LOGOUT'){root.hidden=true;member=null;current=null;render();}});
  await processAuthLocation(true);
}
function processAuthLocation(initial=false) {
  // Serialize SDK calls: the same one-use link must not be consumed twice when
  // hashchange and pageshow arrive together, or while startup is still pending.
  const task=authQueue.then(()=>loadAuthLocation(initial));
  authQueue=task.catch(()=>{});
  return task;
}
async function loadAuthLocation(initial) {
  const href=location.href;
  if(!initial&&href===lastAuthLocation)return;
  lastAuthLocation=href;
  let callback, callbackError;
  try{callback=await handleAuthCallback();}catch(error){callbackError=error;}
  if(!initial&&!callback&&!callbackError)return;
  notice=null;
  try {
    // Even an invalid/expired link must leave a usable login form, not a loader.
    if(!plan){const pricingInfo=await api('plan');plan=pricingInfo.plan;plans=pricingInfo.plans||[{...plan,acceptingPayments:pricingInfo.acceptingPayments}];}
    if(callback?.type==='recovery')mode='reset';
    if(callback?.type==='confirmation'||callback?.type==='oauth')mode='login';
    if(callbackError){render();throw callbackError;}
    const signedIn=callback?.type==='confirmation'||callback?.type==='oauth';
    await initialize(signedIn?callback.user:undefined,signedIn);
    if(callback?.type==='confirmation')message('メール認証が完了しました。');
    if(!initial)return;
    const result=new URL(location.href).searchParams.get('payment');
    if(member&&['success','return'].includes(result)){
      message('お支払い状況を確認しています…');
      await api('sync',true);await refreshStatus();
      if(!current.active)message('お支払いの反映を待っています。少し待って「支払い状況を確認」を押してください。');
      history.replaceState(null,'','/');
    }else if(result==='cancelled')message('お申し込みを中断しました。');
  }catch(error){if(plan)render();message(error.message||'読み込みに失敗しました。ページを更新してください。',true);}
}
start();
