import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {handle} from '../server/core.mjs';
import {serve} from '../server/handler.mjs';
import {BillingError} from '../server/plan.mjs';
import {oauthFailureResponse} from '../server/oauth-result.mjs';
import {database} from './sqlite-harness.mjs';

const origin='https://marinqueen.com';
const schema=readFileSync(new URL('../netlify/database/migrations/20260908000100_circle.sql',import.meta.url),'utf8');
const tokenResponse={access_token:'never-log-this-access-token',scope:'tweet.read users.read follows.read follows.write',expires_in:7200};
const profile={data:{id:'1234',name:'Fixture',username:'fixture'}};
const result=response=>new URL(response.headers.get('location')).searchParams.get('auth');

async function fixture(t, options={}) {
  const DB=database(':memory:',schema), logs=[], calls=[], reservations=[];
  t.after(()=>DB.raw.close());
  t.mock.method(console,'warn',(...args)=>logs.push(args));
  const env={DB,APP_ORIGIN:origin,X_CLIENT_ID:'client-fixture',X_CLIENT_SECRET:'client-secret-fixture',
    SESSION_SECRET:'x'.repeat(40),MEMBER_ID:'member-fixture',BILLING:{
      reserve:async kind=>{reservations.push(kind);if(options.reserveError)throw options.reserveError;},
      bindX:async()=>{if(options.bindError)throw options.bindError;}
    },fetch:async(url,request)=>{
      calls.push({url,request});
      if(url.endsWith('/oauth2/token')) {
        if(options.networkError)throw Error('Network failure with never-log-this-access-token');
        return Response.json(options.tokenBody??tokenResponse,{status:options.tokenStatus??200});
      }
      if(url.includes('/users/me?'))return Response.json(options.profileBody??profile,{status:options.profileStatus??200});
      throw Error('Unexpected X request');
    }};
  const start=await handle(new Request(origin+'/api/x/oauth/start',{method:'POST',headers:{origin},body:'{}'}),env);
  const auth=new URL((await start.json()).url), browser=start.headers.get('set-cookie').split(';')[0];
  const callback=(query='code=private-auth-code',headers={})=>new Request(origin+'/api/x/oauth/callback?state='+auth.searchParams.get('state')+'&'+query,{headers:{cookie:browser,...headers}});
  return {env,DB,logs,calls,reservations,auth,callback};
}

test('successful confidential OAuth still validates PKCE, stores a session, and consumes a link once',async t=>{
  const f=await fixture(t);
  assert.equal(f.auth.searchParams.get('redirect_uri'),origin+'/api/x/oauth/callback');
  assert.equal(f.auth.searchParams.get('code_challenge_method'),'S256');
  const response=await handle(f.callback(),f.env);
  assert.equal(result(response),'connected');
  assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].request.headers.Authorization,'Basic '+btoa('client-fixture:client-secret-fixture'));
  const form=new URLSearchParams(f.calls[0].request.body);
  assert.ok(form.get('code_verifier'));
  assert.equal(form.get('redirect_uri'),origin+'/api/x/oauth/callback');
  assert.deepEqual(f.reservations,['link']);
  assert.equal(f.DB.raw.prepare("SELECT COUNT(*) AS n FROM circle_sessions WHERE kind='session'").get().n,1);
  assert.ok(response.headers.getSetCookie().some(x=>x.startsWith('circle_sid=')&&x.includes('HttpOnly')&&x.includes('Secure')));
  assert.equal(result(await handle(f.callback(),f.env)),'state_error');
  assert.equal(f.calls.length,2);
  assert.deepEqual(f.reservations,['link']);
});

test('callback failures distinguish the failing step without retrying or creating a session',async t=>{
  const cases=[
    ['X credits', {profileStatus:402,profileBody:{detail:'never-log-this-access-token'}},'x_credits_depleted','profile',2],
    ['X permission', {profileStatus:403},'x_permission_denied','profile',2],
    ['X token', {profileStatus:401},'x_token_invalid','profile',2],
    ['X rate limit', {profileStatus:429},'x_rate_limited','profile',2],
    ['client settings', {tokenStatus:401,tokenBody:{error:'invalid_client',error_description:'client-secret-fixture'}},'oauth_app_settings','token',1],
    ['expired code', {tokenStatus:400,tokenBody:{error:'invalid_grant'}},'oauth_code_invalid','token',1],
    ['unrecognized upstream error', {tokenStatus:400,tokenBody:{error:'https://evil.example/?secret=client-secret-fixture'}},'oauth_rejected','token',1],
    ['network', {networkError:true},'oauth_network','token',1],
    ['scope', {tokenBody:{...tokenResponse,scope:'users.read'}},'scope','scopes',1],
    ['profile shape', {profileBody:{data:{id:'invalid'}}},'oauth_profile_invalid','profile',2],
    ['account binding', {bindError:new BillingError(409,'private member details','x_account_mismatch')},'x_account_mismatch','binding',2],
    ['link quota', {reserveError:new BillingError(429,'quota','quota_exceeded')},'link_quota_exceeded','quota',0],
    ['daily budget', {reserveError:new BillingError(503,'budget','service_budget')},'service_budget','quota',0]
  ];
  for(const [label,options,code,stage,count] of cases)await t.test(label,async t=>{
    const f=await fixture(t,options);
    const response=await handle(f.callback(),f.env);
    assert.equal(response.status,303);
    assert.equal(result(response),code);
    assert.equal(f.calls.length,count);
    assert.equal(f.DB.raw.prepare("SELECT COUNT(*) AS n FROM circle_sessions WHERE kind='session'").get().n,0);
    assert.equal(f.DB.raw.prepare("SELECT COUNT(*) AS n FROM circle_sessions WHERE kind='oauth'").get().n,0);
    const log=JSON.parse(f.logs.at(-1)[1]);
    assert.equal(log.stage,stage);
    assert.equal(log.code,code);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('auth_ref'),log.reference);
    const exposed=JSON.stringify(f.logs)+response.headers.get('location');
    for(const secret of ['never-log-this-access-token','client-secret-fixture','private-auth-code','private member details','evil.example'])
      assert.ok(!exposed.includes(secret));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  });
});

