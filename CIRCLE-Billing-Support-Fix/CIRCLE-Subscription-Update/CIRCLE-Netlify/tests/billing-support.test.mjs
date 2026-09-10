import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, runInNewContext} from 'node:vm';
import {createBillingStore} from '../server/billing-store.mjs';
import {createBillingService} from '../server/billing.mjs';
import {billingConfig, billingFailure} from '../server/plan.mjs';
import {handle, seal} from '../server/core.mjs';
import {billingPool} from './billing-harness.mjs';
import {database} from './sqlite-harness.mjs';

const origin='https://marinqueen.com';
const start=Date.parse('2026-09-11T00:00:00Z'), end=Date.parse('2026-10-11T00:00:00Z');
const user={id:'support-test-member',email:'support@example.test'};
const env={APP_ORIGIN:origin,STRIPE_MODE:'test',STRIPE_SECRET_KEY:'rk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',
  STRIPE_PRICE_ID:'price_fixture',STRIPE_PORTAL_CONFIG_ID:'bpc_fixture',BILLING_ENABLED:'true',MERCHANT_DETAILS_CONFIRMED:'true'};
const sub={id:'sub_fixture',status:'active',cancel_at_period_end:false};
async function billingFixture() {
  const pool=billingPool(), store=createBillingStore(pool,()=>start+60000);
  await store.ensureMember(user.id);await store.setCustomer(user.id,'cus_fixture');
  await store.syncSubscription(user.id,sub);
  await store.grant(user.id,{id:'in_fixture'},sub,{start:start/1000,end:end/1000});
  return {pool,store,close:()=>pool.raw.close()};
}
async function xFixture(reserve) {
  const schema=readFileSync(new URL('../netlify/database/migrations/20260908000100_circle.sql',import.meta.url),'utf8');
  const DB=database(':memory:',schema), secret='support-test-encryption-secret-abcdefghijklmnopqrstuvwxyz';
  const now=Date.now();
  const session={token:'test-only-token',tokenExpires:now+3600000,user:{id:'1',username:'fixture'},csrf:'fixture',viewer:'local'};
  await DB.prepare('INSERT INTO circle_sessions VALUES (?,?,?,?)').bind('sid','session',await seal(session,secret),now+3600000).run();
  const runtime={DB,APP_ORIGIN:origin,X_CLIENT_ID:'fixture',SESSION_SECRET:secret,BILLING:{reserve,bindX:async()=>{}}};
  const request=()=>new Request(origin+'/api/x/list',{headers:{cookie:'circle_sid=sid'}});
  return {runtime,request,close:()=>DB.raw.close()};
}
test('two failed X list attempts leave analysis unused and the third reports the real monthly limit',async()=>{
  const b=await billingFixture();
  const x=await xFixture(kind=>b.store.reserve(user.id,kind,billingConfig(env)));
  let calls=0;
  x.runtime.fetch=async()=>{calls++;return Response.json({title:'CreditsDepleted'},{status:402,
    headers:{'x-rate-limit-reset':String(Math.floor(Date.now()/1000)+900)}});};
  try {
    for(let i=0;i<2;i++) {
      const response=await handle(x.request(),x.runtime), data=await response.json();
      assert.equal(response.status,402);assert.equal(data.code,'x_credits_depleted');
      assert.equal(data.retryAt,null);assert.match(data.error,/運営側の補充後/);
    }
    const response=await handle(x.request(),x.runtime), data=await response.json();
    assert.equal(response.status,429);assert.equal(data.code,'quota_exceeded');
    assert.equal(data.quotaKind,'list');assert.equal(data.retryAt,end);
    assert.match(data.error,/一覧取得.*2回/);assert.match(data.error,/2026年10月11日/);
    const status=await b.store.status(user.id);
    assert.equal(status.usage.analysis.used,0);assert.equal(status.usage.list.used,2);assert.equal(calls,2);
  } finally {x.close();b.close();}
});
test('cancelled renewal does not promise a new allowance and billing errors preserve retry metadata',async()=>{
  const b=await billingFixture();
  try {
    await b.store.syncSubscription(user.id,{...sub,cancel_at_period_end:true});
    await b.store.query('UPDATE circle_entitlements SET list_used=2 WHERE invoice_id=$1',['in_fixture']);
    let failure;try{await b.store.reserve(user.id,'list',billingConfig(env));}catch(error){failure=error;}
    assert.ok(failure);const data=await billingFailure(failure).json();
    assert.match(data.error,/自動更新されません/);assert.equal(data.quotaKind,'list');assert.equal(data.retryAt,end);
    assert.equal((await b.store.status(user.id)).usage.list.used,2);
  } finally {b.close();}
});
const portalRequest=()=>new Request(origin+'/api/billing/portal',{method:'POST',headers:{origin,'x-circle-request':'membership'}});
test('portal remains usable while X is paused and quotas are exhausted',async()=>{
  const b=await billingFixture();let parameters;
  try {
    await b.store.query('UPDATE circle_entitlements SET list_used=2,analysis_used=100 WHERE invoice_id=$1',['in_fixture']);
    const stripe={billingPortal:{sessions:{create:async params=>{parameters=params;return {url:'https://billing.stripe.com/p/session/fixture'};}}}};
    const service=createBillingService({stripe,store:b.store,env:{...env,CIRCLE_API_PAUSED:'true'}});
    const response=await service.handle(portalRequest(),user);
    assert.equal(response.status,200);assert.equal(parameters.customer,'cus_fixture');
    assert.equal(parameters.configuration,'bpc_fixture');assert.equal(parameters.return_url,origin+'/?payment=return');
    assert.equal((await b.store.status(user.id)).usage.list.used,2);
  } finally {b.close();}
});
test('portal permission failure has a distinct code and never logs secrets or raw Stripe responses',async()=>{
  const b=await billingFixture(), logs=[];
  try {
    const stripe={billingPortal:{sessions:{create:async()=>{throw Object.assign(new Error('RAW_SECRET_AND_CUSTOMER'),{
      type:'StripePermissionError',statusCode:403,requestId:'req_fixture',code:'permission_denied',
      raw:{secret:'RAW_SECRET_AND_CUSTOMER'},headers:{authorization:'RAW_SECRET_AND_CUSTOMER'}});}}}};
    const service=createBillingService({stripe,store:b.store,env,logger:{error:(...args)=>logs.push(args)}});
    const response=await service.handle(portalRequest(),user), data=await response.json();
    assert.equal(response.status,503);assert.equal(data.code,'portal_permission_denied');
    assert.equal(logs[0][1].requestId,'req_fixture');
    assert.ok(!JSON.stringify({data,logs}).includes('RAW_SECRET_AND_CUSTOMER'));
    assert.equal((await b.store.status(user.id)).active,true);
    assert.equal((await b.store.status(user.id)).cancelAtPeriodEnd,false);
  } finally {b.close();}
});
test('recovered app countdown applies to X rate limits and never invents a 15-minute monthly reset',()=>{
  const source=readFileSync(new URL('../public/assets/circle-app.js',import.meta.url),'utf8');
  new Script(source);
  const begin='let qa=Ke;me(qa.message),', at=source.indexOf(begin), stop=source.indexOf(',B(',at);
  assert.ok(at>=0&&stop>at);const expression=source.slice(at+begin.length,stop);
  const run=qa=>{const values=[];runInNewContext(expression,{qa,ue:value=>values.push(value),Le:()=>{},Date});return values;};
  assert.deepEqual(run({status:429,code:'quota_exceeded'}),[]);
  assert.deepEqual(run({status:429,code:'quota_exceeded',retryAt:end}),[]);
  assert.deepEqual(run({status:429,code:'x_api',retryAt:end}),[end]);
  assert.deepEqual(run({status:402,code:'x_credits_depleted'}),[]);
});
