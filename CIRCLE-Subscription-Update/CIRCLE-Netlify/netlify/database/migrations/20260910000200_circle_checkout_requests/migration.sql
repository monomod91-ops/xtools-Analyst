-- Preserve the earlier membership migration, including copies already downloaded.
-- Store an in-flight Checkout request before contacting Stripe so retries can
-- recover a created session even if the original HTTP response was lost.
ALTER TABLE circle_memberships ADD COLUMN IF NOT EXISTS checkout_request_id text;
ALTER TABLE circle_memberships ADD COLUMN IF NOT EXISTS checkout_request text;
