import {handle} from './core.mjs';
import {createDatabase} from './database.mjs';
export async function serve(request, variables, getDatabase) {
  const origin = variables.APP_ORIGIN || 'https://marinqueen.com';
  const current = new URL(request.url);
  if (current.origin !== origin) {
    return new Response(JSON.stringify({error:'https://marinqueen.com から開き直してください。'}), {status:400,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
  const headers = new Headers(request.headers);
  headers.delete('oai-authenticated-user-id');
  const req = new Request(request, {headers});
  const env = {
    APP_ORIGIN: origin,
    X_CLIENT_ID: variables.X_CLIENT_ID,
    X_CLIENT_SECRET: variables.X_CLIENT_SECRET,
    SESSION_SECRET: variables.SESSION_SECRET,
    X_ENABLE_BLOCKS: variables.X_ENABLE_BLOCKS || 'false',
    REQUIRE_WORKSPACE_AUTH: 'false'
  };
  try {
    // The web-app configuration requires both credentials. Never expose values.
    if (env.X_CLIENT_ID && env.X_CLIENT_SECRET && env.SESSION_SECRET?.length >= 32) {
      const database = getDatabase();
      env.DB = createDatabase(database.sql);
    }
    return await handle(req, env);
  } catch {
    return new Response(JSON.stringify({error:'現在、接続サービスを準備中です。',code:'not_configured'}), {status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
}
