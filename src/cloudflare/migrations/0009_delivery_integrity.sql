ALTER TABLE reminder_projections ADD COLUMN notification_token TEXT;
ALTER TABLE reminder_projections ADD COLUMN policy_revision TEXT;
ALTER TABLE scheduled_reminders ADD COLUMN delivery_failed_at TEXT;
ALTER TABLE scheduled_reminders ADD COLUMN delivery_error TEXT;
ALTER TABLE scheduled_reminders ADD COLUMN delivery_attempts INTEGER;

-- Old schedules cannot prove their source intent. Reproject before delivery.
INSERT OR REPLACE INTO notification_projection_jobs (path, job_token)
SELECT path, storage_key FROM files WHERE lower(path) LIKE '%.md';

-- Unattributable legacy subscriptions must explicitly enroll again.
UPDATE push_subscriptions SET disabled_at = datetime('now'),
last_error = 'Open a fresh Crate link to enroll this device again'
WHERE owner_token_id IS NULL;
