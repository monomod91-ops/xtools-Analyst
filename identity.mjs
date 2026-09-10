import {BillingError, requireMember} from './plan.mjs';

// Pass only the server-side @netlify/identity SDK, never request body data.
export async function getMemberIdentity(identity) {
  const session = await identity.getUser();
  if (!session) return null;
  if (typeof session.id !== 'string' || !session.id ||
      typeof session.email !== 'string' || !session.email)
    throw new BillingError(401, 'ログイン情報を確認できません。もう一度ログインしてください。', 'login_required');

  if (typeof session.confirmedAt === 'string' && Number.isFinite(Date.parse(session.confirmedAt)))
    return session;

  // SDK 1.0.0 may return validated JWT claims without confirmation timestamps.
  // Its getUser() tries the runtime's operator token against /user. That token
  // belongs to /admin/users/:id, so use the SDK's read-only admin API to load
  // this authenticated user's record. Never accept a client-supplied user ID.
  let profile;
  try { profile = await identity.admin.getUser(session.id); }
  catch (error) {
    if (error?.status === 404)
      throw new BillingError(401, 'ログイン情報を確認できません。もう一度ログインしてください。', 'login_required');
    throw new BillingError(503, '認証サービスからアカウント情報を取得できませんでした。', 'identity_unavailable');
  }
  if (profile?.id !== session.id)
    throw new BillingError(401, 'ログイン情報が一致しません。もう一度ログインしてください。', 'identity_mismatch');
  requireMember(profile);
  return profile;
}
