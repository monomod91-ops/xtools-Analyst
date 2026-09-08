import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
const html=await readFile('public/index.html','utf8');
if(html.includes('circle-x-review.damdam3ce.chatgpt.site')) throw new Error('Old service URL remains');
for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
const schema=await readFile('netlify/database/migrations/20260908000100_circle.sql','utf8');
if(!schema.includes('circle_sessions')||!schema.includes('circle_actions'))throw new Error('Missing migration');
console.log('CIRCLE Netlify files checked.');
