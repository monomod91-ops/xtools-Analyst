import test from 'node:test';
import assert from 'node:assert/strict';
import {createBillingStore} from '../server/billing-store.mjs';
import {createBillingService,paidPeriod,validatePrice} from '../server/billing.mjs';
import {billingConfig,BillingError,PLAN} from '../server/plan.mjs';
import {billingPool} from './billing-harness.mjs';
const start=Date.parse('2026-09-10T00:00:00Z'),end=Date.parse('2026-10-10T00:00:00Z');
const origin='https://marinqueen.com';
const env={APP_ORIGIN:origin,STRIPE_MODE:'test',STRIPE_SECRET_KEY:'rk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_PRICE_ID:'price_circle',STRIPE_PORTAL_CONFIG_ID:'bpc_circle',BILLING_ENABLED:'true',MERCHANT_DETAILS_CONFIRMED:'true'};
const user={id:'member-one',email:'test@example.test',emailVerified:true};
const price={id:'price_circle',active:true,livemode:false,type:'recurring',unit_amount:1980,currency:'jpy',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
const sub={id:'sub_one',customer:'cus_one',status:'active',livemode:false,metadata:{circle_member_id:user.id},cancel_at_period_end:false,
  latest_invoice:'in_one',items:{data:[{price,quantity:1}],has_more:false}};
const invoice={id:'in_one',customer:'cus_one',status:'paid',livemode:false,currency:'jpy',amount_paid:1980,billing_reason:'subscription_create',
  parent:{type:'subscription_details',subscription_details:{subscription:'sub_one'}},lines:{data:[{quantity:1,amount:1980,pricing:{price_details:{price:'price_circle'}},
    parent:{type:'subscription_item_details',subscription_item_details:{proration:false}},period:{start:start/1000,end:end/1000}}],has_more:false}};
async function fixture(paid=true) {
  let now=start+60000;const pool=billingPool(),store=createBillingStore(pool,()=>now),calls=[];
  await store.ensureMember(user.id);await store.setCustomer(user.id,'cus_one');
  const state={sub:structuredClone(sub),invoice:structuredClone(invoice),price:structuredClone(price),sessions:new Map()};
  if(paid){await store.syncSubscription(user.id,state.sub);await store.grant(user.id,state.invoice,state.sub,{start:start/1000,end:end/1000});}
  const stripe={
    prices:{retrieve:async()=>state.price},customers:{create:async()=>({id:'cus_one'})},
    subscriptions:{retrieve:async()=>state.sub,list:async()=>({data:state.sub?[state.sub]:[],has_more:false})},
    invoices:{retrieve:async()=>state.invoice},
    checkout:{sessions:{retrieve:async id=>state.sessions.get(id),create:async(params,options)=>{calls.push({params,options});const s={id:'cs_one',url:'https://checkout.stripe.com/c/pay/test',status:'open',expires_at:params.expires_at};state.sessions.set(s.id,s);return s;}}},
    billingPortal:{sessions:{create:async params=>{calls.push(params);return{url:'https://billing.stripe.com/p/session/test'};}}},
    charges:{retrieve:async()=>({payment_intent:'pi_one'})},
    invoicePayments:{list:async function*(){yield{invoice:'in_one'};}},
    webhooks:{constructEventAsync:async(raw,sig)=>{if(sig!=='valid-fixture-signature')throw Error('invalid');return JSON.parse(raw);}}
  };
  const service=createBillingService({stripe,store,env,clock:()=>now}),config=billingConfig(env);
  return {pool,store,state,stripe,service,config,calls,setTime:t=>{now=t;},close:()=>pool.raw.close()};
}
const request=(route,method='GET',headers={})=>new Request(origin+'/api/billing/'+route,{method,headers:{origin,'x-circle-request':'membership',...headers}});
const event=(type,id='evt_one',object=invoice)=>({id,type,livemode:false,data:{object}});

test('billing defaults to disabled and secret/mode mismatch cannot enable it',()=>{
  assert.equal(billingConfig({}).enabled,false);
  assert.equal(billingConfig({...env,STRIPE_MODE:'live'}).enabled,false);
  assert.equal(billingConfig({...env,MERCHANT_DETAILS_CONFIRMED:'false'}).enabled,false);
  assert.equal(billingConfig(env).enabled,true);
});
test('no invoice, unverified member or forged role cannot obtain access',async()=>{
  const f=await fixture(false);
  assert.equal((await f.store.status(user.id)).active,false);
  await assert.rejects(f.store.reserve(user.id,'analysis',f.config),e=>e.status===402);
  for(const fake of [null,{...user,emailVerified:false},{id:user.id,roles:['paid'],user_metadata:{paid:true}}])
    assert.equal((await f.service.handle(request('checkout','POST'),fake)).status,401);
  assert.equal(f.calls.length,0);f.close();
});
test('only exact paid monthly plan invoices grant periods',()=>{
  const cfg=billingConfig(env);assert.ok(paidPeriod(invoice,sub,cfg));
  for(const patch of [{status:'open'},{amount_paid:0},{amount_paid:undefined},{amount_paid:'1980'},{currency:'usd'},{livemode:true},{billing_reason:'subscription_update'},
    {parent:{subscription_details:{subscription:'sub_other'}}},{lines:{...invoice.lines,has_more:true}}])
    assert.equal(paidPeriod({...invoice,...patch},sub,cfg),null);
  assert.equal(paidPeriod(invoice,{...sub,items:{data:[{price,quantity:2}]}},cfg),null);
  assert.throws(()=>validatePrice({...price,unit_amount:1},cfg));
});
test('Dahlia paid invoices without the removed paid flag activate a membership',async()=>{
  const f=await fixture(false);
  assert.equal(Object.hasOwn(f.state.invoice,'paid'),false);
  await f.service.processEvent(event('invoice.paid','evt_dahlia',f.state.invoice));
  assert.equal((await f.store.status(user.id)).active,true);
  await f.store.reserve(user.id,'analysis',f.config);
  assert.equal((await f.store.status(user.id)).usage.analysis.used,1);
  f.close();
});
test('parallel analysis requests stop exactly at the monthly limit',async()=>{
  const f=await fixture();
  await f.store.query('UPDATE circle_entitlements SET analysis_used=98 WHERE invoice_id=$1',['in_one']);
  const result=await Promise.allSettled(Array.from({length:20},()=>f.store.reserve(user.id,'analysis',f.config)));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(result.filter(r=>r.status==='rejected'&&r.reason.code==='quota_exceeded').length,18);
  assert.equal((await f.store.status(user.id)).usage.analysis.used,100);f.close();
});
test('every billable operation has its own bounded quota',async()=>{
  const f=await fixture();
  for(const kind of ['list','action','link']){
    const limit=PLAN.limits[kind];await f.store.query(`UPDATE circle_entitlements SET ${kind}_used=$1 WHERE invoice_id=$2`,[limit-1,'in_one']);
    await f.store.reserve(user.id,kind,f.config);
    await assert.rejects(f.store.reserve(user.id,kind,f.config),e=>e.code==='quota_exceeded');
  }f.close();
});
test('global budget refusal rolls back the customer quota and survives retries',async()=>{
  const f=await fixture();
  for(let i=0;i<3;i++)await assert.rejects(f.store.reserve(user.id,'list',{...f.config,dailyUnits:1}),e=>e.code==='service_budget');
  assert.equal((await f.store.status(user.id)).usage.list.used,0);
  await assert.rejects(f.store.reserve(user.id,'analysis',{...f.config,apiPaused:true}),e=>e.code==='api_paused');
  assert.equal((await f.store.status(user.id)).usage.analysis.used,0);f.close();
});
test('repeated and out-of-order payment notifications never reset usage',async()=>{
  const f=await fixture();await f.store.reserve(user.id,'analysis',f.config);
  await f.service.processEvent(event('invoice.paid'));await f.service.processEvent(event('invoice.paid'));
  await f.service.processEvent(event('invoice.paid','evt_duplicate_delivery'));
  assert.equal((await f.store.status(user.id)).usage.analysis.used,1);
  assert.equal((await f.store.query('SELECT * FROM circle_entitlements')).length,1);f.close();
});
test('renewal gives one new allowance, old unpaid periods do not grant access',async()=>{
  const f=await fixture();f.setTime(end+60000);
  assert.equal((await f.store.status(user.id)).active,false);
  f.state.invoice={...structuredClone(invoice),id:'in_two',billing_reason:'subscription_cycle'};
  f.state.invoice.lines.data[0].period={start:end/1000,end:Date.parse('2026-11-10')/1000};f.state.sub.latest_invoice='in_two';
  await f.service.processEvent(event('invoice.paid','evt_two',f.state.invoice));
  await f.store.reserve(user.id,'analysis',f.config);await f.service.processEvent(event('invoice.paid','evt_two_again',f.state.invoice));
  assert.equal((await f.store.status(user.id)).usage.analysis.used,1);assert.equal((await f.store.status(user.id)).active,true);f.close();
});
test('cancellation at period end retains paid time; terminal cancellation revokes',async()=>{
  const f=await fixture();f.state.sub.cancel_at_period_end=true;
  await f.service.processEvent(event('customer.subscription.updated','evt_cancel',f.state.sub));
  let s=await f.store.status(user.id);assert.equal(s.active,true);assert.equal(s.cancelAtPeriodEnd,true);
  f.state.sub.status='canceled';await f.service.processEvent(event('customer.subscription.deleted','evt_deleted',f.state.sub));
  assert.equal((await f.store.status(user.id)).active,false);f.close();
});
test('refund arriving before invoice.paid remains revoked after all replays',async()=>{
  const f=await fixture(false);
  await f.service.processEvent(event('charge.refunded','evt_refund',{id:'ch_one'}));
  await f.service.processEvent(event('invoice.paid'));
  assert.equal((await f.store.status(user.id)).active,false);
  await assert.rejects(f.store.reserve(user.id,'analysis',f.config),e=>e.status===402);f.close();
});
test('webhook signature or mode failure cannot change entitlement',async()=>{
  const f=await fixture(false);
  for(const signature of ['', 'forged']){
    const response=await f.service.handle(new Request(origin+'/api/billing/webhook',{method:'POST',headers:{'stripe-signature':signature},body:JSON.stringify(event('invoice.paid'))}),null);
    assert.equal(response.status,400);
  }
  await assert.rejects(f.service.processEvent({...event('invoice.paid'),livemode:true}),e=>e.code==='mode_mismatch');
  assert.equal((await f.store.status(user.id)).active,false);f.close();
});
test('checkout is fixed-price and reused; client supplied values are ignored',async()=>{
  const f=await fixture(false);f.state.sub=null;
  const injected=new Request(origin+'/api/billing/checkout',{method:'POST',headers:{origin,'x-circle-request':'membership'},body:JSON.stringify({price:'price_free',member_id:'victim',quantity:999})});
  assert.equal((await f.service.handle(injected,user)).status,200);
  assert.equal((await f.service.handle(request('checkout','POST'),user)).status,200);
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].params.line_items,[{price:'price_circle',quantity:1}]);
  assert.equal(f.calls[0].params.customer,'cus_one');assert.equal(f.calls[0].params.client_reference_id,user.id);
  assert.ok(f.calls[0].options.idempotencyKey.startsWith('circle-checkout-'));f.close();
});
test('cross-site checkout rejected and overdue subscription cannot buy a duplicate',async()=>{
  const f=await fixture();f.state.sub.status='past_due';
  assert.equal((await f.service.handle(request('checkout','POST',{origin:'https://evil.test'}),user)).status,403);
  assert.equal((await f.service.handle(request('checkout','POST'),user)).status,409);assert.equal(f.calls.length,0);f.close();
});
test('a lost Checkout response reuses the same request across a clock boundary and service restart',async()=>{
  const f=await fixture(false);f.state.sub=null;
  const attempts=[],created=new Map();
  f.stripe.checkout.sessions.create=async(params,options)=>{
    attempts.push(structuredClone({params,options}));
    const old=created.get(options.idempotencyKey);
    if(old){assert.deepEqual(params,old.params);return old.session;}
    const session={id:'cs_lost',url:'https://checkout.stripe.com/c/pay/lost',status:'open',expires_at:params.expires_at};
    created.set(options.idempotencyKey,{params:structuredClone(params),session});
    throw new Error('Connection lost after Stripe created the session');
  };
  await assert.rejects(f.service.checkout(user),/Connection lost/);
  const restartedAt=start+31*60000;f.setTime(restartedAt);
  const restarted=createBillingService({stripe:f.stripe,store:f.store,env,clock:()=>restartedAt});
  const result=await restarted.checkout(user);
  assert.equal(result.url,'https://checkout.stripe.com/c/pay/lost');
  assert.equal(created.size,1);
  assert.deepEqual(attempts[1],attempts[0]);
  f.close();
});
test('an expired unpaid Checkout attempt permits a fresh request',async()=>{
  const f=await fixture(false);f.state.sub=null;
  await f.service.checkout(user);
  f.setTime(start+63*60000);
  await f.service.checkout(user);
  assert.equal(f.calls.length,2);
  assert.notEqual(f.calls[1].options.idempotencyKey,f.calls[0].options.idempotencyKey);
  assert.ok(f.calls[1].params.expires_at>f.calls[0].params.expires_at);
  f.close();
});
test('checkout return flag alone grants nothing; portal uses the authenticated customer',async()=>{
  const f=await fixture(false);
  assert.equal((await f.service.handle(request('status?payment=success'),user)).status,200);
  assert.equal((await f.store.status(user.id)).active,false);
  await f.service.handle(request('portal','POST'),user);
  assert.equal(f.calls[0].customer,'cus_one');assert.equal(f.calls[0].configuration,'bpc_circle');f.close();
});
test('one X account per member and one membership per X account',async()=>{
  const f=await fixture();await f.store.bindX(user.id,'123');await f.store.bindX(user.id,'123');
  await assert.rejects(f.store.bindX(user.id,'456'),e=>e.code==='x_account_mismatch');
  await f.store.ensureMember('member-two');await assert.rejects(f.store.bindX('member-two','123'),e=>e.code==='x_account_mismatch');f.close();
});
