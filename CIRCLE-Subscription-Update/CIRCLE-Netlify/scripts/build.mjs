import {build} from 'esbuild';
import {readFile, writeFile} from 'node:fs/promises';
const merchant=JSON.parse(await readFile('merchant.json','utf8'));
const fields=['businessName','representative','address','phone','supportEmail'];
const ready=merchant.confirmed===true && fields.every(k=>typeof merchant[k]==='string'&&merchant[k].trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merchant.supportEmail);
const launchSettings=process.env.MERCHANT_DETAILS_CONFIRMED==='true' && /^price_/.test(process.env.STRIPE_PRICE_ID||'') &&
  /^bpc_/.test(process.env.STRIPE_PORTAL_CONFIG_ID||'') && ['test','live'].includes(process.env.STRIPE_MODE);
if(process.env.BILLING_ENABLED==='true' && (!ready || !launchSettings))
  throw Error('Billing launch requires completed merchant details, matching Stripe settings, and MERCHANT_DETAILS_CONFIRMED=true.');
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const details=ready ? fields.map((key,i)=>`<dt>${['販売事業者','運営責任者','所在地','電話番号','お問い合わせ'][i]}</dt><dd>${escape(merchant[key])}</dd>`).join('') : '<p>販売者情報は公開準備中です。現在、新規のお申し込みは受け付けていません。</p>';
await writeFile('public/seller.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>販売者情報 | CIRCLE</title><link rel="stylesheet" href="/assets/membership.css"><main class="circle-document"><a href="/">◎ CIRCLE</a><h1>販売者情報</h1><dl>${details}</dl><h2>販売価格・お支払い</h2><p>月額1,980円。お支払い総額は決済画面で確認できます。月額プランは毎月自動更新され、追加の従量料金はありません。支払い方法は決済画面に表示されます。</p><h2>提供時期・解約</h2><p>決済確認後に利用できます。契約管理画面で次回更新を停止できます。停止後もお支払い済みの契約期間末まで利用できます。</p><h2>返金・お問い合わせ</h2><p>解約時の未使用枠の繰越はありません。返金の可否、サービス障害、その他のお問い合わせは上記連絡先にご連絡ください。法令上認められる権利を制限するものではありません。</p><p><a href="/membership-terms.html">利用条件</a> · <a href="/membership-privacy.html">プライバシー</a></p></main></html>`);
await build({entryPoints:['client/membership.mjs'],outfile:'public/assets/membership.js',bundle:true,
  format:'esm',platform:'browser',target:['es2022'],minify:true,sourcemap:false,legalComments:'eof'});
console.log('Membership client and seller information built.');
