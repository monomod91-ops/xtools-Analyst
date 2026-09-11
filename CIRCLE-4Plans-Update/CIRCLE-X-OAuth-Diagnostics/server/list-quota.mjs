import {BillingError} from './plan.mjs';

// Reserve the largest possible response BEFORE contacting X, then release only
// the known unused part of a successful response. Ambiguous failures keep it.
// Settlement is server-only, bound to a member and invoice, and idempotent.
export function createListQuota({tx, entitlement, clock}) {
  return {
    async reserveList(id, config) {
      if (config.apiPaused) throw new BillingError(503, '現在、分析を一時停止しています。契約・解約は利用できます。', 'api_paused');
      return tx(async client => {
        const e = await entitlement(client, id);
        if (!e || e.revoked || e.blocked || !['active','past_due'].includes(e.subscription_status))
          throw new BillingError(402, '有効なお支払いを確認できません。', 'subscription_required');
        const people = e.list_unit === 'people';
        const remaining = Number(e.list_limit) - Number(e.list_used);
        if (remaining <= 0) throw Object.assign(new BillingError(429, 'この契約期間の一覧取得枠を使い切りました。保存済みの一覧は再表示できます。', 'quota_exceeded'), {quotaKind:'list', retryAt:Number(e.period_end)});
        const maxResults = people ? Math.min(100, remaining) : 100;
        const reserved = people ? maxResults : 1;
        const result = await client.query('UPDATE circle_entitlements SET list_used=list_used+$1 WHERE invoice_id=$2 AND revoked=false AND list_used+$1<=list_limit RETURNING invoice_id', [reserved,e.invoice_id]);
        if (!result.rows.length) throw Object.assign(new BillingError(429, '一覧の取得枠を確認しています。少し待って再度お試しください。', 'quota_exceeded'), {quotaKind:'list',retryAt:Number(e.period_end)});
        const day = new Date(clock()).toISOString().slice(0,10);
        await client.query('INSERT INTO circle_api_budget (day,used_units) VALUES ($1,0) ON CONFLICT (day) DO NOTHING',[day]);
        const cost = maxResults * 100;
        const budget = await client.query('UPDATE circle_api_budget SET used_units=used_units+$1 WHERE day=$2 AND used_units+$1<=$3 RETURNING day',[cost,day,config.dailyUnits]);
        if (!budget.rows.length) throw new BillingError(503, 'サービス全体の本日の取得上限に達しました。時間をおいてお試しください。', 'service_budget');
        const reservationId = crypto.randomUUID();
        await client.query('INSERT INTO circle_list_reservations (id,member_id,invoice_id,reserved_count,max_results,list_unit,day,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [reservationId,id,e.invoice_id,reserved,maxResults,e.list_unit || 'requests',day,clock()]);
        return {reservationId,maxResults,invoiceId:e.invoice_id};
      });
    },
    async settleList(id, reservationId, actual) {
      if (!Number.isSafeInteger(actual) || actual < 0 || actual > 100) throw new BillingError(502, '一覧の取得人数を確認できません。');
      return tx(async client => {
        const result = await client.query('UPDATE circle_list_reservations SET settled=true WHERE id=$1 AND member_id=$2 AND settled=false AND max_results>=$3 RETURNING *',[reservationId,id,actual]);
        const r = result.rows[0];
        if (!r) return;
        const unused = Number(r.max_results) - actual;
        if (r.list_unit === 'people' && unused)
          await client.query('UPDATE circle_entitlements SET list_used=list_used-$1 WHERE invoice_id=$2 AND list_used>=$1',[unused,r.invoice_id]);
        if (unused)
          await client.query('UPDATE circle_api_budget SET used_units=used_units-$1 WHERE day=$2 AND used_units>=$1',[unused*100,r.day]);
      });
    }
  };
}
