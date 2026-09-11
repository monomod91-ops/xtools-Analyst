export class BillingError extends Error {
  constructor(status, message, code = 'billing_unavailable') {
    super(message); Object.assign(this, {status, code});
  }
}
export const PLAN = Object.freeze({
  id: 'legacy1980', listUnit: 'requests',
  name: 'CIRCLE スタンダード', amount: 1980, currency: 'jpy', interval: 'month',
  limits: Object.freeze({analysis: 100, list: 2, action: 20, link: 20})
});
const tier = (id, name, amount, analysis, list, action, link) => Object.freeze({
  id, name, amount, currency: 'jpy', interval: 'month', listUnit: 'people',
  limits: Object.freeze({analysis, list, action, link})
});
export const PLANS = Object.freeze([
  tier('light', 'CIRCLE ライト', 480, 20, 50, 5, 5),
  tier('standard', 'CIRCLE スタンダード', 980, 50, 100, 10, 10),
  tier('pro', 'CIRCLE プロ', 1980, 120, 200, 20, 20),
  tier('max1000', 'CIRCLE MAX 1000', 12800, 1000, 1000, 100, 20)
]);
export const planById = id => id === PLAN.id ? PLAN : PLANS.find(p => p.id === id);
export const PRICE_ENV = Object.freeze({light:'STRIPE_PRICE_LIGHT_ID', standard:'STRIPE_PRICE_STANDARD_ID', pro:'STRIPE_PRICE_PRO_ID', max1000:'STRIPE_PRICE_MAX1000_ID'});
export function planForPrice(id, config) {
  const entries = Object.entries(config.priceIds || {}).filter(([, priceId]) => priceId === id);
  return entries.length === 1 ? planById(entries[0][0]) : undefined;
}
export function publicCatalog(config) {
  return {plan: PLANS[1], plans: PLANS.map(p => ({...p, acceptingPayments: config.enabled && !!config.priceIds[p.id]})), acceptingPayments: config.enabled};
}
// Worst-case request costs in 1/10,000 USD, not a promise of future X pricing.
// list: 100 user objects; analysis: five posts; action: profile + five posts
// + block + unblock; link: one users/me result. No automatic API retries.
export const API_COST = Object.freeze({analysis: 250, list: 10000, action: 600, link: 100});
export function billingConfig(env) {
  const enabled = env.BILLING_ENABLED === 'true';
  const priceIds = Object.fromEntries([[PLAN.id, env.STRIPE_PRICE_ID], ...Object.entries(PRICE_ENV).map(([id,key])=>[id,env[key]])].filter(([,value])=>/^price_[A-Za-z0-9_]+$/.test(value || '')));
  const uniquePrices = new Set(Object.values(priceIds)).size === Object.keys(priceIds).length;
  const configured = /^https:\/\/[^/]+$/.test(env.APP_ORIGIN || '') &&
    /^(rk|sk)_(test|live)_/.test(env.STRIPE_SECRET_KEY || '') &&
    /^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || '') &&
    Object.keys(priceIds).length > 0 && uniquePrices && /^bpc_/.test(env.STRIPE_PORTAL_CONFIG_ID || '');
  const live = env.STRIPE_MODE === 'live';
  const keyMatches = (env.STRIPE_SECRET_KEY || '').includes(live ? '_live_' : '_test_');
  const dailyCents = Number(env.CIRCLE_DAILY_API_BUDGET_CENTS || 1000);
  return {enabled: enabled && !!configured && keyMatches && env.MERCHANT_DETAILS_CONFIRMED === 'true',
    live, origin: env.APP_ORIGIN, priceId: priceIds[PLAN.id], priceIds,
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
    quotaKind: error instanceof BillingError ? error.quotaKind || null : null, retryAt: error instanceof BillingError ? error.retryAt || null : null,
    code: error instanceof BillingError ? error.code : 'billing_unavailable'}, error instanceof BillingError ? error.status : 503);
}
