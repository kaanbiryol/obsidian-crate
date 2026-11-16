/** Reading state an encryption reset removes when it begins, so late extraction cannot
 * publish into the replacement policy. */
export const READING_TABLES = ['reading_policy', 'reading_items', 'note_terms', 'highlight_index', 'reading_tags', 'reading_jobs', 'reading_captures'] as const;

/**
 * What an encryption reset does with every table in schema.sql. Completion empties
 * `wiped`: vault data and access written under the old mode or keys. `custom` tables
 * are changed by their own statements in reset.ts. `kept` tables hold no vault
 * content. reset-tables.test.ts fails when schema.sql gains a table not listed here.
 */
export const ENCRYPTION_RESET_TABLES = {
	wiped: ['files', 'file_versions', 'changelog', 'operations', 'operation_chunks',
		'reminder_file_cache', 'reminder_identities', 'reminder_occurrences', 'reminder_sources', 'reminder_source_state',
		'reminder_projections', 'notification_projection_jobs', 'notification_file_retries', 'notification_policy',
		'grants', 'push_subscriptions', ...READING_TABLES],
	custom: ['auth_tokens', 'maintenance_state', 'server_state', 'upload_leases'],
	kept: ['crate_migrations', 'crate_release', 'crate_schema', 'object_cleanup_queue', 'request_rate_limits', 'vapid_keys'],
} as const;
