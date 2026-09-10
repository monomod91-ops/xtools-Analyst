import {billingConfig, billingFailure, billingJSON, BillingError, PLAN, requireMember} from './plan.mjs';
const oid = value => typeof value === 'string' ? value : value?.id;
export const invoiceSubscription = invoice => oid(invoice.parent?.subscription_details?.subscription);
export function validatePrice(price, config) {
  if (!price || price.id !== config.priceId || price.active !== true || price.livemode !== config.live ||
    price.type !== 'recurring' || price.currency !== PLAN.currency || price.unit_amount !== PLAN.amount ||
    price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed')
    throw new BillingError(503, '料金の設定を確認中です。現在はお申し込みできません。', 'price_mismatch');
}
function matchesSubscription(sub, config) {
  const items = sub.items?.data || [];
  return sub.livemode === config.live && items.length === 1 && !sub.items?.has_more &&
    items[0].quantity === 1 && oid(items[0].price) === config.priceId;
}
export function paidPeriod(invoice, sub, config) {
  // Stripe removed invoice.paid in API 2025-03-31.basil. The pinned Dahlia
  // API reports settlement through status and amount_paid instead.
  if (invoice.status !== 'paid' || invoice.livemode !== config.live ||
    invoice.currency !== PLAN.currency || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < PLAN.amount ||
    !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason) ||
    invoiceSubscription(invoice) !== sub.id || oid(invoice.customer) !== oid(sub.customer) ||
    !matchesSubscription(sub, config) || invoice.lines?.has_more) return null;
  const lines = (invoice.lines?.data || []).filter(line => oid(line.pricing?.price_details?.price) === config.priceId &&
    line.parent?.type === 'subscription_item_details' && !line.parent.subscription_item_details.proration);
  if (lines.length !== 1 || lines[0].quantity !== 1 || !Number.isSafeInteger(lines[0].amount) || lines[0].amount < PLAN.amount) return null;
  const p = lines[0].period;
  if (!Number.isSafeInteger(p?.start) || !Number.isSafeInteger(p?.end) ||
    p.end - p.start < 26 * 86400 || p.end - p.start > 32 * 86400) return null;
  return p;
}

