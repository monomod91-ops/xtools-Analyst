import {getDatabase} from '@netlify/database';
export default async function cleanup() {
  const db=getDatabase(), now=Date.now();
  await db.sql`DELETE FROM circle_sessions WHERE expires_at < ${now}`;
  await db.sql`DELETE FROM circle_actions WHERE created_at < ${now-7*86400000}`;
  return new Response(null,{status:204});
}
export const config={schedule:'17 * * * *'};
