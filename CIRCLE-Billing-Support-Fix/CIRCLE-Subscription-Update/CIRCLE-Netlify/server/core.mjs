/* Shared X API service. Real network traffic is restricted to api.x.com. */
import {BillingError} from './plan.mjs';
const DAY=86400000;
const FIELDS='id,name,username,protected,created_at,connection_status,profile_image_url';
const enc=new TextEncoder(),dec=new TextDecoder();
export class ServiceError extends Error{constructor(status,message,code='request_failed',extra={}){super(message);Object.assign(this,{status,code,...extra})}}
const fail=(status,message,code,extra)=>{throw new ServiceError(status,message,code,extra)};
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const nonce=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
async function key(secret){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode(secret)),{name:'AES-GCM'},false,['encrypt','decrypt'])}
export async function seal(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12));return b64(iv)+'.'+b64(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(secret),enc.encode(JSON.stringify(value))))}
export async function unseal(value,secret){try{const[a,b]=value.split('.');return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(a)},await key(secret),unb64(b))))}catch{return null}}
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const cookieValue=(req,name)=>req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
const cookie=(name,value,age,origin)=>`${name}=${value}; Path=/api/x; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https:')?'; Secure':''}`;
const idValid=id=>typeof id==='string'&&/^[0-9]{1,19}$/.test(id);
const normalize=u=>({id:u.id,name:u.name||u.username,username:u.username,protected:!!u.protected,created_at:u.created_at||null,profile_image_url:/^https:\/\/pbs\.twimg\.com\//.test(u.profile_image_url||'')?u.profile_image_url:null,relation:Array.isArray(u.connection_status)?u.connection_status:null});
export function classify(user,timeline,now=Date.now(),days=7){
 if(user.protected)return{status:'unknown',reason:'非公開アカウント',lastPost:null};
 if(!user.created_at||!Number.isFinite(Date.parse(user.created_at)))return{status:'unknown',reason:'作成日時を確認できません',lastPost:null};
 if(timeline.errors?.length)return{status:'unknown',reason:'投稿を完全に取得できません',lastPost:null};
 const dates=(timeline.data||[]).map(p=>Date.parse(p.created_at));
 if(dates.some(t=>!Number.isFinite(t)||t>now))return{status:'unknown',reason:'投稿日時を確認できません',lastPost:null};
 if(!dates.length)return{status:'unknown',reason:'投稿なし・取得できません',lastPost:null};
 const newest=Math.max(...dates);
 if(Date.parse(user.created_at)>now-days*DAY)return{status:'active',reason:'作成から指定日数以内',lastPost:new Date(newest).toISOString()};
 return{status:newest<now-days*DAY?'candidate':'active',reason:newest<now-days*DAY?'最終投稿が指定日数より前':'期間内の投稿あり',lastPost:new Date(newest).toISOString()};
}
function scopes(env){return 'tweet.read users.read follows.read follows.write block.read'+(env.X_ENABLE_BLOCKS==='true'?' block.write':'')}
function config(env){const origin=env.APP_ORIGIN||'';const validOrigin=/^https:\/\/[^/]+$/.test(origin)||/^http:\/\/127\.0\.0\.1:\d+$/.test(origin);return{configured:!!(validOrigin&&env.X_CLIENT_ID&&env.SESSION_SECRET?.length>=32&&env.DB),origin,callback:validOrigin?origin+'/api/x/oauth/callback':'',blocksEnabled:env.X_ENABLE_BLOCKS==='true',scopes:scopes(env)}}
function db(env){if(!env.DB)fail(503,'ただいま接続サービスを準備しています。しばらくお待ちください。','not_configured');return env.DB}
async function saveRecord(env,id,kind,data,expires){await db(env).prepare('INSERT OR REPLACE INTO circle_sessions (id,kind,payload,expires_at) VALUES (?,?,?,?)').bind(id,kind,await seal(data,env.SESSION_SECRET),expires).run()}
async function readRecord(env,id,kind){if(!id||id.length>100)return null;const row=await db(env).prepare('SELECT payload,expires_at FROM circle_sessions WHERE id=? AND kind=?').bind(id,kind).first();if(!row||row.expires_at<=Date.now())return null;return unseal(row.payload,env.SESSION_SECRET)}
async function erase(env,id){await db(env).prepare('DELETE FROM circle_sessions WHERE id=?').bind(id).run()}
async function cleanup(env){await db(env).batch([db(env).prepare('DELETE FROM circle_sessions WHERE expires_at<?').bind(Date.now()),db(env).prepare('DELETE FROM circle_actions WHERE created_at<?').bind(Date.now()-7*DAY)])}
function viewer(req,env){return env.MEMBER_ID||'local'}
async function session(req,env,optional=false){const sid=cookieValue(req,'circle_sid');const s=await readRecord(env,sid,'session');if(!s||s.viewer!==viewer(req,env)||s.tokenExpires<=Date.now()){if(optional)return null;fail(401,'Xとの連携が切れています。もう一度「Xと連携」を押してください。','unauthorized')}return{...s,sid}}
function checkWrite(req,env,s){if(req.headers.get('origin')!==env.APP_ORIGIN)fail(403,'この画面から操作をやり直してください。','origin');if(s&&req.headers.get('x-csrf-token')!==s.csrf)fail(403,'画面を更新してから操作してください。','csrf')}
async function body(req){if(Number(req.headers.get('content-length')||0)>16384)fail(413,'送信内容が大きすぎます。');const t=await req.text();if(t.length>16384)fail(413,'送信内容が大きすぎます。');try{return JSON.parse(t)}catch{fail(400,'送信内容が正しくありません。')}}
async function reserve(env,kind,calls=1){
 if(!env.BILLING?.reserve)fail(503,'契約情報を確認できません。','billing_unavailable');
 await env.BILLING.reserve(kind);env.X_TICKET={remaining:calls};
}
async function xapi(env,token,path,options={}){
 if(!env.X_TICKET||env.X_TICKET.remaining<1)fail(503,'利用枠を確認できません。','billing_unavailable');
 env.X_TICKET.remaining--;
 const headers={'Authorization':`Bearer ${token}`,...(options.body?{'Content-Type':'application/json'}:{})};
 let res;try{res=await (env.fetch||fetch)('https://api.x.com'+path,{...options,headers,signal:AbortSignal.timeout(20000),redirect:'error'})}catch{fail(502,'Xから結果を確認できませんでした。操作を繰り返す前に状態を確認してください。','network')}
 const data=await res.json().catch(()=>({}));
 if(!res.ok){const reset=Number(res.headers.get('x-rate-limit-reset')||0)*1000;const status=res.status;
  const message=status===429?'Xの取得上限に達しました。時間をおいて再開してください。':status===402?'Xへの接続に必要なサービス利用枠が不足しています。運営側の補充後に再開します。':status===403?'この操作は現在利用できません。Xのプロフィール画面で確認してください。':status===401?'Xの認証が切れています。再連携してください。':status===404?'このアカウントは取得できません。':'Xに接続できませんでした。時間をおいてもう一度お試しください。';
  fail(status,message,status===402?'x_credits_depleted':'x_api',{retryAt:status===429&&reset>Date.now()?reset:null});
 }
 return data;
}
async function oauthToken(env,form,path='/2/oauth2/token'){
 const headers={'Content-Type':'application/x-www-form-urlencoded'};
 if(env.X_CLIENT_SECRET)headers.Authorization='Basic '+btoa(encodeURIComponent(env.X_CLIENT_ID)+':'+encodeURIComponent(env.X_CLIENT_SECRET));
 else form.set('client_id',env.X_CLIENT_ID);
 let r;try{r=await(env.fetch||fetch)('https://api.x.com'+path,{method:'POST',headers,body:form.toString(),signal:AbortSignal.timeout(20000),redirect:'error'})}catch{fail(502,'Xの認証サーバーに接続できませんでした。','oauth')}
 if(!r.ok)fail(400,'現在Xと連携できません。しばらくお待ちいただくか、運営者へお問い合わせください。','oauth');
 return r.json().catch(()=>({}));
}
async function lookup(env,s,id){const r=await xapi(env,s.token,`/2/users/${id}?user.fields=${FIELDS}`);if(!r.data||r.errors?.length)fail(404,'アカウント情報を確認できません。');return normalize(r.data)}
async function activity(env,s,user,days){if(user.protected)return classify(user,{},Date.now(),days);try{return classify(user,await xapi(env,s.token,`/2/users/${user.id}/tweets?max_results=5&tweet.fields=created_at`),Date.now(),days)}catch(e){if(e.status===403||e.status===404)return{status:'unknown',reason:'投稿の取得権限なし・取得不可',lastPost:null};throw e}}
async function acquire(env,owner){const lock='lock:'+owner;const result=await db(env).prepare('INSERT INTO circle_sessions (id,kind,payload,expires_at) VALUES (?,\'lock\',\'\',?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at WHERE circle_sessions.expires_at<?').bind(lock,Date.now()+120000,Date.now()).run();if(!result.meta?.changes)fail(409,'別の解除処理が進行中です。完了してから操作してください。','busy');return lock}
async function audit(env,s,operation,target,state,message,actionId){await db(env).prepare('INSERT OR REPLACE INTO circle_actions (id,owner,target_id,username,operation,status,message,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(actionId||crypto.randomUUID(),s.user.id,target.id,target.username||target.id,operation,state,message,Date.now()).run()}
export async function handle(req,env){
 const url=new URL(req.url),path=url.pathname.replace(/^\/api\/x\/?/,'');const c=config(env);
 try{
 if(env.REQUIRE_WORKSPACE_AUTH==='true'&&!req.headers.get('oai-authenticated-user-id'))return json({error:'このページへのサインインが必要です。'},401);
 if(path==='config'&&req.method==='GET')return json(c);
 if(!c.configured)fail(503,'ただいまXとの接続準備中です。利用者側の設定は必要ありません。','not_configured');
 if(url.origin!==c.origin)fail(400,'登録されたURLから開き直してください。','origin');
 if(path==='session'&&req.method==='GET'){const s=await session(req,env,true);return json(s?{connected:true,user:s.user,csrf:s.csrf,expiresAt:s.tokenExpires,blocksEnabled:c.blocksEnabled}:{connected:false})}
 if(path==='oauth/start'&&req.method==='POST'){
  checkWrite(req,env);await cleanup(env);const state=nonce(),verifier=nonce(),browser=nonce();const challenge=b64(await crypto.subtle.digest('SHA-256',enc.encode(verifier)));
  await saveRecord(env,state,'oauth',{verifier,browser,viewer:viewer(req,env)},Date.now()+600000);
  const auth=new URL('https://x.com/i/oauth2/authorize');auth.search=new URLSearchParams({response_type:'code',client_id:env.X_CLIENT_ID,redirect_uri:c.callback,scope:c.scopes,state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
  return json({url:auth.href},200,{'Set-Cookie':cookie('circle_oauth',browser,600,c.origin)});
 }
 if(path==='oauth/callback'&&req.method==='GET'){
  const state=url.searchParams.get('state')||'',pending=await readRecord(env,state,'oauth');
  if(!pending||pending.browser!==cookieValue(req,'circle_oauth')||pending.viewer!==viewer(req,env))return new Response(null,{status:303,headers:{Location:c.origin+'/?auth=state_error','Cache-Control':'no-store'}});
  const consumed=await db(env).prepare('DELETE FROM circle_sessions WHERE id=? AND kind=? RETURNING id').bind(state,'oauth').all();if(!consumed.results?.length)fail(409,'この認証は使用済みです。もう一度連携してください。','oauth');
  if(url.searchParams.has('error'))return new Response(null,{status:303,headers:{Location:c.origin+'/?auth=cancelled','Set-Cookie':cookie('circle_oauth','',0,c.origin)}});
  const code=url.searchParams.get('code');if(!code)fail(400,'認証コードがありません。','oauth');
  await reserve(env,'link');
  const token=await oauthToken(env,new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:c.callback,code_verifier:pending.verifier}));
  if(!token.access_token)fail(400,'Xの認証情報を取得できませんでした。','oauth');
  const granted=new Set((token.scope||'').split(' '));if(!['tweet.read','users.read','follows.read','follows.write'].every(s=>granted.has(s)))fail(403,'必要な閲覧・フォロー管理権限が承認されていません。','scope');
  const me=await xapi(env,token.access_token,'/2/users/me?user.fields=profile_image_url,public_metrics');if(!idValid(me.data?.id))fail(400,'Xの利用者を確認できませんでした。');
  await env.BILLING.bindX(me.data.id);
  const sid=nonce(),seconds=Math.max(1,Math.min(6600,Number(token.expires_in)||7200)-60);
  await saveRecord(env,sid,'session',{token:token.access_token,tokenExpires:Date.now()+seconds*1000,user:normalize(me.data),csrf:nonce(),viewer:viewer(req,env)},Date.now()+seconds*1000);
  const headers=new Headers({Location:c.origin+'/?auth=connected','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});headers.append('Set-Cookie',cookie('circle_sid',sid,seconds,c.origin));headers.append('Set-Cookie',cookie('circle_oauth','',0,c.origin));return new Response(null,{status:303,headers});
 }
 const s=await session(req,env);
 if(path==='disconnect'&&req.method==='POST'){
  checkWrite(req,env,s);let revoked=true;try{await oauthToken(env,new URLSearchParams({token:s.token,token_type_hint:'access_token'}),'/2/oauth2/revoke')}catch{revoked=false}
  await erase(env,s.sid);return json({ok:true,revoked},200,{'Set-Cookie':cookie('circle_sid','',0,c.origin)});
 }
 if(path==='list'&&req.method==='GET'){
  const kind=url.searchParams.get('kind')||'following';if(!['following','blocking'].includes(kind))fail(400,'対象一覧が正しくありません。');
  const params=new URLSearchParams({'max_results':'100','user.fields':FIELDS});const cursor=url.searchParams.get('cursor');if(cursor){if(cursor.length>2000)fail(400,'ページ情報が正しくありません。');params.set('pagination_token',cursor)}
  const cacheId='list:'+b64(await crypto.subtle.digest('SHA-256',enc.encode(s.user.id+':'+kind+':'+(cursor||''))));
  let r=await readRecord(env,cacheId,'list-cache');
  if(!r){await reserve(env,'list');r=await xapi(env,s.token,`/2/users/${s.user.id}/${kind}?${params}`);if(!r.errors?.length)await saveRecord(env,cacheId,'list-cache',r,Date.now()+86400000);}
  if(r.errors?.length)fail(502,'一覧の一部を取得できません。更新して再試行してください。');
  const users=(r.data||[]).map(normalize);const proofs=await Promise.all(users.map(user=>seal({user,owner:s.user.id,kind,expires:Date.now()+3600000},env.SESSION_SECRET)));
  return json({users:users.map((u,i)=>({...u,proof:proofs[i]})),next:r.meta?.next_token||null,readAt:Date.now()});
 }
 if(path==='activity'&&req.method==='POST'){
  checkWrite(req,env,s);const b=await body(req);const proof=await unseal(b.proof||'',env.SESSION_SECRET);if(!proof||proof.owner!==s.user.id||proof.expires<Date.now())fail(409,'一覧の情報が古くなりました。再取得してください。');
  const days=Number(b.days);if(![7,14,30,60,90].includes(days))fail(400,'日数が正しくありません。');if(proof.user.protected)return json(await activity(env,s,proof.user,days));
  const cacheId='activity:'+s.user.id+':'+proof.user.id+':'+days;
  const cached=await readRecord(env,cacheId,'activity-cache');if(cached)return json({...cached,cached:true});
  await reserve(env,'analysis');const result=await activity(env,s,proof.user,days);
  await saveRecord(env,cacheId,'activity-cache',result,Date.now()+86400000);return json(result);
 }
 if(path==='history'&&req.method==='GET'){const r=await db(env).prepare('SELECT id,target_id,username,operation,status,message,created_at FROM circle_actions WHERE owner=? AND created_at>? ORDER BY created_at DESC LIMIT 50').bind(s.user.id,Date.now()-7*DAY).all();return json({items:r.results||[]})}
 if(path==='action'&&req.method==='POST'){
  checkWrite(req,env,s);const b=await body(req);const{operation,targetId}=b;if(!['unfollow','softblock','unblock'].includes(operation)||!idValid(targetId)||targetId===s.user.id||b.confirmed!==true)fail(400,'対象と操作内容を確認してください。');
  if(operation!=='unfollow'&&!c.blocksEnabled)fail(403,'この画面ではブロック操作を利用できません。Xのプロフィール画面で操作できます。','enterprise');
  const days=Number(b.days);if(operation!=='unblock'&&![7,14,30,60,90].includes(days))fail(400,'日数が正しくありません。');
  const lock=await acquire(env,s.user.id);const actionId=crypto.randomUUID();let target={id:targetId,username:targetId},issued=false,blockConfirmed=false;
  try{
   await reserve(env,'action',operation==='softblock'?4:operation==='unfollow'?3:2);
   target=await lookup(env,s,targetId);if(!target.relation)fail(409,'現在のフォロー・ブロック関係を確認できません。Xで確認してください。','relation_unknown');
   if(operation==='unblock'){if(!target.relation.includes('blocking'))fail(409,'現在ブロック中ではありません。再取得してください。');}
   else{
    if(target.protected)fail(409,'非公開アカウントは投稿による解除候補から除外しています。');
    if(!target.relation.includes('following')||target.relation.includes('blocking'))fail(409,'フォロー状態が変わっています。再取得してください。');
    if(operation==='softblock'&&!target.relation.includes('followed_by'))fail(409,'相互フォローではありません。');
    if((await activity(env,s,target,days)).status!=='candidate')fail(409,'投稿状況が変わったか、確認できません。再判定してください。','not_candidate');
   }
   await audit(env,s,operation,target,'pending','Xへの操作を開始します。',actionId);
   if(operation==='unfollow'){
    issued=true;const result=await xapi(env,s.token,`/2/users/${s.user.id}/following/${targetId}`,{method:'DELETE'});
    if(result.data?.following!==false||result.errors?.length)fail(502,'フォロー解除の結果を確認できませんでした。','uncertain');
   }else if(operation==='unblock'){
    issued=true;const result=await xapi(env,s.token,`/2/users/${s.user.id}/blocking/${targetId}`,{method:'DELETE'});
    if(result.data?.blocking!==false||result.errors?.length)fail(502,'ブロック解除の結果を確認できませんでした。','uncertain');
   }else{
    issued=true;const blocked=await xapi(env,s.token,`/2/users/${s.user.id}/blocking`,{method:'POST',body:JSON.stringify({target_user_id:targetId})});
    if(blocked.data?.blocking!==true||blocked.errors?.length)fail(502,'ブロックの結果が不明です。Xで状態を確認してください。','uncertain');
    blockConfirmed=true;await audit(env,s,operation,target,'blocked_pending','ブロック済み。解除の結果を確認中です。',actionId);
    const unblocked=await xapi(env,s.token,`/2/users/${s.user.id}/blocking/${targetId}`,{method:'DELETE'});
    if(unblocked.data?.blocking!==false||unblocked.errors?.length)fail(502,'ブロック解除の結果が不明です。','uncertain');
   }
   await audit(env,s,operation,target,'success','完了しました。',actionId);return json({ok:true,operation,targetId});
  }catch(e){const status=blockConfirmed?'blocked_pending':issued?'uncertain':'failed';const message=blockConfirmed?'相互解除は途中です。ブロックが残っている可能性があります。「ブロック解除のみ」を実行するかXで確認してください。':issued?'操作の結果が確定していません。Xで状態を確認してから再操作してください。':e.message;
   await audit(env,s,operation,target,status,message,actionId).catch(()=>{});
   return json({error:message,code:e.code||'action_failed',state:status,targetId,username:target.username,retryAt:e.retryAt||null,quotaKind:e.quotaKind||null},e.status||500);
  }finally{await erase(env,lock)}
 }
 return json({error:'この操作は利用できません。'},404);
 }catch(e){if(path==='oauth/callback')return new Response(null,{status:303,headers:{Location:c.origin+'/?auth=failed','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});return json({error:e instanceof ServiceError||e instanceof BillingError?e.message:'連携サービスで問題が起きました。時間をおいて再試行してください。',code:e.code||'server_error',retryAt:e.retryAt||null,quotaKind:e.quotaKind||null},e.status||500)}
}
