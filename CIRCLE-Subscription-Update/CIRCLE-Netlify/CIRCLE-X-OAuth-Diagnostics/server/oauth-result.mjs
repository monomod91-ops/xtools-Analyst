// Only fixed, non-sensitive result codes may cross the OAuth redirect.
const directCodes = new Set([
  'login_required', 'subscription_required', 'billing_disabled', 'not_configured',
  'api_paused', 'service_budget', 'billing_unavailable', 'x_account_mismatch',
  'state_error', 'scope', 'oauth_profile_invalid', 'oauth_network', 'network',
  'x_credits_depleted'
]);
const stages = new Set([
  'request', 'database', 'identity', 'subscription', 'integration', 'state',
  'quota', 'token', 'scopes', 'profile', 'binding', 'session'
]);
const oauthErrors = new Set([
  'invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_grant',
  'invalid_scope', 'unsupported_grant_type', 'access_denied',
  'temporarily_unavailable', 'server_error'
]);

export function safeOAuthError(value) {
  return typeof value === 'string' && oauthErrors.has(value) ? value : undefined;
}

export function oauthFailureCode(error) {
  if (directCodes.has(error?.code)) return error.code;
  if (error?.code === 'quota_exceeded') return 'link_quota_exceeded';
  if (error?.code === 'x_api') {
    return ({401:'x_token_invalid', 402:'x_credits_depleted',
      403:'x_permission_denied', 429:'x_rate_limited'})[error.status] || 'x_api_failed';
  }
  if (error?.code === 'oauth') {
    const reason = safeOAuthError(error.oauthError);
    if (reason === 'invalid_grant') return 'oauth_code_invalid';
    if (reason === 'invalid_scope') return 'scope';
    if (['invalid_client', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type'].includes(reason))
      return 'oauth_app_settings';
    if (reason === 'access_denied') return 'oauth_denied';
    return 'oauth_rejected';
  }
  return 'failed';
}

export function oauthFailureResponse(error, origin, stage = 'request') {
  const code = oauthFailureCode(error);
  const reference = crypto.randomUUID();
  const status = Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : error?.status;
  // Never log an exception, URL, body, token, state, cookie, email, or user ID.
  console.warn('circle_x_oauth_failed', JSON.stringify({
    reference, stage: stages.has(stage) ? stage : 'request', code,
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? {status} : {})
  }));
  const target = new URL('/', origin);
  target.searchParams.set('auth', code);
  target.searchParams.set('auth_ref', reference);
  return new Response(null, {status:303, headers:{
    Location: target.href, 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer',
    'Set-Cookie': 'circle_oauth=; Path=/api/x; HttpOnly; SameSite=Lax; Max-Age=0' +
      (target.protocol === 'https:' ? '; Secure' : '')
  }});
}
