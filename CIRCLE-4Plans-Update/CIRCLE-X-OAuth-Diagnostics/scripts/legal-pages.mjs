import {PLANS, PRICE_ENV} from '../server/plan.mjs';
import {readFile, writeFile} from 'node:fs/promises';
const merchant=JSON.parse(await readFile('merchant.json','utf8'));
const fields=['businessName','representative','address','phone','supportEmail'];
const ready=merchant.confirmed===true && fields.every(k=>typeof merchant[k]==='string'&&merchant[k].trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merchant.supportEmail);
const launchSettings=process.env.MERCHANT_DETAILS_CONFIRMED==='true' && [process.env.STRIPE_PRICE_ID,...Object.values(PRICE_ENV).map(k=>process.env[k])].some(v=>/^price_/.test(v||'')) &&
  /^bpc_/.test(process.env.STRIPE_PORTAL_CONFIG_ID||'') && ['test','live'].includes(process.env.STRIPE_MODE);
if(process.env.BILLING_ENABLED==='true' && (!ready || !launchSettings))
  throw Error('Billing launch requires completed merchant details, matching Stripe settings, and MERCHANT_DETAILS_CONFIRMED=true.');
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const details=ready ? fields.map((key,i)=>`<dt>${['販売事業者','運営責任者','所在地','電話番号','お問い合わせ'][i]}</dt><dd>${escape(merchant[key])}</dd>`).join('') : '<p>販売者情報は公開準備中です。現在、新規のお申し込みは受け付けていません。</p>';
await writeFile('public/seller.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>販売者情報 | CIRCLE</title><link rel="stylesheet" href="/assets/membership.css"><main class="circle-document"><a href="/">◎ CIRCLE</a><h1>販売者情報</h1><dl>${details}</dl><h2>販売価格・お支払い</h2><p>${PLANS.map(p=>p.name+'：月額'+p.amount.toLocaleString('ja-JP')+'円（税込）').join('、')}。既存の月額1,980円・分析100人分の契約は元の条件で継続します。お支払い総額は決済画面で確認できます。月額プランは毎月自動更新され、追加の従量料金はありません。支払い方法は決済画面に表示されます。</p><h2>提供時期・解約</h2><p>決済確認後に利用できます。契約管理画面で次回更新を停止できます。停止後もお支払い済みの契約期間末まで利用できます。</p><h2>返金・お問い合わせ</h2><p>解約時の未使用枠の繰越はありません。返金の可否、サービス障害、その他のお問い合わせは上記連絡先にご連絡ください。法令上認められる権利を制限するものではありません。</p><p><a href="/membership-terms.html">利用条件</a> · <a href="/membership-privacy.html">プライバシー</a></p></main></html>`);
const planTable='<table><thead><tr><th>プラン</th><th>月額・税込</th><th>分析</th><th>一覧</th><th>解除関連</th><th>連携</th></tr></thead><tbody>'+PLANS.map(p=>'<tr><th>'+escape(p.name)+'</th><td>'+p.amount.toLocaleString('ja-JP')+'円</td><td>'+p.limits.analysis+'人分</td><td>'+p.limits.list+'人分</td><td>'+p.limits.action+'人分</td><td>'+p.limits.link+'回</td></tr>').join('')+'</tbody></table>';
const terms=await readFile('public/membership-terms.html','utf8');
if(!terms.includes('<!--CIRCLE_PLAN_TABLE_START-->'))throw Error('Pricing table marker missing');
await writeFile('public/membership-terms.html',terms.replace(/<!--CIRCLE_PLAN_TABLE_START-->[\s\S]*?<!--CIRCLE_PLAN_TABLE_END-->/,'<!--CIRCLE_PLAN_TABLE_START-->'+planTable+'<!--CIRCLE_PLAN_TABLE_END-->'));
