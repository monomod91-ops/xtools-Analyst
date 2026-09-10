import test from 'node:test';
import assert from 'node:assert/strict';
import {serve} from '../server/handler.mjs';
import {createDatabase} from '../server/database.mjs';
import {BillingError} from '../server/plan.mjs';
const origin='https://marinqueen.com';
test('Netlify config requires the confidential client secret',async()=>{
 const res=await serve(new Request(origin+'/api/x/config'),{X_CLIENT_ID:'test',SESSION_SECRET:'x'.repeat(40)},()=>{throw Error('Must not initialize DB');});
 assert.equal((await res.json()).configured,false);
});
test('production config points exclusively to marinqueen without exposing keys',async()=>{
 const res=await serve(new Request(origin+'/api/x/config'),{X_CLIENT_ID:'test-client',X_CLIENT_SECRET:'secret-value',SESSION_SECRET:'x'.repeat(40)},()=>({sql:()=>[]}));
 const body=await res.json();assert.equal(body.configured,true);assert.equal(body.callback,origin+'/api/x/oauth/callback');assert.ok(!JSON.stringify(body).includes('secret-value'));
});
test('other origins cannot execute authentication or operations',async()=>{
 const res=await serve(new Request('https://untrusted.example/api/x/session'),{},()=>{throw Error('Must not initialize DB');});assert.equal(res.status,400);
});
test('database values stay parameters and mutation row counts drive locking',async()=>{
 let captured;
 const db=createDatabase(async(parts,...values)=>{captured={parts,values};return [{id:'1'}];});
 const result=await db.prepare('INSERT OR REPLACE INTO circle_sessions (id,kind,payload,expires_at) VALUES (?,?,?,?)').bind('id',"kind'); DROP TABLE circle_sessions; --",'encrypted',123).run();
 assert.equal(result.meta.changes,1);assert.ok(captured.parts.join('').includes('ON CONFLICT (id) DO UPDATE'));assert.ok(!captured.parts.join('').includes('DROP TABLE'));assert.equal(captured.values.length,4);
});
test('forged headers cannot bypass verified membership or a paid invoice',async()=>{
 const vars={APP_ORIGIN:origin,X_CLIENT_ID:'client',X_CLIENT_SECRET:'secret',SESSION_SECRET:'x'.repeat(40),
  BILLING_ENABLED:'true',STRIPE_MODE:'test',STRIPE_SECRET_KEY:'rk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',
  STRIPE_PRICE_ID:'price_fixture',STRIPE_PORTAL_CONFIG_ID:'bpc_fixture',MERCHANT_DETAILS_CONFIRMED:'true'};
 let requests=0;
 const deps={getUser:async()=>null,fetch:async()=>{requests++;throw Error('No traffic allowed');},
  billing:{store:{assertAccess:async()=>{throw new BillingError(402,'Payment required','subscription_required');}}}};
 for(const path of ['list','activity','action','oauth/start','oauth/callback?state=forged']){
  const request=new Request(origin+'/api/x/'+path,{method:['activity','action','oauth/start'].includes(path)?'POST':'GET',headers:{origin,'oai-authenticated-user-id':'paid-admin','x-circle-member':'paid-admin'}});
  let response=await serve(request,vars,()=>({sql:()=>[]}),deps);
  assert.equal(response.status,path.startsWith('oauth/callback')?303:401);
  response=await serve(request,vars,()=>({sql:()=>[]}),{...deps,getUser:async()=>({id:'member',email:'member@example.test',emailVerified:true})});
  assert.equal(response.status,path.startsWith('oauth/callback')?303:402);
 }
 assert.equal(requests,0);
});
