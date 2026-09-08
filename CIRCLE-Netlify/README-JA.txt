CIRCLE — marinqueen.com / Netlify版

このZIPは「HTML＋認証サーバー＋データベース定義」の一式です。
まだNetlifyへ反映していません。Xの本番接続テストも未実施です。
通常ユーザーは公開後に「Xと連携」を押して許可するだけです。
以下は運営者が一度行う設置作業です。

【重要】このZIPをNetlifyのDrop欄へ置くだけではサーバーは公開されません。
GitHub連携、またはNetlify CLIから公開する必要があります。

1. X Developerの設定
アプリの種類：ウェブアプリ、自動化アプリまたはボット
コールバックURI：https://marinqueen.com/api/x/oauth/callback
ウェブサイトURL：https://marinqueen.com/
OAuth 1.0aの権限：読み取りと書き込み（DMは使いません）
アプリの種類を変更した後のOAuth 2.0 Client IDとClient Secretを使います。

2. Netlifyの既存サイトに環境変数を登録
Project configuration → Environment variables → Add a variable
Productionで使えるように登録。Scopesを選べる場合はFunctionsを含めます。
X_CLIENT_ID：OAuth 2.0 クライアントID
X_CLIENT_SECRET：OAuth 2.0 クライアントシークレット（秘密として登録）
SESSION_SECRET：パスワード管理アプリ等で生成したランダムな32文字以上の文字列（秘密として登録）
APP_ORIGIN：https://marinqueen.com（末尾の / なし）
X_ENABLE_BLOCKS：false
SESSION_SECRETを変更すると既存のログイン情報が無効になり再連携が必要です。
キーをHTMLやGitHubやチャットへ貼らないでください。

3. サーバー込みで既存のNetlifyサイトに公開
PCでZIPを解凍します。
GitHubでこのツール用の非公開リポジトリを作ります。
Add file → Upload files で、解凍したCIRCLE-Netlifyの中身をフォルダ構成ごと追加します。
リポジトリの一番上にpackage.json、netlify.toml、public、server、netlifyがある構成です。
秘密情報は追加しません。すでに同じサイトで公開中のポリシーや他のページがあれば、
この一式のpublic内に同じURLになる配置で入れてから公開してください。

Netlifyでmarinqueen.comを割り当てた「既存のサイト」を開きます。
Project configuration → Build & deploy → Continuous deployment → Repository → Link repository
作ったGitHubリポジトリを選びます。
Build command：npm run build
Publish directory：public
Functions directory：netlify/functions
設定はnetlify.tomlにも含めてあります。Netlify Databaseの作成とマイグレーションは
対応するNetlifyのビルドで自動実行されます。プランや利用上限により使用できない場合は
Data & Storage → Database とデプロイログを確認してください。
既存ドメインを別サイトへ付け替える必要はありません。

4. 確認
公開成功後、https://marinqueen.com/api/x/config を開きます。
JSONに configured:true と正しいcallbackが出れば接続情報の形式は揃っています。
これはXのキーが実際に有効か、データベースが正常かを証明するものではありません。
https://marinqueen.com/ の「Xと連携」を押して、Xの画面で許可します。
認証後に一覧が出ることを確認してください。
取得にはX APIの利用枠が必要です。不足時はエラーが表示されます。

判定は最終ログインではなく最終投稿が基準です。
読むだけの人・非公開・投稿を取得できない人を、未ログインと断定しません。
解除は対象を確認して1件ずつ行います。X側のブロックAPI利用資格が確認できるまでは
X_ENABLE_BLOCKS=falseのままにします。
トークンは暗号化して保存し、セッションは約2時間以内で期限切れになります。
履歴は7日分を表示し、期限切れデータは定期処理と次回連携時に削除します。

検証範囲
ローカルでJavaScript構文、SQL変換とモックX APIによる認証・操作のテストを実施。
Netlify SDKのダウンロードは作業環境のネットワーク制限で行えませんでした。
Netlifyでの依存関係インストール、PostgreSQL接続、本番OAuthは公開後の確認が必要です。

公式資料
https://docs.netlify.com/build/functions/get-started/
https://docs.netlify.com/build/data-and-storage/netlify-database/getting-started/
https://docs.netlify.com/build/git-workflows/repo-permissions-linking/
https://docs.netlify.com/build/environment-variables/get-started/
