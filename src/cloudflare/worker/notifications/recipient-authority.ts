/** Authorization is checked at delivery; cron only removes obsolete rows. */
export const PUSH_RECIPIENT_AUTHORITY = `disabled_at IS NULL AND (
	(owner_token_id LIKE 'enrollment:%' AND folder_path IS NULL)
	OR EXISTS (SELECT 1 FROM auth_tokens t WHERE t.id = push_subscriptions.owner_token_id
		AND (t.expires_at IS NULL OR t.expires_at > ?)
		AND (t.scope = 'vault' OR (t.scope = 'reminders'
			AND t.folder_path = push_subscriptions.folder_path
			AND t.folder_path = (SELECT folder_path FROM notification_policy WHERE id = 1))))
)`;
