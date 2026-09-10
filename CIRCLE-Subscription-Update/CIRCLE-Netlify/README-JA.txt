CIRCLE 月額サービス更新版（公開前・検証用）

対象：monomod91-ops/xtools-Analyst → Netlify xtoolfoll → marinqueen.com
基準コミット：c7ab4c3901066f391af3be1948fbbf0bc5a2a17e
この一式は本番公開されていません。既存サイトにはまだ課金制限が反映されていません。

今回追加したもの
・メール認証による会員登録・ログイン・パスワード再設定（Netlify Identity）
・Stripe Checkoutの月額プランと、契約確認・解約画面
・支払い済み請求書に基づく利用権の付与
・契約月の分析100回、一覧取得2回（各最大100人）、解除確認20回、X再連携20回
・契約1つにつきXアカウント1つ。アカウントを替えて枠を増やす操作を拒否
・上限到達時のサーバー側停止。超過分を自動請求しない
・同じ一覧・同じ条件の分析結果は24時間保存して再利用
・返金・支払取り消し期間の停止、支払い通知の重複・順不同対策
・サービス全体の1日API予算と一時停止スイッチ

採用した料金
月額1,980円（税込扱い）。本番設定と決済の検証が終わるまで、課金受付は停止します。
1契約月は請求書に記録された期間です。暦月ではありません。
通信開始で回数を消費し、Xのエラーも含みます。同じ人の別条件での分析も1回です。
解除確認は再チェックを含み、解除できない場合も1回を消費します。
未使用枠の繰越はありません。次回更新停止後も支払済み期間末まで利用できます。

料金・利用枠は server/plan.mjs が基準です。料金を変える場合はStripeの新しいPrice、
画面・利用条件・販売者情報の記載も合わせて更新してください。
公開後の既存契約の金額や利用枠を、この版の設定変更だけで自動変更する設計ではありません。

費用の制御
X APIの公開単価をもとに、多く見積もった呼び出し量を実行前に予約します。
全枠を使い、ブロック操作も有効にした場合の目安は1契約月最大5.90米ドル相当です。
同日取得の重複割引を当てにせず、結果が不明な通信でも予約量を戻しません。
これは将来のX単価・為替・ホスティング・決済手数料・返金費用込みの原価保証ではありません。
Xの価格変更時はAPI_COSTを見直してください。StripeやXで自動チャージ・上限も確認してください。
https://docs.x.com/x-api/getting-started/pricing

今回Netlifyに準備済みの変数（all / Builds, Functions）
BILLING_ENABLED=false
MERCHANT_DETAILS_CONFIRMED=false
CIRCLE_DAILY_API_BUDGET_CENTS=1000
STRIPE_MODEはproduction=live、dev・branch-deploy・deploy-preview=testです。
これらの変数だけでは旧公開コードのXアクセスは止まりません。新しいコードの公開が必要です。
CIRCLE_DAILY_API_BUDGET_CENTS=1000 はサービス全体で1日10米ドル相当の予約予算です。
予算到達時は顧客の回数消費を取り消してから一時停止します。課金済み顧客にも影響するため、
想定顧客数と運営予算に合わせて確定してください。API単価の厳密な請求上限ではありません。

既存GitHubへの更新
ZIPを展開すると次の構成です。この階層を既存リポジトリに合わせて上書きします。
  netlify.toml
  source-manifest.json
  CIRCLE-Netlify/package.json
  CIRCLE-Netlify/client/
  CIRCLE-Netlify/public/
  CIRCLE-Netlify/server/
  CIRCLE-Netlify/netlify/
  CIRCLE-Netlify/scripts/
  CIRCLE-Netlify/tests/
  CIRCLE-Netlify/merchant.json
CIRCLE-Netlifyを二重にネストしないでください。ZIP自体を置くだけでは反映されません。
ルートのnetlify.tomlは base=CIRCLE-Netlify、publish=public、functions=netlify/functionsです。
Node22を指定します。Node24でもローカルテストは実行できます。
以前のマイグレーション2つは、GitHubの原本とバイト一致するものをそのまま含めています。
削除・改名・書き換えをしないでください。今回の会員用・決済申込保存用マイグレーションだけが追加です。
以前お渡しした会員用マイグレーションも変更せず、決済申込用は別ファイルで追加しました。
過去に不足したcreate_marketplace_tablesも含まれます。データを初期化する処理はありません。

依存関係とビルド
  cd CIRCLE-Netlify
  npm install
  npm test
  npm run build
Stripe 22.4.0 / API 2026-07-29.dahlia、@netlify/identity 1.0.0、esbuild 0.25.9を指定しています。
本番依存関係をインストールできる環境で生成されたpackage-lock.jsonをレビューして追加してください。
public/assets/membership.jsはビルド時に生成します。元のX画面はcircle-app.jsとして保持しました。

