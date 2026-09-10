-- Additive only: the two previously applied migrations must be retained unchanged.
CREATE TABLE IF NOT EXISTS circle_memberships (
 member_id text PRIMARY KEY,
 customer_id text UNIQUE,
 subscription_id text UNIQUE,
 subscription_status text NOT NULL DEFAULT 'none',
 cancel_at_period_end boolean NOT NULL DEFAULT false,
 checkout_id text,
 checkout_expires bigint NOT NULL DEFAULT 0,
 stripe_sync_at bigint NOT NULL DEFAULT 0,
 x_user_id text UNIQUE,
 created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS circle_entitlements (
 invoice_id text PRIMARY KEY,
 member_id text NOT NULL REFERENCES circle_memberships(member_id),
 subscription_id text NOT NULL,
 period_start bigint NOT NULL,
 period_end bigint NOT NULL,
 analysis_limit integer NOT NULL CHECK (analysis_limit > 0),
 list_limit integer NOT NULL CHECK (list_limit > 0),
 action_limit integer NOT NULL CHECK (action_limit >= 0),
 link_limit integer NOT NULL CHECK (link_limit > 0),
 analysis_used integer NOT NULL DEFAULT 0,
 list_used integer NOT NULL DEFAULT 0,
 action_used integer NOT NULL DEFAULT 0,
 link_used integer NOT NULL DEFAULT 0,
 revoked boolean NOT NULL DEFAULT false,
 CHECK (period_end > period_start)
);
CREATE INDEX IF NOT EXISTS circle_entitlements_member_period ON circle_entitlements(member_id,period_end DESC);
CREATE TABLE IF NOT EXISTS circle_payment_blocks (
 invoice_id text PRIMARY KEY,
 reason text NOT NULL,
 created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS circle_billing_events (
 event_id text PRIMARY KEY,
 event_type text NOT NULL,
 processed_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS circle_api_budget (
 day text PRIMARY KEY,
 used_units integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS circle_billing_locks (
 member_id text PRIMARY KEY,
 owner text NOT NULL,
 expires_at bigint NOT NULL
);
