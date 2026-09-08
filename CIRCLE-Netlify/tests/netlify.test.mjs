import test from 'node:test';
import assert from 'node:assert/strict';
import {serve} from '../server/handler.mjs';
import {createDatabase} from '../server/database.mjs';
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
