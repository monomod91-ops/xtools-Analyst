import {requireMember} from './plan.mjs';

// Pass only the server-side @netlify/identity SDK, never request body data.
export async function getMemberIdentity(identity) {
  const session = await identity.getUser();
  // On the server, getUser() authenticates through Identity or uses claims
  // already validated by Netlify. It never authenticates an unverified cookie
  // by decoding it. A validated session can omit profile timestamps.
  // Admin/profile availability is not part of the login contract.
  return session ? requireMember(session) : null;
}
