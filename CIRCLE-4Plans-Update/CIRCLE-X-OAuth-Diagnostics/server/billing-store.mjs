import {createListQuota} from './list-quota.mjs';
import {API_COST, BillingError, PLAN, planById} from './plan.mjs';
const rows = async (client, query, values = []) => (await client.query(query, values)).rows;
const first = async (client, query, values = []) => (await rows(client, query, values))[0] || null;
const active = row => row && !row.revoked && !row.blocked && ['active', 'past_due'].includes(row.subscription_status);

export function createBillingStore(pool, clock = Date.now) {
  async function tx(work) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function query(query, values) {
    const client = await pool.connect();
    try { return await rows(client, query, values); } finally { client.release(); }
  }
  async function member(id) { return (await query('SELECT * FROM circle_memberships WHERE member_id=$1', [id]))[0] || null; }
  async function ensureMember(id) {
    await query('INSERT INTO circle_memberships (member_id,created_at) VALUES ($1,$2) ON CONFLICT (member_id) DO NOTHING', [id, clock()]);
    return member(id);
  }
  async function entitlement(client, id) {
    return first(client, `SELECT e.*,m.subscription_status,m.cancel_at_period_end,
      CASE WHEN b.invoice_id IS NULL THEN false ELSE true END AS blocked
      FROM circle_entitlements e JOIN circle_memberships m ON m.member_id=e.member_id AND m.subscription_id=e.subscription_id
      LEFT JOIN circle_payment_blocks b ON b.invoice_id=e.invoice_id
      WHERE e.member_id=$1 AND e.period_start<=$2 AND e.period_end>$2
      ORDER BY e.period_end DESC LIMIT 1`, [id, clock()]);
  }
  async function status(id) {
    const client = await pool.connect();
    try {
      const row = await entitlement(client, id), m = await first(client, 'SELECT * FROM circle_memberships WHERE member_id=$1', [id]);
      return {active: !!active(row), subscriptionStatus: m?.subscription_status || 'none',
        plan: planById(row?.plan_id || PLAN.id), listUnit: row?.list_unit || 'requests',
        cancelAtPeriodEnd: !!m?.cancel_at_period_end, periodEnd: row ? Number(row.period_end) : null,
        usage: Object.fromEntries(Object.keys(PLAN.limits).map(k => [k, {used: Number(row?.[k + '_used'] || 0), limit: Number(row?.[k + '_limit'] ?? PLAN.limits[k])}]))};
    } finally { client.release(); }
  }
  async function assertAccess(id) {
    const current = await status(id);
    if (!current.active) throw new BillingError(402, '月額プランのお支払いを確認してから利用できます。', 'subscription_required');
    return current;
  }
  async function reserve(id, kind, config) {
    if (!Object.hasOwn(API_COST, kind)) throw new BillingError(503, '利用枠を確認できません。');
    if (config.apiPaused) throw new BillingError(503, '現在、分析を一時停止しています。契約の確認・解約は利用できます。', 'api_paused');
    return tx(async client => {
      const e = await entitlement(client, id);
      if (!active(e)) throw new BillingError(402, '有効なお支払いを確認できません。契約をご確認ください。', 'subscription_required');
      // Atomic conditional update: simultaneous requests cannot overshoot.
      const count = await rows(client, `UPDATE circle_entitlements SET ${kind}_used=${kind}_used+1
        WHERE invoice_id=$1 AND revoked=false AND ${kind}_used<${kind}_limit RETURNING invoice_id`, [e.invoice_id]);
      if (!count.length) throw Object.assign(new BillingError(429, 'この契約期間の' + ({analysis:'分析',list:'一覧取得',action:'解除前の確認',link:'X連携'}[kind]) + '枠を使い切りました。次回更新後に再開できます。', 'quota_exceeded'), {quotaKind:kind,retryAt:Number(e.period_end)});
      const day = new Date(clock()).toISOString().slice(0, 10);
      await client.query('INSERT INTO circle_api_budget (day,used_units) VALUES ($1,0) ON CONFLICT (day) DO NOTHING', [day]);
      const budget = await rows(client, 'UPDATE circle_api_budget SET used_units=used_units+$1 WHERE day=$2 AND used_units+$1<=$3 RETURNING day', [API_COST[kind], day, config.dailyUnits]);
      if (!budget.length) throw new BillingError(503, '現在サービスの利用枠が不足しています。時間をおいてお試しください。', 'service_budget');
      // Commit before any X network request. Ambiguous failures are not refunded:
      // X might already have charged the request. No automatic overage billing.
      return {invoiceId: e.invoice_id};
    });
  }
  async function bindX(id, xId) {
    return tx(async client => {
      const m = await first(client, 'SELECT * FROM circle_memberships WHERE member_id=$1 FOR UPDATE', [id]);
      if (!m || (m.x_user_id && m.x_user_id !== xId)) throw new BillingError(409, 'この契約に登録済みのXアカウントで連携してください。', 'x_account_mismatch');
      const other = await first(client, 'SELECT member_id FROM circle_memberships WHERE x_user_id=$1', [xId]);
      if (other && other.member_id !== id) throw new BillingError(409, 'このXアカウントは別の契約に登録されています。', 'x_account_mismatch');
      await client.query('UPDATE circle_memberships SET x_user_id=$1 WHERE member_id=$2', [xId, id]);
    });
  }
  async function withMemberLock(id, work) {
    await ensureMember(id);
    const owner = crypto.randomUUID(), now = clock();
    const locked = await query(`INSERT INTO circle_billing_locks (member_id,owner,expires_at) VALUES ($1,$2,$3)
      ON CONFLICT (member_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE circle_billing_locks.expires_at<$4 RETURNING member_id`, [id, owner, now + 120000, now]);
    if (!locked.length) throw new BillingError(409, '契約の確認中です。少し待って再度お試しください。', 'billing_busy');
    try { return await work(); } finally { await query('DELETE FROM circle_billing_locks WHERE member_id=$1 AND owner=$2', [id, owner]); }
  }
  return {...createListQuota({tx,entitlement,clock}), tx, query, member, ensureMember, status, assertAccess, reserve, bindX, withMemberLock,
    async setCustomer(id, customer) { await query('UPDATE circle_memberships SET customer_id=$1 WHERE member_id=$2 AND (customer_id IS NULL OR customer_id=$1)', [customer, id]); },
    async setCheckoutRequest(id, requestId, parameters) {
      await query('UPDATE circle_memberships SET checkout_request_id=$1,checkout_request=$2 WHERE member_id=$3',
        [requestId, JSON.stringify(parameters), id]);
    },
    async clearCheckout(id) { await query('UPDATE circle_memberships SET checkout_id=NULL,checkout_expires=0,checkout_request_id=NULL,checkout_request=NULL WHERE member_id=$1',[id]); },
    async setCheckout(id, session) { await query('UPDATE circle_memberships SET checkout_id=$1,checkout_expires=$2 WHERE member_id=$3', [session.id, session.expires_at * 1000, id]); },
    async byCustomer(id) { return (await query('SELECT * FROM circle_memberships WHERE customer_id=$1', [id]))[0] || null; },
    async syncSubscription(id, sub) {
      // Callers hold a member lock and retrieve the current Stripe object, not
      // event snapshots. A delayed old-subscription event cannot replace a new one.
      await query(`UPDATE circle_memberships SET subscription_id=$1,subscription_status=$2,cancel_at_period_end=$3,stripe_sync_at=$4
        WHERE member_id=$5 AND (subscription_id IS NULL OR subscription_id=$1 OR subscription_status IN ('canceled','incomplete_expired','none'))`,
      [sub.id, sub.status, !!sub.cancel_at_period_end, clock(), id]);
    },
    async grant(id, invoice, sub, period, plan = PLAN) {
      await query(`INSERT INTO circle_entitlements
        (invoice_id,member_id,subscription_id,period_start,period_end,analysis_limit,list_limit,action_limit,link_limit,revoked,plan_id,list_unit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11) ON CONFLICT (invoice_id) DO NOTHING`,
      [invoice.id, id, sub.id, period.start * 1000, period.end * 1000, plan.limits.analysis, plan.limits.list, plan.limits.action, plan.limits.link, plan.id, plan.listUnit]);
    },
    async revoke(invoiceId, reason) {
      await query('INSERT INTO circle_payment_blocks (invoice_id,reason,created_at) VALUES ($1,$2,$3) ON CONFLICT (invoice_id) DO NOTHING', [invoiceId, reason, clock()]);
      await query('UPDATE circle_entitlements SET revoked=true WHERE invoice_id=$1', [invoiceId]);
    },
    async eventSeen(id) { return (await query('SELECT event_id FROM circle_billing_events WHERE event_id=$1', [id])).length > 0; },
    async markEvent(event) { await query('INSERT INTO circle_billing_events (event_id,event_type,processed_at) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING', [event.id, event.type, clock()]); }
  };
}
