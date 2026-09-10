// Exercises the production SQL against SQLite with serialized connections.
// PostgreSQL/Stripe/Identity integration still requires a Netlify preview.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function billingPool() {
  const raw=new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../netlify/database/migrations/20260910000100_circle_membership/migration.sql',import.meta.url),'utf8'));
  raw.exec(readFileSync(new URL('../netlify/database/migrations/20260910000200_circle_checkout_requests/migration.sql',import.meta.url),'utf8')
    .replaceAll('ADD COLUMN IF NOT EXISTS','ADD COLUMN'));
  let tail=Promise.resolve();
  return {raw, async connect(){
    const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;
    return {release,async query(sql,params=[]){
      if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)){raw.exec(sql);return {rows:[]};}
      const values=[];
      const prepared=sql.replace(/ FOR UPDATE/g,'').replace(/\$(\d+)/g,(_,n)=>{const value=params[Number(n)-1];values.push(typeof value==='boolean'?Number(value):value);return '?';});
      return {rows:raw.prepare(prepared).all(...values)};
    }};
  }};
}
