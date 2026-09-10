CREATE TABLE IF NOT EXISTS circle_sessions (
 id text PRIMARY KEY, kind text NOT NULL, payload text NOT NULL, expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS circle_sessions_expiry ON circle_sessions(expires_at);
CREATE TABLE IF NOT EXISTS circle_actions (
 id text PRIMARY KEY, owner text NOT NULL, target_id text NOT NULL, username text NOT NULL,
 operation text NOT NULL, status text NOT NULL, message text NOT NULL, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS circle_actions_owner_time ON circle_actions(owner, created_at DESC);
