import Stripe from 'stripe';
import {getDatabase} from '@netlify/database';
import {createBillingStore} from './billing-store.mjs';
import {createBillingService} from './billing.mjs';
export function billingRuntime(env, database = getDatabase()) {
  const store = createBillingStore(database.pool);
  const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-07-29.dahlia', maxNetworkRetries: 1, timeout: 15000
  }) : null;
  return {database, store, service: createBillingService({stripe, store, env})};
}
