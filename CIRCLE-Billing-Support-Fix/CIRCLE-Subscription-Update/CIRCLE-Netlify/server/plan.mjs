export class BillingError extends Error {
  constructor(status, message, code = 'billing_unavailable', details = {}) {
    super(message); Object.assign(this, {status, code});
    if (Number.isSafeInteger(details.retryAt) && details.retryAt > 0) this.retryAt = details.retryAt;
    if (['analysis', 'list', 'action', 'link'].includes(details.quotaKind)) this.quotaKind = details.quotaKind;
  }
}
export const PLAN = Object.freeze({
  name: 'CIRCLE スタンダード', amount: 1980, currency: 'jpy', interval: 'month',
  limits: Object.freeze({analysis: 100, list: 2, action: 20, link: 20})
});
// Worst-case request costs in 1/10,000 USD, not a promise of future X pricing.
// list: 100 user objects; analysis: five posts; action: profile + five posts
// + block + unblock; link: one users/me result. No automatic API retries.
export const API_COST = Object.freeze({analysis: 250, list: 10000, action: 600, link: 100});
export function billingConfig(env) {
  const enabled = env.BILLING_ENABLED === 'true';
  const configured = /^https:\/\/[^/]+$/.test(env.APP_ORIGIN || '') &&
    /^(rk|sk)_(test|live)_/.test(env.STRIPE_SECRET_KEY || '') &&
    /^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || '') &&
    /^price_/.test(env.STRIPE_PRICE_ID || '') && /^bpc_/.test(env.STRIPE_PORTAL_CONFIG_ID || '');
  const live = env.STRIPE_MODE === 'live';
  const keyMatches = (env.STRIPE_SECRET_KEY || '').includes(live ? '_live_' : '_test_');
  const dailyCents = Number(env.CIRCLE_DAILY_API_BUDGET_CENTS || 1000);
  return {enabled: enabled && !!configured && keyMatches && env.MERCHANT_DETAILS_CONFIRMED === 'true',
    live, origin: env.APP_ORIGIN, priceId: env.STRIPE_PRICE_ID,
    portalConfig: env.STRIPE_PORTAL_CONFIG_ID,
    dailyUnits: Number.isSafeInteger(dailyCents) && dailyCents > 0 && dailyCents <= 100000 ? dailyCents * 100 : 100000,
    apiPaused: env.CIRCLE_API_PAUSED === 'true',
    integrationId: 'circle_membership_jqmrvska'};
}
export function requireMember(user) {
  // This argument must come from server-side @netlify/identity getUser(),
  // never request data, user metadata, a header ID, or a locally decoded JWT.
  // Netlify's validated-session fallback intentionally has no confirmedAt.
  // Identity enforces confirmation when issuing email/password sessions.
  if (typeof user?.id !== 'string' || !user.id || typeof user.email !== 'string' || !user.email)
    throw new BillingError(401, 'ログイン情報を確認できません。もう一度ログインしてください。', 'login_required');
  return {id: user.id, email: user.email};
}
export const billingJSON = (data, status = 200) => Response.json(data, {status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
}});
export function billingFailure(error) {
  return billingJSON({error: error instanceof BillingError ? error.message : '契約情報を確認できません。時間をおいて再度お試しください。',
    code: error instanceof BillingError ? error.code : 'billing_unavailable',
    ...(error instanceof BillingError && error.retryAt ? {retryAt: error.retryAt} : {}),
    ...(error instanceof BillingError && error.quotaKind ? {quotaKind: error.quotaKind} : {})}, error instanceof BillingError ? error.status : 503);
}
