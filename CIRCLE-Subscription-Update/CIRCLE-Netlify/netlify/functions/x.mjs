import {getDatabase} from '@netlify/database';
import {getUser} from '@netlify/identity';
import {serve} from '../../server/handler.mjs';
import {billingRuntime} from '../../server/billing-runtime.mjs';
import {billingFailure} from '../../server/plan.mjs';
export default async function handler(request) {
  if(new URL(request.url).pathname==='/api/x/config')return serve(request,process.env,getDatabase);
  try {
    const database=getDatabase();
    return serve(request,process.env,()=>database,{getUser,billing:billingRuntime(process.env,database)});
  }catch(error){return billingFailure(error);}
}
export const config = {path: '/api/x/*'};