export function createBillingService({stripe, store, env, clock = Date.now, logger = console}) {
  const config = billingConfig(env);
  async function refreshSubscription(subId, member) {
    member = await store.member(member.member_id);
    const sub = await stripe.subscriptions.retrieve(subId);
    if (oid(sub.customer) !== member.customer_id || sub.metadata?.circle_member_id !== member.member_id) return;
    // Preserve cancellation information even when a price was archived.
    if (!matchesSubscription(sub, config)) throw new BillingError(503, '契約内容を確認できません。運営者へお問い合わせください。');
    if(member.subscription_id && member.subscription_id!==sub.id) {
      const previous=await stripe.subscriptions.retrieve(member.subscription_id);
      if(!['canceled','incomplete_expired'].includes(previous.status))return;
      await store.syncSubscription(member.member_id,previous);
    }
    await store.syncSubscription(member.member_id, sub);
    if (sub.latest_invoice) {
      const invoice = await stripe.invoices.retrieve(oid(sub.latest_invoice));
      const period = paidPeriod(invoice, sub, config);
      if (period) await store.grant(member.member_id, invoice, sub, period);
    }
  }
  async function synchronize(memberId) {
    return store.withMemberLock(memberId, async () => {
      const member = await store.member(memberId);
      if (!member.customer_id) return;
      // Enumerate current Stripe state rather than trusting a checkout return URL.
      const list = await stripe.subscriptions.list({customer: member.customer_id, status: 'all', limit: 100});
      if (list.has_more) throw new BillingError(503, '契約件数を確認できません。運営者へお問い合わせください。');
      const ours = list.data.filter(sub => sub.metadata?.circle_member_id === memberId && matchesSubscription(sub, config));
      const current = ours.filter(sub => !['canceled', 'incomplete_expired'].includes(sub.status));
      if (current.length > 1) throw new BillingError(409, '複数の契約があります。契約管理画面でご確認ください。', 'multiple_subscriptions');
      const selected = current[0] || ours.find(sub => sub.id === member.subscription_id);
      if (selected) await refreshSubscription(selected.id, member);
    });
  }
  async function checkout(user) {
    if (!config.enabled) throw new BillingError(503, 'お申し込みの準備中です。現在は決済できません。', 'billing_disabled');
    const price = await stripe.prices.retrieve(config.priceId); validatePrice(price, config);
    return store.withMemberLock(user.id, async () => {
      let member = await store.member(user.id);
      if (!member.customer_id) {
        const customer = await stripe.customers.create({email: user.email, metadata: {circle_member_id: user.id}},
          {idempotencyKey: `circle-customer-${user.id}`});
        await store.setCustomer(user.id, customer.id); member = await store.member(user.id);
      }
      const subscriptions = await stripe.subscriptions.list({customer: member.customer_id, status: 'all', limit: 100});
      // Never create a second payable subscription for the same member, including
      // incomplete, paused, or delinquent contracts.
      if (subscriptions.has_more || subscriptions.data.some(s => !['canceled', 'incomplete_expired'].includes(s.status)))
        throw new BillingError(409, 'すでに契約があります。「契約・解約」から確認してください。', 'already_subscribed');
      if (member.checkout_id && Number(member.checkout_expires) > clock()) {
        const existing = await stripe.checkout.sessions.retrieve(member.checkout_id);
        if (existing.status === 'open' && existing.url) return {url: existing.url};
        if (existing.status === 'complete') throw new BillingError(409, 'お支払いを確認中です。「支払い状況を確認」を押してください。', 'payment_pending');
      }
      // Persist the exact request before Stripe runs it. A lost response must
      // replay the same key AND parameters, including its absolute expiration.
      // A wall-clock bucket would create duplicates at the bucket boundary.
      let parameters = member.checkout_request ? JSON.parse(member.checkout_request) : null;
      let requestId = member.checkout_request_id;
      if (parameters && (!Number.isSafeInteger(parameters.expires_at) || !requestId))
        throw new BillingError(503, 'お申し込みの状態を確認中です。時間をおいてお試しください。');
      if (parameters && parameters.expires_at * 1000 + 60000 <= clock()) parameters = null;
      if (parameters && (parameters.customer !== member.customer_id ||
        parameters.line_items?.[0]?.price !== config.priceId ||
        parameters.success_url !== config.origin + '/?payment=success'))
        throw new BillingError(409, '料金設定を更新中です。先ほどのお申し込み画面を閉じ、1時間後にお試しください。');
      if (!parameters) {
        parameters = {
          mode: 'subscription', customer: member.customer_id,
          line_items: [{price: config.priceId, quantity: 1}],
          client_reference_id: user.id,
          consent_collection: {terms_of_service: 'required'},
          subscription_data: {metadata: {circle_member_id: user.id}, billing_mode: {type: 'flexible'}},
          metadata: {circle_member_id: user.id},
          success_url: config.origin + '/?payment=success', cancel_url: config.origin + '/?payment=cancelled',
          expires_at: Math.floor(clock() / 1000) + 3600,
          integration_identifier: config.integrationId
        };
        requestId = 'circle-checkout-' + crypto.randomUUID();
        await store.setCheckoutRequest(user.id, requestId, parameters);
      }
      const session = await stripe.checkout.sessions.create(parameters, {idempotencyKey: requestId});
      await store.setCheckout(user.id, session);
      return {url: session.url};
    });
  }
  async function portal(user) {
    const member = await store.member(user.id);
    if (!member?.customer_id) throw new BillingError(404, 'まだ契約がありません。', 'no_subscription');
    if (!config.portalConfig) throw new BillingError(503, '契約管理画面を準備中です。');
    try {
      const p = await stripe.billingPortal.sessions.create({customer: member.customer_id,
        configuration: config.portalConfig, return_url: config.origin + '/?payment=return'});
      return {url: p.url};
    } catch (error) {
      // Log only Stripe's diagnostic identifiers, never its raw message,
      // customer details, request body, headers, API key, or portal session URL.
      const safe = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(value) ? value : undefined;
      logger.error('circle_portal_failure', {type: safe(error.type), code: safe(error.code),
        status: Number.isInteger(error.statusCode) ? error.statusCode : undefined,
        requestId: safe(error.requestId)});
      const permission = error.type === 'StripePermissionError' || error.statusCode === 403;
      throw new BillingError(503, '契約管理画面に接続できませんでした。契約の確認・解約は運営者へお問い合わせください。',
        permission ? 'portal_permission_denied' : 'portal_unavailable');
    }
  }
  async function invoicesForCharge(chargeId) {
    const charge = await stripe.charges.retrieve(chargeId), intent = oid(charge.payment_intent);
    if (!intent) return [];
    const invoices = new Set();
    for await (const payment of stripe.invoicePayments.list({payment: {type: 'payment_intent', payment_intent: intent}, limit: 100}))
      if (payment.invoice) invoices.add(oid(payment.invoice));
    return [...invoices];
  }
  async function processEvent(event) {
    if (event.livemode !== config.live) throw new BillingError(400, '決済モードが一致しません。', 'mode_mismatch');
    if (await store.eventSeen(event.id)) return;
    const object = event.data.object;
    if (['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'].includes(event.type)) {
      const charge = event.type === 'charge.refunded' ? object.id : oid(object.charge);
      if (charge) for (const id of await invoicesForCharge(charge)) await store.revoke(id, event.type);
    } else if (event.type.startsWith('customer.subscription.') || event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const subId = event.type.startsWith('customer.subscription.') ? object.id : invoiceSubscription(object);
      const customerId = oid(object.customer), member = await store.byCustomer(customerId);
      if (member && subId) await store.withMemberLock(member.member_id, async () => {
        await refreshSubscription(subId, member);
        // A late paid invoice may refer to an earlier period. It is inserted once
        // with its own dates and never resets the current period's counters.
        if (event.type === 'invoice.paid') {
          const [invoice, sub] = await Promise.all([stripe.invoices.retrieve(object.id), stripe.subscriptions.retrieve(subId)]);
          const period = paidPeriod(invoice, sub, config);
          if (period && sub.metadata?.circle_member_id === member.member_id)
            await store.grant(member.member_id, invoice, sub, period);
        }
      });
    }
    await store.markEvent(event);
  }
  async function webhook(request) {
    const signature = request.headers.get('stripe-signature');
    if (!signature || !env.STRIPE_WEBHOOK_SECRET) throw new BillingError(400, '署名がありません。', 'invalid_signature');
    const raw = await request.text();
    if (raw.length > 1024 * 1024) throw new BillingError(413, 'リクエストが大きすぎます。');
    let event;
    try { event = await stripe.webhooks.constructEventAsync(raw, signature, env.STRIPE_WEBHOOK_SECRET); }
    catch { throw new BillingError(400, '署名を確認できません。', 'invalid_signature'); }
    await processEvent(event); return billingJSON({received: true});
  }
  async function handle(request, user) {
    const url = new URL(request.url), route = url.pathname.replace(/^\/api\/billing\/?/, '');
    try {
      if (route === 'webhook' && request.method === 'POST') return await webhook(request);
      if (url.origin !== config.origin) throw new BillingError(400, '登録されたURLから開き直してください。', 'origin');
      if (route === 'plan' && request.method === 'GET') return billingJSON({plan: PLAN, acceptingPayments: config.enabled});
      const member = requireMember(user);
      await store.ensureMember(member.id);
      if (request.method === 'POST' && (request.headers.get('origin') !== config.origin || request.headers.get('x-circle-request') !== 'membership'))
        throw new BillingError(403, 'CIRCLEの画面から操作してください。', 'origin');
      if (route === 'status' && request.method === 'GET') return billingJSON({...await store.status(member.id), acceptingPayments: config.enabled, apiPaused: config.apiPaused});
      if (route === 'checkout' && request.method === 'POST') return billingJSON(await checkout(member));
      if (route === 'portal' && request.method === 'POST') return billingJSON(await portal(member));
      if (route === 'sync' && request.method === 'POST') { await synchronize(member.id); return billingJSON(await store.status(member.id)); }
      return billingJSON({error: 'この操作は利用できません。'}, 404);
    } catch (error) { return billingFailure(error); }
  }
  return {handle, processEvent, synchronize, config, checkout, portal};
}
