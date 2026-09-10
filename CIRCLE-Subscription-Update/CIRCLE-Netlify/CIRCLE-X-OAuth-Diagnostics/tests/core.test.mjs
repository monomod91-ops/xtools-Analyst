import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handle,seal,classify,unseal} from '../server/core.mjs';
import {database} from './sqlite-harness.mjs';
import {BillingError} from '../server/plan.mjs';
const origin='http://127.0.0.1:8787';
const secret='test-only-random-secret-abcdefghijklmnopqrstuvwxyz';
const user={id:'2',name:'Other',username:'other',created_at:'2020-01-01T00:00:00Z',protected:false,connection_status:['following','followed_by']};
const schema=readFileSync(new URL('../netlify/database/migrations/20260908000100_circle.sql',import.meta.url),'utf8');
const oldPost={data:[{id:'10',created_at:'2020-01-02T00:00:00Z'}]};
async function fixture(extra={}){
 const DB=database(':memory:',schema),calls=[];
 const env={DB,APP_ORIGIN:origin,X_CLIENT_ID:'test-client',SESSION_SECRET:secret,X_ENABLE_BLOCKS:'true',BILLING:{reserve:async()=>{},bindX:async()=>{}},...extra};
 const s={token:'sensitive-test-token',tokenExpires:Date.now()+3600000,user:{id:'1',name:'Me',username:'me'},csrf:'csrf-test',viewer:'local'};
 await DB.prepare('INSERT INTO circle_sessions VALUES (?,?,?,?)').bind('sid','session',await seal(s,secret),Date.now()+3600000).run();
 env.fetch=async(url,options)=>{calls.push({url,options});if(url.includes('/2/users/2?'))return Response.json({data:user});if(url.includes('/2/users/2/tweets'))return Response.json(oldPost);if(options.method==='DELETE'&&url.includes('/following/'))return Response.json({data:{following:false}});if(options.method==='POST'&&url.endsWith('/blocking'))return Response.json({data:{blocking:true}});if(options.method==='DELETE'&&url.includes('/blocking/'))return Response.json({data:{blocking:false}});throw Error('Unexpected endpoint '+url)};
 const request=(path,data,headers={})=>new Request(origin+'/api/x/'+path,{method:data===undefined?'GET':'POST',headers:{cookie:'circle_sid=sid',origin,'x-csrf-token':'csrf-test',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 return{env,DB,calls,request};
}
test('7 day boundary, new accounts and unreadable data are handled conservatively',()=>{
 const now=Date.parse('2026-09-08T00:00:00Z');const at=iso=>({data:[{created_at:iso}]});
 assert.equal(classify(user,at('2026-09-01T00:00:00Z'),now).status,'active');
 assert.equal(classify(user,at('2026-08-31T23:59:59Z'),now).status,'candidate');
 assert.equal(classify(user,at('2026-09-07T00:00:00Z'),now).status,'active');
 assert.equal(classify({...user,protected:true},oldPost,now).status,'unknown');
 assert.equal(classify(user,{},now).status,'unknown');
 assert.equal(classify(user,{...oldPost,errors:[{}]},now).status,'unknown');
 assert.equal(classify(user,at('malformed'),now).status,'unknown');
 assert.equal(classify(user,{data:[{created_at:'2020-01-01'},{created_at:'bad'}]},now).status,'unknown');
 assert.equal(classify({...user,created_at:null},oldPost,now).status,'unknown');
 assert.equal(classify({...user,created_at:'2026-09-06T00:00:00Z'},oldPost,now).status,'active');
 assert.equal(classify(user,{data:[{created_at:'2020-01-01'},{created_at:'2026-09-07'}]},now).status,'active');
});
test('tokens are encrypted and tampered ciphertext fails closed',async()=>{const f=await fixture();const r=f.DB.raw.prepare('SELECT payload FROM circle_sessions').get();assert.ok(!r.payload.includes('sensitive-test-token'));assert.equal((await unseal(r.payload,secret)).token,'sensitive-test-token');assert.equal(await unseal(r.payload.slice(0,-6)+'wrong!',secret),null);f.DB.raw.close()});
test('configuration and authentication fail closed',async()=>{const f=await fixture();assert.equal((await handle(f.request('action',{operation:'unfollow'}),{...f.env,X_CLIENT_ID:''})).status,503);assert.equal((await handle(f.request('action',{}, {cookie:''}),f.env)).status,401);assert.equal((await handle(f.request('session'),{...f.env,REQUIRE_WORKSPACE_AUTH:'true'})).status,401);assert.equal(f.calls.length,0);f.DB.raw.close()});
test('CSRF, cross origin, missing confirmation and invalid IDs cannot mutate',async()=>{const f=await fixture();const data={operation:'unfollow',targetId:'2',confirmed:true,days:7};for(const[patch,headers,status]of[[{}, {origin:'https://evil.example'},403],[{}, {'x-csrf-token':''},403],[{confirmed:false},{},400],[{targetId:'2/3'},{},400],[{targetId:'1'},{},400]])assert.equal((await handle(f.request('action',{...data,...patch},headers),f.env)).status,status);assert.equal(f.calls.length,0);f.DB.raw.close()});
test('unfollow rechecks current relation and activity then records success',async()=>{const f=await fixture();const r=await handle(f.request('action',{operation:'unfollow',targetId:'2',confirmed:true,days:7}),f.env);assert.equal(r.status,200);assert.deepEqual(f.calls.map(c=>c.options.method||'GET'),['GET','GET','DELETE']);assert.equal(f.DB.raw.prepare('SELECT status FROM circle_actions').get().status,'success');assert.equal(f.DB.raw.prepare("SELECT COUNT(*) AS n FROM circle_sessions WHERE kind='lock'").get().n,0);f.DB.raw.close()});
test('a fresh post prevents an unfollow even with a previously displayed candidate',async()=>{const f=await fixture();const base=f.env.fetch;f.env.fetch=(url,o)=>url.includes('/tweets')?Promise.resolve(Response.json({data:[{created_at:new Date().toISOString()}]})):base(url,o);assert.equal((await handle(f.request('action',{operation:'unfollow',targetId:'2',confirmed:true,days:7}),f.env)).status,409);assert.equal(f.calls.filter(c=>c.options.method==='DELETE').length,0);f.DB.raw.close()});
test('unknown relation and already-blocked accounts cannot be soft blocked',async()=>{for(const relation of[undefined,['blocking']]){const f=await fixture();f.env.fetch=async(url,o)=>{f.calls.push({url,options:o});return Response.json({data:{...user,connection_status:relation}})};assert.equal((await handle(f.request('action',{operation:'softblock',targetId:'2',confirmed:true,days:7}),f.env)).status,409);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);f.DB.raw.close()}});
test('Enterprise disabled rejects block writes before any X call',async()=>{const f=await fixture({X_ENABLE_BLOCKS:'false'});assert.equal((await handle(f.request('action',{operation:'softblock',targetId:'2',confirmed:true,days:7}),f.env)).status,403);assert.equal(f.calls.length,0);f.DB.raw.close()});
test('partial soft-block failure remains visible and can be recovered by unblock only',async()=>{const f=await fixture();let blocked=false;const base=f.env.fetch;f.env.fetch=async(url,o)=>{if(o.method==='POST'&&url.endsWith('/blocking')){blocked=true;return base(url,o)}if(o.method==='DELETE'&&url.includes('/blocking/')){f.calls.push({url,options:o});return Response.json({error:'rate_limit'},{status:429,headers:{'x-rate-limit-reset':String(Math.ceil(Date.now()/1000)+900)}})}return base(url,o)};const r=await handle(f.request('action',{operation:'softblock',targetId:'2',confirmed:true,days:7}),f.env);assert.equal(r.status,429);assert.equal((await r.json()).state,'blocked_pending');assert.equal(f.DB.raw.prepare('SELECT status FROM circle_actions').get().status,'blocked_pending');assert.ok(blocked);const before=f.calls.length;f.env.fetch=async(url,o)=>url.includes('/2/users/2?')?Response.json({data:{...user,connection_status:['blocking']}}):base(url,o);assert.equal((await handle(f.request('action',{operation:'unblock',targetId:'2',confirmed:true}),f.env)).status,200);assert.equal(f.calls.slice(before).filter(c=>c.options.method==='POST').length,0);f.DB.raw.close()});
test('account lock prevents concurrent writes',async()=>{const f=await fixture();await f.DB.prepare("INSERT INTO circle_sessions VALUES ('lock:1','lock','',?)").bind(Date.now()+60000).run();assert.equal((await handle(f.request('action',{operation:'unfollow',targetId:'2',confirmed:true,days:7}),f.env)).status,409);assert.equal(f.calls.length,0);f.DB.raw.close()});
test('rate limit is returned without retries and list pagination is retained',async()=>{const f=await fixture();f.env.fetch=async(url,o)=>{f.calls.push({url,options:o});return Response.json({data:[user],meta:{next_token:'opaque-next'}})};const list=await(await handle(f.request('list?kind=following&cursor=opaque-first'),f.env)).json();assert.equal(list.next,'opaque-next');assert.ok(f.calls[0].url.includes('pagination_token=opaque-first'));assert.ok(list.users[0].proof);f.env.fetch=async()=>Response.json({}, {status:429,headers:{'x-rate-limit-reset':String(Math.ceil(Date.now()/1000)+60)}});const r=await handle(f.request('activity',{proof:list.users[0].proof,days:7}),f.env);assert.equal(r.status,429);assert.ok((await r.json()).retryAt>Date.now());f.DB.raw.close()});
test('OAuth uses S256, browser-bound state, one-time state and safe redirect',async()=>{const f=await fixture();const start=await handle(f.request('oauth/start',{}),f.env);const auth=new URL((await start.json()).url);assert.equal(auth.origin,'https://x.com');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.ok(auth.searchParams.get('code_challenge'));assert.ok(!auth.searchParams.get('scope').includes('offline.access'));const state=auth.searchParams.get('state'),browser=start.headers.get('set-cookie').split(';')[0];let exchanges=0;f.env.fetch=async(url,o)=>{if(url.endsWith('/oauth2/token')){exchanges++;assert.ok(o.body.includes('code_verifier='));return Response.json({access_token:'oauth-test-token',scope:'tweet.read users.read follows.read follows.write block.read block.write',expires_in:7200})}if(url.includes('/users/me'))return Response.json({data:{id:'1',name:'Me',username:'me'}});throw Error('unexpected')};const bad=await handle(f.request('oauth/callback?state='+state+'&code=abc',undefined,{cookie:'circle_oauth=wrong'}),f.env);assert.equal(new URL(bad.headers.get('location')).searchParams.get('auth'),'state_error');assert.equal(exchanges,0);const ok=await handle(f.request('oauth/callback?state='+state+'&code=abc',undefined,{cookie:browser}),f.env);assert.equal(ok.status,303);assert.ok(ok.headers.get('location').endsWith('auth=connected'));assert.ok(ok.headers.getSetCookie().some(c=>c.startsWith('circle_sid=')&&c.includes('HttpOnly')));assert.equal(exchanges,1);await handle(f.request('oauth/callback?state='+state+'&code=abc',undefined,{cookie:browser}),f.env);assert.equal(exchanges,1);f.DB.raw.close()});
test('disconnect removes the local session even when token revocation fails',async()=>{const f=await fixture();f.env.fetch=async()=>Response.json({}, {status:500});const r=await handle(f.request('disconnect',{}),f.env);assert.equal((await r.json()).revoked,false);assert.equal(f.DB.raw.prepare("SELECT COUNT(*) AS n FROM circle_sessions WHERE id='sid'").get().n,0);f.DB.raw.close()});
test('empty usage quota blocks list, analysis, and action before any X request',async()=>{
 const f=await fixture({BILLING:{reserve:async()=>{throw new BillingError(429,'No allowance','quota_exceeded');}}});
 const proof=await seal({user,owner:'1',kind:'following',expires:Date.now()+60000},secret);
 for(const [path,data] of [['list',undefined],['activity',{proof,days:7}],['action',{operation:'unfollow',targetId:'2',confirmed:true,days:7}]]){
  const response=await handle(f.request(path,data),f.env);assert.equal(response.status,429);assert.equal((await response.json()).code,'quota_exceeded');
 }
 assert.equal(f.calls.length,0);f.DB.raw.close();
});
test('repeated list and analysis reuse stored results without spending another allowance',async()=>{
 const charged=[];const f=await fixture({BILLING:{reserve:async kind=>charged.push(kind),bindX:async()=>{}}});
 const base=f.env.fetch;f.env.fetch=async(url,o)=>url.includes('/following?')?Response.json({data:[user]}):base(url,o);
 const first=await(await handle(f.request('list'),f.env)).json();await handle(f.request('list'),f.env);
 await handle(f.request('activity',{proof:first.users[0].proof,days:7}),f.env);
 const repeated=await handle(f.request('activity',{proof:first.users[0].proof,days:7}),f.env);
 assert.equal((await repeated.json()).cached,true);assert.deepEqual(charged,['list','analysis']);f.DB.raw.close();
});
test('a session stolen from another member cannot spend a quota',async()=>{
 const f=await fixture({MEMBER_ID:'other-member'});
 assert.equal((await handle(f.request('list'),f.env)).status,401);assert.equal(f.calls.length,0);f.DB.raw.close();
});
