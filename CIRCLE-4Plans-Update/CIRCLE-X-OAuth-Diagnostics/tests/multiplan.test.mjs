import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PLANS,PLAN,PRICE_ENV,billingConfig,publicCatalog} from '../server/plan.mjs';
import {createBillingStore} from '../server/billing-store.mjs';
import {createBillingService,paidPeriod,validatePrice} from '../server/billing.mjs';
import {handle,seal} from '../server/core.mjs';
import {billingPool} from './billing-harness.mjs';
import {database} from './sqlite-harness.mjs';
const now=Date.parse('2026-09-11T12:00:00Z'),end=now+30*86400000;
const origin='https://marinqueen.com',member={id:'tier-member',email:'tier@example.test'};
const env={APP_ORIGIN:origin,STRIPE_MODE:'test',STRIPE_SECRET_KEY:'rk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_PRICE_ID:'price_legacy',STRIPE_PORTAL_CONFIG_ID:'bpc_fixture',BILLING_ENABLED:'true',MERCHANT_DETAILS_CONFIRMED:'true',
  ...Object.fromEntries(Object.entries(PRICE_ENV).map(([id,key])=>[key,'price_'+id]))};
const config=billingConfig(env);
const makePrice=p=>({id:config.priceIds[p.id],unit_amount:p.amount,currency:'jpy',active:true,livemode:false,type:'recurring',tax_behavior:'inclusive',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}});
function documents(p, invoiceId='in_tier') {
  const price=makePrice(p),sub={id:'sub_tier',customer:'cus_tier',status:'active',livemode:false,metadata:{circle_member_id:member.id,circle_plan_id:p.id},latest_invoice:invoiceId,items:{data:[{price,quantity:1}]}};
  const invoice={id:invoiceId,customer:'cus_tier',status:'paid',amount_paid:p.amount,currency:'jpy',livemode:false,billing_reason:'subscription_create',
    parent:{subscription_details:{subscription:sub.id}},lines:{data:[{quantity:1,amount:p.amount,pricing:{price_details:{price:price.id}},parent:{type:'subscription_item_details',subscription_item_details:{proration:false}},period:{start:now/1000,end:end/1000}}]}};
  return {price,sub,invoice};
}
async function fixture(p=PLANS[0],paid=true) {
  const pool=billingPool(),store=createBillingStore(pool,()=>now);
  const docs=documents(p),sessions=new Map(),creates=[],expires=[];
  await store.ensureMember(member.id);await store.setCustomer(member.id,'cus_tier');
  const state={...docs,subscriptions:paid?[docs.sub]:[]};
  const stripe={prices:{retrieve:async id=>makePrice([PLAN,...PLANS].find(p=>config.priceIds[p.id]===id))},
    subscriptions:{list:async()=>({data:state.subscriptions}),retrieve:async()=>state.sub},
    invoices:{retrieve:async()=>state.invoice},
    checkout:{sessions:{
      create:async(params,options)=>{creates.push({params:structuredClone(params),options});const s={id:'cs_'+creates.length,status:'open',url:'https://checkout.stripe.com/c/pay/fixture',expires_at:params.expires_at};sessions.set(s.id,s);return s;},
      retrieve:async id=>sessions.get(id),
      expire:async id=>{expires.push(id);sessions.get(id).status='expired';return sessions.get(id);}
    }}};
  const service=createBillingService({stripe,store,env,clock:()=>now});
  if(paid){await store.syncSubscription(member.id,state.sub);await store.grant(member.id,state.invoice,state.sub,paidPeriod(state.invoice,state.sub,config),p);}
  return {pool,store,state,stripe,service,sessions,creates,expires,close:()=>pool.raw.close()};
}
test('the four adopted monthly prices and allowances are exact, independently bounded',()=>{
  assert.deepEqual(PLANS.map(p=>[p.id,p.amount,...Object.values(p.limits)]),[
    ['light',480,20,50,5,5],['standard',980,50,100,10,10],['pro',1980,120,200,20,20],['max1000',12800,1000,1000,100,20]]);
  assert.equal(publicCatalog(config).plans.length,4);
  assert.equal(billingConfig({...env,STRIPE_PRICE_LIGHT_ID:env.STRIPE_PRICE_STANDARD_ID}).enabled,false);
});
for(const p of PLANS) test(p.id+': checkout, paid webhook and limits all use the chosen server-side price',async()=>{
  const f=await fixture(p,false);
  const request=new Request(origin+'/api/billing/checkout',{method:'POST',headers:{origin,'x-circle-request':'membership'},body:JSON.stringify({planId:p.id,amount:1,price:'price_attacker',quantity:99,member_id:'other'})});
  assert.equal((await f.service.handle(request,member)).status,200);
  assert.deepEqual(f.creates[0].params.line_items,[{price:config.priceIds[p.id],quantity:1}]);
  assert.equal(f.creates[0].params.metadata.circle_plan_id,p.id);
  await f.service.processEvent({id:'evt_'+p.id,type:'invoice.paid',livemode:false,data:{object:f.state.invoice}});
  let status=await f.store.status(member.id);
  assert.equal(status.active,true);assert.equal(status.plan.id,p.id);assert.equal(status.listUnit,'people');
  assert.deepEqual(Object.fromEntries(Object.entries(status.usage).map(([k,v])=>[k,v.limit])),p.limits);
  for(const kind of ['analysis','action','link']){
    await f.store.query('UPDATE circle_entitlements SET '+kind+'_used=$1 WHERE invoice_id=$2',[p.limits[kind]-1,'in_tier']);
    await f.store.reserve(member.id,kind,config);
    await assert.rejects(f.store.reserve(member.id,kind,config),e=>e.code==='quota_exceeded'&&e.quotaKind===kind&&e.retryAt===end);
  }
  await f.service.processEvent({id:'evt_duplicate_'+p.id,type:'invoice.paid',livemode:false,data:{object:f.state.invoice}});
  assert.equal((await f.store.status(member.id)).usage.analysis.used,p.limits.analysis);
  const forged=documents(p);forged.invoice.amount_paid=p.amount-1;
  assert.equal(paidPeriod(forged.invoice,forged.sub,config),null);
  assert.throws(()=>validatePrice({...makePrice(p),unit_amount:1},config,p));
  assert.throws(()=>validatePrice({...makePrice(p),tax_behavior:'exclusive'},config,p));
  f.close();
});
test('legacy invoices retain 1980 yen, 100 analyses and two list requests after new tiers exist',async()=>{
  const f=await fixture(PLAN);
  await f.store.reserve(member.id,'analysis',config);
  const a=await f.store.reserveList(member.id,config);assert.equal(a.maxResults,100);
  await f.store.settleList(member.id,a.reservationId,5);
  const status=await f.store.status(member.id);
  assert.equal(status.plan.id,'legacy1980');assert.equal(status.listUnit,'requests');
  assert.equal(status.usage.analysis.limit,100);assert.equal(status.usage.analysis.used,1);
  assert.deepEqual(status.usage.list,{used:1,limit:2});f.close();
});
test('switching an unpaid checkout expires the old plan; retries reuse the new plan',async()=>{
  const f=await fixture(PLANS[0],false);
  await f.service.checkout(member,'light');await f.service.checkout(member,'standard');await f.service.checkout(member,'standard');
  assert.deepEqual(f.expires,['cs_1']);assert.equal(f.creates.length,2);
  assert.equal(f.creates[1].params.line_items[0].price,'price_standard');
  assert.notEqual(f.creates[0].options.idempotencyKey,f.creates[1].options.idempotencyKey);
  await assert.rejects(f.service.checkout(member,'invented'),e=>e.code==='invalid_plan');
  f.close();
});
test('an already-completed old checkout cannot be replaced with another payable contract',async()=>{
  const f=await fixture(PLANS[0],false);
  await f.service.checkout(member,'light');f.sessions.get('cs_1').status='complete';
  await assert.rejects(f.service.checkout(member,'max1000'),e=>e.code==='payment_pending');
  assert.equal(f.creates.length,1);assert.equal(f.expires.length,0);f.close();
});
test('a stale browser cannot silently buy the old plan after the new catalog launches',async()=>{
  const f=await fixture(PLANS[0],false);
  for(const body of [{},{planId:'legacy1980'}]){
    const response=await f.service.handle(new Request(origin+'/api/billing/checkout',{method:'POST',headers:{origin,'x-circle-request':'membership'},body:JSON.stringify(body)}),member);
    assert.equal(response.status,400);assert.equal((await response.json()).code,'invalid_plan');
  }
  assert.equal(f.creates.length,0);f.close();
});
test('parallel list requests cannot exceed 50; successful short page releases exactly the unused people once',async()=>{
  const f=await fixture();
  const results=await Promise.allSettled(Array.from({length:6},()=>f.store.reserveList(member.id,config)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const r=results.find(r=>r.status==='fulfilled').value;assert.equal(r.maxResults,50);
  await f.store.settleList('other-member',r.reservationId,10);
  assert.equal((await f.store.status(member.id)).usage.list.used,50);
  await f.store.settleList(member.id,r.reservationId,10);await f.store.settleList(member.id,r.reservationId,0);
  assert.equal((await f.store.status(member.id)).usage.list.used,10);
  assert.equal((await f.store.query('SELECT used_units FROM circle_api_budget'))[0].used_units,1000);
  assert.equal((await f.store.reserveList(member.id,config)).maxResults,40);f.close();
});
test('global budget failure rolls back list quota; ambiguous upstream failure keeps reservation',async()=>{
  const f=await fixture();
  await assert.rejects(f.store.reserveList(member.id,{...config,dailyUnits:1}),e=>e.code==='service_budget');
  assert.equal((await f.store.status(member.id)).usage.list.used,0);
  await f.store.reserveList(member.id,config);
  assert.equal((await f.store.status(member.id)).usage.list.used,50);
  assert.equal((await f.store.query('SELECT * FROM circle_list_reservations')).length,1);f.close();
});
for(const p of [PLANS[0],PLANS[3]]) test(p.id+': actual X request size, cached re-display and explicit pagination match the paid allowance',async()=>{
  const f=await fixture(p),secret='local-test-secret-abcdefghijklmnopqrstuvwxyz';
  const DB=database(':memory:',readFileSync(new URL('../netlify/database/migrations/20260908000100_circle.sql',import.meta.url),'utf8'));
  await DB.prepare('INSERT INTO circle_sessions VALUES (?,?,?,?)').bind('sid','session',await seal({token:'fixture',tokenExpires:Date.now()+3600000,user:{id:'1',username:'me'},csrf:'csrf',viewer:member.id},secret),Date.now()+3600000).run();
  const calls=[],xenv={DB,APP_ORIGIN:origin,X_CLIENT_ID:'fixture',SESSION_SECRET:secret,MEMBER_ID:member.id,PLAN_ID:p.id,
    BILLING:{reserveList:()=>f.store.reserveList(member.id,config),settleList:(id,count)=>f.store.settleList(member.id,id,count)},
    fetch:async url=>{calls.push(url);const u=new URL(url),n=Number(u.searchParams.get('max_results')),page=Number(u.searchParams.get('pagination_token')||0);
      return Response.json({data:Array.from({length:n},(_,i)=>({id:String(page*100+i+2),username:'person'+(page*100+i),created_at:'2020-01-01T00:00:00Z'})),meta:{next_token:String(page+1)}});}
  };
  const req=cursor=>new Request(origin+'/api/x/list'+(cursor?'?cursor='+cursor:''),{headers:{cookie:'circle_sid=sid'}});
  let cursor='';
  for(let i=0;i<Math.ceil(p.limits.list/100);i++){
    const r=await handle(req(cursor),xenv);assert.equal(r.status,200);const data=await r.json();
    assert.equal(data.users.length,Math.min(100,p.limits.list));cursor=data.next;
  }
  assert.equal((await f.store.status(member.id)).usage.list.used,p.limits.list);
  const count=calls.length;
  assert.equal((await handle(req(''),xenv)).status,200);assert.equal(calls.length,count);
  assert.equal((await handle(req(cursor),xenv)).status,429);assert.equal(calls.length,count);
  assert.equal(new URL(calls[0]).searchParams.get('max_results'),p.id==='light'?'50':'100');
  assert.ok(calls.every(url=>!url.includes('/tweets')));
  DB.raw.close();f.close();
});
