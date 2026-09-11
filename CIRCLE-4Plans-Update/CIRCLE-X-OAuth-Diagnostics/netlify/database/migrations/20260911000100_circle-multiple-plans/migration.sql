-- Existing invoices keep their original caps and request-based list allowance.
ALTER TABLE circle_entitlements ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'legacy1980';
ALTER TABLE circle_entitlements ADD COLUMN IF NOT EXISTS list_unit text NOT NULL DEFAULT 'requests';
CREATE TABLE IF NOT EXISTS circle_list_reservations (
 id text PRIMARY KEY,
 member_id text NOT NULL,
 invoice_id text NOT NULL REFERENCES circle_entitlements(invoice_id),
 reserved_count integer NOT NULL CHECK (reserved_count > 0),
 max_results integer NOT NULL CHECK (max_results > 0 AND max_results <= 100),
 list_unit text NOT NULL CHECK (list_unit IN ('requests','people')),
 day text NOT NULL,
 settled boolean NOT NULL DEFAULT false,
 created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS circle_list_reservations_invoice ON circle_list_reservations(invoice_id);
