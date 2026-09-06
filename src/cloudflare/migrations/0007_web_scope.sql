ALTER TABLE auth_tokens ADD COLUMN folder_path TEXT;
ALTER TABLE web_enrollment_tokens ADD COLUMN folder_path TEXT;
ALTER TABLE push_subscriptions ADD COLUMN owner_token_id TEXT;
ALTER TABLE push_subscriptions ADD COLUMN folder_path TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx ON push_subscriptions(endpoint);
CREATE TABLE IF NOT EXISTS request_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
