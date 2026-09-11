import {getUser, admin} from '@netlify/identity';
import {getMemberIdentity} from '../../server/identity.mjs';
import {billingRuntime} from '../../server/billing-runtime.mjs';
import {billingConfig, billingFailure, billingJSON, publicCatalog} from '../../server/plan.mjs';
export default async function handler(request) {
  const env = process.env;
  // Pricing works before credentials or Identity have been configured.
  if (new URL(request.url).pathname === '/api/billing/plan' && request.method === 'GET')
    return billingJSON(publicCatalog(billingConfig(env)));
  try {
    const runtime = billingRuntime(env);
    const webhook = new URL(request.url).pathname === '/api/billing/webhook';
    const user = webhook ? null : await getMemberIdentity({getUser, admin});
    return runtime.service.handle(request, user);
  } catch (error) { return billingFailure(error); }
}
export const config = {path: '/api/billing/*'};
