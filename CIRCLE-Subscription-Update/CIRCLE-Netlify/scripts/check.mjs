import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
import {createHash} from 'node:crypto';
const html=await readFile('public/index.html','utf8');
if(html.includes('circle-x-review.damdam3ce.chatgpt.site')) throw new Error('Old service URL remains');
for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
new Script(await readFile('public/assets/circle-app.js','utf8'));
if(!html.includes('/assets/membership.js')||!html.includes('id="root" hidden'))throw Error('Membership gate is missing');
for(const file of ['server/billing.mjs','server/billing-store.mjs','netlify/functions/billing.mjs','public/assets/membership.js'])await readFile(file);
const manifest=JSON.parse(await readFile('../source-manifest.json','utf8'));
for(const file of manifest.filter(f=>f.path.includes('/migrations/'))){
 const data=await readFile('../'+file.path);
 const hash=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`),data])).digest('hex');
 if(hash!==file.sha)throw Error('An already-applied migration was changed: '+file.path);
}
const schema=await readFile('netlify/database/migrations/20260908000100_circle.sql','utf8');
if(!schema.includes('circle_sessions')||!schema.includes('circle_actions'))throw new Error('Missing migration');
console.log('CIRCLE Netlify files checked.');