公開前に必要な設定
1. Netlifyの既存プロジェクト → Identity → Enable Identity。
   新規登録を許可し、メール確認を有効にします。autoconfirmは無効にします。
   メール確認・パスワード再設定のリダイレクト先をサービスURLにします。
   @netlify/identityのgetUser()で確認した本人IDを、サーバー側で契約に結び付けます。
   メールを変更しても会員IDは変わりません。課金状態は利用者の編集可能なプロフィールに保存しません。

2. merchant.jsonに販売事業者、責任者、所在地、電話番号、問い合わせメールを記入。
   公開する内容を確認し、confirmedをtrueにします。契約条件・プライバシー文面も確認してください。
   これらは公開情報です。秘密鍵や個人的なパスワードをこのファイルへ記入しないでください。
   build時にseller.htmlを生成します。未記入のままBILLING_ENABLED=trueではビルドが失敗します。

3. Stripeのサンドボックスで月額商品とPriceを作成します。
   通貨JPY、1,980円、毎月、数量1、固定料金。従量・無料トライアル・数量変更・割引なし。
   Customer Portalの専用設定を作り、支払方法の更新、請求書の表示、期間末解約を有効化。
   プラン変更や数量変更は有効化しません。
   Stripe側の事業者公開情報に、サイト・利用条件・プライバシーURLを登録します。
   Checkoutの利用規約への同意はStripeの決済画面でも必須です。
   Stripe Taxはこの版では自動で有効化していません。本番の固定料金は1,980円・税込扱いで作成済みです。

4. Webhookの送信先と購読イベントを設定します。
   https://marinqueen.com/api/billing/webhook
   APIバージョン2026-07-29.dahlia。
   invoice.paid / invoice.payment_failed
   customer.subscription.created / customer.subscription.updated / customer.subscription.deleted
   customer.subscription.paused / customer.subscription.resumed
   charge.refunded / charge.dispute.created / charge.dispute.closed
   生の本文を署名検証してから処理します。通知が失敗した場合、Stripeの再送が必要です。
   未処理の返金通知を放置しないでください。支払い成功URLを開くだけでは枠は付与されません。
   返金・異議申立てがあった期間は、後から支払い通知が来ても自動再開しません。

5. Netlifyに環境変数を追加します。値は環境ごとに分けます。
   STRIPE_SECRET_KEY：制限付き秘密鍵（Functionsのみ、secret）
   STRIPE_WEBHOOK_SECRET：Webhook署名シークレット（Functionsのみ、secret）
   STRIPE_PRICE_ID：price_...（BuildsとFunctions）
   STRIPE_PORTAL_CONFIG_ID：bpc_...（BuildsとFunctions）
   STRIPE_MODE：test または live（BuildsとFunctions）
   MERCHANT_DETAILS_CONFIRMED：true（内容を確定した後。BuildsとFunctions）
   BILLING_ENABLED：最終検証後にtrue（BuildsとFunctions）
   CIRCLE_API_PAUSED：必要時のみtrue。契約管理と解約は残したままX操作を停止
   X_CLIENT_ID / X_CLIENT_SECRET / SESSION_SECRET / APP_ORIGIN は既存設定を利用。
   X_ENABLE_BLOCKSはXの利用資格を確認できるまでfalseを継続。
   X APIクレジットの残高は別途必要です。月額決済を追加してもXの利用枠は自動補充されません。
   プレビューではAPP_ORIGINとXのCallback URIもそのプレビューURLに合わせます。
   キーをチャット、GitHub、HTMLへ貼る必要はありません。

   必要なStripe権限：Customers作成・取得、Checkout Sessions作成・取得、
   Customer Portal Sessions作成、Prices・Subscriptions・Invoices・Charges・Invoice Payments読取。
   作成済みの商品・Price・Webhookは下の記録を利用し、重複して作成しないでください。
   サンドボックス用の設定は未作成です。本番Customer Portalは下記の保存済み設定を利用します。

6. 保護されたプレビューで確認してから、本番のキー・Price・Webhookへ切り替えます。
   メール確認 → ログイン → Checkout → 署名付きinvoice.paid → 残り枠表示 → X連携。
   未払い・上限到達・解約・支払い失敗・Webhookの再送・返金も確認してください。
   本番決済はまだ開始していません。本番のクレジットカードで試験購入する必要はありません。

検証した範囲
・39件のNodeテストが成功（以前のX操作テスト17件を含む）。
・SQLの条件付き更新、同時要求、全体予算のロールバック、支払い通知再送、
  期間更新・期限切れ、返金、偽装会員、Xアカウント紐付け、固定Price選択を検証。
