import {getDatabase} from '@netlify/database';
import {serve} from '../../server/handler.mjs';
export default async function handler(request) { return serve(request, process.env, getDatabase); }
export const config = {path: '/api/x/*'};
