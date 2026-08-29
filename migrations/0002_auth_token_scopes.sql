ALTER TABLE auth_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'vault';
ALTER TABLE auth_tokens ADD COLUMN expires_at INTEGER;

-- Tokens issued by earlier PWA builds were indistinguishable from vault tokens.
-- Preserve those sessions while removing their vault-sync access and bounding
-- their lifetime from the time this migration is applied.
UPDATE auth_tokens
SET scope = 'reminders',
    expires_at = (CAST(strftime('%s', 'now') AS INTEGER) + (90 * 24 * 60 * 60)) * 1000
WHERE platform = 'pwa';
