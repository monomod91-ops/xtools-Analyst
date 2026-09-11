import {handle} from './core.mjs';
import {createDatabase} from './database.mjs';
import {billingConfig, billingFailure, BillingError, requireMember} from './plan.mjs';
import {oauthFailureResponse} from './oauth-result.mjs';
export async function serve(request, variables, getDatabase, dependencies={}) {
  const origin = variables.APP_ORIGIN || 'https://marinqueen.com';
  const current = new URL(request.url);
  if (current.origin !== origin) {
    return new Response(JSON.stringify({error:'https://marinqueen.com から開き直してください。'}), {status:400,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
  const headers = new Headers(request.headers);
  headers.delete('oai-authenticated-user-id');
  const req = new Request(request, {headers});
  const env = {
    APP_ORIGIN: origin,
    X_CLIENT_ID: variables.X_CLIENT_ID,
    X_CLIENT_SECRET: variables.X_CLIENT_SECRET,
    SESSION_SECRET: variables.SESSION_SECRET,
    X_ENABLE_BLOCKS: variables.X_ENABLE_BLOCKS || 'false',
    REQUIRE_WORKSPACE_AUTH: 'false'
  };
  let oauthStage = 'database';
  try {
    // The web-app configuration requires both credentials. Never expose values.
    if (env.X_CLIENT_ID && env.X_CLIENT_SECRET && env.SESSION_SECRET?.length >= 32) {
      const database = getDatabase();
      env.DB = createDatabase(database.sql);
    }
    const path = current.pathname.replace(/^\/api\/x\/?/,'');
    if(path !== 'config') {
      oauthStage = 'identity';
      const user=requireMember(await dependencies.getUser?.());
      env.MEMBER_ID=user.id;
      // Disconnect/history remain available after cancellation. All external paid
      // data calls require a verified invoice and an atomic quota reservation.
      const billing=dependencies.billing;
      oauthStage = 'subscription';
      if(!billing?.store)throw new BillingError(503,'契約情報を確認できません。');
      const settings=billingConfig(variables);
      if(!['session','history','disconnect'].includes(path)) {
        if(!settings.enabled)throw new BillingError(503,'サービスの受付準備中です。','billing_disabled');
        const access = await billing.store.assertAccess(user.id);
        env.PLAN_ID = access.plan?.id || 'legacy1980';
      }
      env.BILLING={reserve:kind=>billing.store.reserve(user.id,kind,settings),reserveList:()=>billing.store.reserveList(user.id,settings),settleList:(id,count)=>billing.store.settleList(user.id,id,count),bindX:id=>billing.store.bindX(user.id,id)};
    }
    if(dependencies.fetch)env.fetch=dependencies.fetch;
    oauthStage = 'integration';
    return await handle(req, env);
  } catch(error) {
    if(current.pathname==='/api/x/oauth/callback')return oauthFailureResponse(error,origin,oauthStage);
    return billingFailure(error);
  }
}