test('wrong browser or member cannot exchange an OAuth code or spend a link',async t=>{
  for(const mismatch of ['browser','member'])await t.test(mismatch,async t=>{
    const f=await fixture(t);
    if(mismatch==='member')f.env.MEMBER_ID='different-member';
    const response=await handle(f.callback('code=private-auth-code',mismatch==='browser'?{cookie:'circle_oauth=wrong'}:{}),f.env);
    assert.equal(result(response),'state_error');
    assert.deepEqual(f.reservations,[]);
    assert.equal(f.calls.length,0);
  });
});

test('concurrent copies of one callback exchange the code only once',async t=>{
  const f=await fixture(t);
  const responses=await Promise.all([handle(f.callback(),f.env),handle(f.callback(),f.env)]);
  assert.deepEqual(responses.map(result).sort(),['connected','state_error']);
  assert.equal(f.calls.length,2);
  assert.deepEqual(f.reservations,['link']);
});

test('user cancellation and provider configuration rejection remain different without spending a link',async t=>{
  for(const [reason,expected] of [['access_denied','cancelled'],['invalid_scope','scope']])await t.test(reason,async t=>{
    const f=await fixture(t),response=await handle(f.callback('error='+reason),f.env);
    assert.equal(result(response),expected);
    assert.equal(f.calls.length,0);
    assert.deepEqual(f.reservations,[]);
  });
});

test('outer membership and billing checks remain enforced and identify the failure',async t=>{
  t.mock.method(console,'warn',()=>{});
  const variables={APP_ORIGIN:origin,X_CLIENT_ID:'client-fixture',X_CLIENT_SECRET:'secret-fixture',SESSION_SECRET:'x'.repeat(40),
    BILLING_ENABLED:'true',STRIPE_MODE:'test',STRIPE_SECRET_KEY:'rk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',
    STRIPE_PRICE_ID:'price_fixture',STRIPE_PORTAL_CONFIG_ID:'bpc_fixture',MERCHANT_DETAILS_CONFIRMED:'true'};
  for(const [user,expected] of [[null,'login_required'],[{id:'member',email:'fixture@example.test'},'subscription_required']]) {
    let xCalls=0;
    const response=await serve(new Request(origin+'/api/x/oauth/callback?state=untrusted&code=secret',{
      headers:{'oai-authenticated-user-id':'forged-member'}
    }),variables,()=>({sql:async()=>[]}),{getUser:async()=>user,
      billing:{store:{assertAccess:async()=>{throw new BillingError(402,'private details','subscription_required');}}},
      fetch:async()=>{xCalls++;throw Error('Must not call X');}});
    assert.equal(result(response),expected);
    assert.equal(xCalls,0);
  }
});

test('unexpected exceptions produce a safe reference, not credentials or raw URLs',t=>{
  const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
  const error=Object.assign(new Error('database-password/private-email@example.test'),{code:'secret-code',status:999});
  const response=oauthFailureResponse(error,origin,'secret-stage');
  assert.equal(result(response),'failed');
  const log=JSON.parse(logs[0][1]);
  assert.equal(log.stage,'request');
  assert.equal(log.status,undefined);
  const output=JSON.stringify(logs)+response.headers.get('location');
  for(const secret of ['database-password','private-email','secret-code','secret-stage'])assert.ok(!output.includes(secret));
});

test('browser text identifies credits, quota, and account mismatch without reflecting URL text',()=>{
  const source=readFileSync(new URL('../public/assets/circle-app.js',import.meta.url),'utf8');
  const context={};
  vm.runInNewContext(source.split('/* End CIRCLE X OAuth messages */')[0],context);
  assert.match(context.circleXOauthFailureMessage('x_credits_depleted'),/X側からクレジット不足/);
  assert.match(context.circleXOauthFailureMessage('link_quota_exceeded'),/X連携枠/);
  assert.match(context.circleXOauthFailureMessage('x_account_mismatch'),/契約の組み合わせ/);
  assert.ok(!context.circleXOauthFailureMessage('<script>secret</script>','evil-secret').includes('secret'));
  assert.match(context.circleXOauthFailureMessage('failed','01234567-89ab-4cde-8fab-0123456789ab'),/確認番号：01234567/);
});
