// Local test harness only; production uses Netlify PostgreSQL, never SQLite.
import {DatabaseSync} from 'node:sqlite';
import {createDatabase} from '../server/database.mjs';
export function database(path,schema) {
 const raw=new DatabaseSync(path);raw.exec(schema);
 const db=createDatabase(async(parts,...values)=>raw.prepare(parts.join('?')).all(...values));
 return {...db,raw};
}