・JavaScript13ファイルの構文検査に成功。
・以前のマイグレーションのSHA一致を確認。

今回の追加修正
・現在のStripe APIで削除されたinvoice.paidを参照せず、statusとamount_paidで支払いを確認。
  現行形式のinvoice.paid通知から会員の利用開始までローカルで検証しました。
・Checkout作成前に同じ申込IDと内容を保存。通信切断後や30分の時刻境界をまたぐ再操作でも
  同じ申込を再取得し、別の決済申込を重ねて作らないようにしました。
・期限切れの未払い申込から、新しい申込を開始できることも検証しました。

まだ実施できていない検証
・Stripe/Identityの実SDKインストールと本番ビルド（作業環境の依存取得制約）。
・Netlify PostgreSQLでの同時実行、Identityの実認証、Stripeのサンドボックス決済。
・実ブラウザ描画（ブラウザ実行ファイルが作業環境にありません）。
ローカルSQLテストにはSQLiteを使用しています。上記結合検証を置き換えるものではありません。
確認用HTMLはスタンドアロンの画面見本です。登録・決済・X API通信を実行しません。

作成済みの本番設定（まだ課金受付は開始していません）
Stripeアカウント：acct_1UBwLtRahIrkLsKY（あきらそみや、本番）
商品：prod_circle_standard_monthly_v1 / CIRCLE スタンダード
料金：price_1UDuttRahIrkLsKYWAjsCvY9 / JPY 1,980 / 毎月 / 税込扱い / 固定料金
Customer Portal：bpc_1UDwHmRahIrkLsKYjcvRcZjm / 本番の保存済み設定
期間末解約、支払方法更新、請求履歴表示が有効。プラン・数量変更は無効です。
本番STRIPE_PORTAL_CONFIG_IDをNetlifyのBuildsとFunctionsへ保存・再確認済みです。
Webhook：we_1UDv5GRahIrkLsKYTfGtEyXh / 送信停止中（disabled）
Webhook APIバージョン：2026-07-29.dahlia
本番STRIPE_PRICE_IDとSTRIPE_MODE=liveをNetlifyに保存・再確認済みです。
Webhook署名シークレットはNetlifyのFunctions用secretとして保存・再確認済みです。
開発・ブランチ・プレビューのSTRIPE_MODEはtestです。本番と同じPriceやキーを流用しません。
BILLING_ENABLED=falseを維持しています。MERCHANT_DETAILS_CONFIRMEDは本番のみtrueに更新済みです。
署名を確認できる通知受信処理を公開・検証してからWebhookを有効化してください。
商品登録と設定保存だけでは、会員への請求やX API利用は始まりません。
詳細はZIP直下のdeployment-status.jsonに記録しています。秘密値は含めていません。

現在の接続権限と残る作業
ビルド実行時のネットワーク承認処理もキャンセルされ、ビルド結果は取得できていません。
GitHubへの書き込みは接続権限不足で拒否されています。
Stripeの商品・料金・Webhookの作成権限は反映され、上記の作成が完了しました。
PostCheckoutSessionsとPostBillingPortalConfigurationsは引き続き権限不足で拒否されています。
NetlifyのSTRIPE_SECRET_KEYはsecretとして登録され、本番コンテキストの値が設定されていることを確認しました。
キーの実値・Stripeでの利用可否は未検証です。公開前にFunctionsのみ・Productionのみの適用を確認してください。
Customer Portalは利用者が画面で保存し、STRIPE_PORTAL_CONFIG_IDのNetlify登録は完了しました。
Identityの有効化・メール認証、サンドボックスでの決済と解約の検証が必要です。
販売者名・メール・電話番号は利用者の指定値を反映済みです。
所在地「〒107-0061 東京都港区北青山1-3-3 三橋ビル3階」は、CIRCLE用に契約済みの住所として利用者が確認しました。
販売事業者・運営責任者は指定された「あきらそみや」、電話・メールは指定値です。
merchant.jsonのconfirmedはtrueです。NetlifyのMERCHANT_DETAILS_CONFIRMEDも本番コンテキストでtrueに保存し、再取得して確認しました。
住所の表示については消費者庁の案内を確認してください。
https://www.no-trouble.caa.go.jp/what/mailorder/advertising.html
https://www.no-trouble.caa.go.jp/what/mailorder/
コードのGitHub反映・本番公開・課金受付はまだ行っていません。

資料
https://docs.stripe.com/billing/subscriptions/webhooks
https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices
https://docs.stripe.com/api/idempotent_requests
https://docs.netlify.com/manage/security/secure-access-to-sites/identity/get-started/
https://docs.netlify.com/manage/security/secure-access-to-sites/identity/use-identity-in-functions/
