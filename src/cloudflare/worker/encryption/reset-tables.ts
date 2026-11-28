/** Reading state an encryption reset removes when it begins, so late extraction cannot
 * publish into the replacement policy. Every index write requires the policy row, and each
 * of these tables is small. */
export const READING_POLICY_TABLES = ['reading_policy', 'reading_jobs', 'reading_captures'] as const;
/** The Reading index grows with the library, so the sliced wipe removes it. Without a policy
 * nothing writes it, and while resetting no request can read it. */
const READING_INDEX_TABLES = ['reading_items', 'note_terms', 'highlight_index', 'reading_tags', 'reading_tag_counts'] as const;

/**
 * What an encryption reset does with every table in schema.sql. Completion empties
 * `wiped`: vault data and access written under the old mode or keys. `custom` tables
 * are changed by their own statements in reset.ts. `kept` tables hold no vault
 * content. reset-tables.test.ts fails when schema.sql gains a table not listed here.
 */
export const ENCRYPTION_RESET_TABLES = {
	// The sliced wipe empties tables in this order. The Reading index goes first, because
	// the reset leaves it in place when it begins.
	wiped: [...READING_INDEX_TABLES, 'files', 'file_versions', 'file_moves', 'history_checkpoints', 'changelog', 'operations', 'operation_chunks',
		'reminder_file_cache', 'reminder_identities', 'reminder_occurrences', 'reminder_sources', 'reminder_source_state',
		'reminder_projections', 'notification_projection_jobs', 'notification_file_retries', 'notification_policy',
		'grants', 'push_subscriptions', ...READING_POLICY_TABLES],
	custom: ['auth_tokens', 'maintenance_state', 'server_state', 'upload_leases'],
	kept: ['crate_migrations', 'crate_release', 'crate_schema', 'object_cleanup_queue', 'request_rate_limits', 'vapid_keys'],
} as const;

/** The primary key of each `wiped` table. A reset deletes rows a slice at a time by key,
 * since most tables are WITHOUT ROWID; reset-tables.test.ts checks these against schema.sql. */
export const WIPED_TABLE_KEYS: Record<(typeof ENCRYPTION_RESET_TABLES.wiped)[number], string> = {
	files: 'portable_path', file_versions: 'id', file_moves: 'storage_key, seq', history_checkpoints: 'seq', changelog: 'seq',
	operations: 'kind, operation_id', operation_chunks: 'kind, operation_id, idx',
	reminder_file_cache: 'folder_path, file_path', reminder_identities: 'reminder_id', reminder_occurrences: 'reminder_id, due_key',
	reminder_sources: 'file_path, reminder_id', reminder_source_state: 'file_path', reminder_projections: 'reminder_id',
	notification_projection_jobs: 'path', notification_file_retries: 'path', notification_policy: 'id',
	grants: 'kind, key', push_subscriptions: 'id',
	reading_policy: 'id', reading_items: 'id', note_terms: 'term, saved_at, item', highlight_index: 'highlighted_at, item',
	reading_tags: 'term', reading_tag_counts: 'section, term', reading_jobs: 'path', reading_captures: 'id',
};
