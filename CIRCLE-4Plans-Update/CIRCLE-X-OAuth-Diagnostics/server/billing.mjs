import {billingConfig, billingFailure, billingJSON, BillingError, PLAN, planById, planForPrice, publicCatalog, requireMember} from './plan.mjs';
const oid = value => typeof value === 'string' ? value : value?.id;
export const invoiceSubscription = invoice => oid(invoice.parent?.subscription_details?.subscription);
export function validatePrice(price, config, selected) {
  const plan = selected || planForPrice(price?.id, config);
  if (!plan || !price || price.id !== config.priceIds[plan.id] || price.active !== true || price.livemode !== config.live ||
    price.type !== 'recurring' || price.currency !== plan.currency || price.unit_amount !== plan.amount ||
    price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed' ||
    (plan.id !== PLAN.id && price.tax_behavior !== 'inclusive'))
    throw new BillingError(503, '料金の設定を確認中です。現在はお申し込みできません。', 'price_mismatch');
}
export function subscriptionPlan(sub, config) {
  const items = sub?.items?.data || [];
  if (sub?.livemode !== config.live || items.length !== 1 || sub.items.has_more || items[0].quantity !== 1) return null;
  return planForPrice(oid(items[0].price), config) || null;
}
const matchesSubscription = (sub, config) => !!subscriptionPlan(sub, config);
export function paidPeriod(invoice, sub, config) {
  const plan = subscriptionPlan(sub, config);
  if (!plan || invoice.status !== 'paid' || invoice.livemode !== config.live ||
    invoice.currency !== plan.currency || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < plan.amount ||
    !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason) ||
    invoiceSubscription(invoice) !== sub.id || oid(invoice.customer) !== oid(sub.customer) || invoice.lines?.has_more) return null;
  const lines = (invoice.lines?.data || []).filter(line => oid(line.pricing?.price_details?.price) === config.priceIds[plan.id] &&
    line.parent?.type === 'subscription_item_details' && !line.parent.subscription_item_details.proration);
  if (lines.length !== 1 || lines[0].quantity !== 1 || !Number.isSafeInteger(lines[0].amount) || lines[0].amount < plan.amount) return null;
  const p = lines[0].period;
  if (!Number.isSafeInteger(p?.start) || !Number.isSafeInteger(p?.end) ||
    p.end - p.start < 26 * 86400 || p.end - p.start > 32 * 86400) return null;
  return p;
}

export function createBillingService({stripe, store, env, clock = Date.now}) {
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
      if (period) await store.grant(member.member_id, invoice, sub, period, subscriptionPlan(sub,config));
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
  async function checkout(user, planId = PLAN.id) {
    const selected = planById(planId), priceId = config.priceIds[planId];
    if (!selected) throw new BillingError(400,'プランを選び直してください。','invalid_plan');
    if (!priceId) throw new BillingError(503,'このプランは受付準備中です。','plan_unavailable');
    if (!config.enabled) throw new BillingError(503, 'お申し込みの準備中です。現在は決済できません。', 'billing_disabled');
    const price = await stripe.prices.retrieve(priceId); validatePrice(price, config, selected);
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
      // The stored parameters are the only source for retries after a lost
      // response. Recover and expire an old plan's unpaid session before switch.
      const previous = member.checkout_request ? JSON.parse(member.checkout_request) : null;
      if (previous && previous.line_items?.[0]?.price !== priceId &&
          Number(previous.expires_at) * 1000 + 60000 > clock()) {
        const old = member.checkout_id
          ? await stripe.checkout.sessions.retrieve(member.checkout_id)
          : await stripe.checkout.sessions.create(previous, {idempotencyKey:member.checkout_request_id});
        if (old.status === 'complete') throw new BillingError(409,'お支払いを確認中です。「支払い状況を確認」を押してください。','payment_pending');
        if (old.status === 'open') await stripe.checkout.sessions.expire(old.id);
        await store.clearCheckout(user.id);
        member = await store.member(user.id);
      }
      if (member.checkout_id && Number(member.checkout_expires) > clock()) {
        const existing = await stripe.checkout.sessions.retrieve(member.checkout_id);
        if (existing.status === 'complete') throw new BillingError(409,'お支払いを確認中です。「支払い状況を確認」を押してください。','payment_pending');
        if (existing.status === 'open' && existing.url) {
          if (member.checkout_request && JSON.parse(member.checkout_request).line_items?.[0]?.price === priceId) return {url:existing.url};
          throw new BillingError(409,'先のお申し込みの確認が必要です。「支払い状況を確認」を押してください。');
        }
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
        parameters.line_items?.[0]?.price !== priceId ||
        parameters.success_url !== config.origin + '/?payment=success'))
        throw new BillingError(409, '料金設定を更新中です。先ほどのお申し込み画面を閉じ、1時間後にお試しください。');
      if (!parameters) {
        parameters = {
          mode: 'subscription', customer: member.customer_id,
          line_items: [{price: priceId, quantity: 1}],
          client_reference_id: user.id,
          consent_collection: {terms_of_service: 'required'},
          subscription_data: {metadata: {circle_member_id: user.id, circle_plan_id: selected.id}, billing_mode: {type: 'flexible'}},
          metadata: {circle_member_id: user.id, circle_plan_id: selected.id},
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
    const p = await stripe.billingPortal.sessions.create({customer: member.customer_id,
      configuration: config.portalConfig, return_url: config.origin + '/?payment=return'});
    return {url: p.url};
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
            await store.grant(member.member_id, invoice, sub, period, subscriptionPlan(sub,config));
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
      if (route === 'plan' && request.method === 'GET') return billingJSON(publicCatalog(config));
      const member = requireMember(user);
      await store.ensureMember(member.id);
      if (request.method === 'POST' && (request.headers.get('origin') !== config.origin || request.headers.get('x-circle-request') !== 'membership'))
        throw new BillingError(403, 'CIRCLEの画面から操作してください。', 'origin');
      if (route === 'status' && request.method === 'GET') return billingJSON({...await store.status(member.id), acceptingPayments: config.enabled, apiPaused: config.apiPaused});
      if (route === 'checkout' && request.method === 'POST') {
        const raw = await request.text();
        if (raw.length > 4096) throw new BillingError(413,'送信内容が大きすぎます。');
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new BillingError(400,'プランを選び直してください。','invalid_plan'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BillingError(400,'プランを選び直してください。','invalid_plan');
        if (Object.keys(config.priceIds).some(id=>id!==PLAN.id) &&
            (body.planId === undefined || body.planId === PLAN.id))
          throw new BillingError(400,'料金プランが更新されました。ページを更新してプランを選び直してください。','invalid_plan');
        return billingJSON(await checkout(member, body.planId === undefined ? PLAN.id : body.planId));
      }
      if (route === 'portal' && request.method === 'POST') return billingJSON(await portal(member));
      if (route === 'sync' && request.method === 'POST') { await synchronize(member.id); return billingJSON(await store.status(member.id)); }
      return billingJSON({error: 'この操作は利用できません。'}, 404);
    } catch (error) { return billingFailure(error); }
  }
  return {handle, processEvent, synchronize, config, checkout, portal};
}
