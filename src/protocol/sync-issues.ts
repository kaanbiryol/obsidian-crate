/** Stable identifiers for issues whose wording this repo owns. Clients choose an
 * explanation by code and match message text only for peers that send none.
 * The reminder parser codes are the plugin's reminder diagnostic codes. */
const SYNC_ISSUE_CODES = [
	'file-too-large',
	'reminder-note-too-large',
	'invalid-description-block',
	'invalid-description-encoding',
	'unsupported-description-encoding',
	'invalid-markdown-encoding',
	'duplicate-reminder-id',
	'more-reminder-issues',
	'vault-scan-incomplete',
	'transfer-unverified',
] as const;

export type SyncIssueCode = typeof SYNC_ISSUE_CODES[number];

/** Unknown codes, for example from a newer server, fall back to message matching. */
export const isSyncIssueCode = (value: unknown): value is SyncIssueCode => SYNC_ISSUE_CODES.includes(value as SyncIssueCode);
