import { featureEnabled } from '../server/feature-policy';
import type { FeaturePolicy } from '../../../protocol/feature-policy';
import { NOTIFICATION_DELIVERY_WINDOW_MS, planNotificationOperations, readExistingNotifications, schedulePayloadKey, type NotificationOperation } from './projection-plan';
import { takeCommittedSource } from './committed-sources';
import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from '../sync/file-identity';
import { recordFileFailure } from './file-retries';
import { READY_PROJECTION_JOBS_SQL } from './queue';
import { notificationDatetime } from '../../../reminders/core/notification-time';
import { queryRows } from '../d1/db';
import { duplicateReminderIds, ReminderIdentityConflictError } from '../reminders/source-identity';
import { loadStoredFileRows, type FileStorageRow } from '../sync/storage';
import { readStoredMarkdownFiles } from '../sync/markdown-files';
import { getNotificationPolicy } from './policy';
import { parseReminderSource, REMINDER_SOURCE_SIZE_ISSUE, REMINDER_PROJECTION_SIZE_ISSUE, DUPLICATE_COMMITTED_REMINDER_ISSUE, PermanentReminderSourceError, isPermanentSourceError, reminderSourceByteLimit } from '../reminders/source-parse';
import { REMINDER_CACHE_PARSER_VERSION } from '../reminders/cache/types';
import { reminderFileCacheUpsert } from '../reminders/cache/persist';
import { reparseByteBudget, type VerifiedSourceBytes } from '../reminders/source-migration';
import type { Env } from '../types';
import type { RemoteReminderRecord } from '../reminders/types';
import type { NotificationPolicy } from '../../../protocol/notification-policy';
import { isReminderPath } from '../reminders/scope';
import { readEncryptionState } from '../encryption/state';
import type { EncryptionServerState } from '../../../encryption/server-state';

export { notificationDatetime };

/** Bound each D1 value without imposing a second, smaller per-note limit.
 * All chunks are published in one guarded transaction below. */
function operationChunks(operations: ReturnType<typeof planNotificationOperations>): string[] {
	const limit = 1536 * 1024, encoder = new TextEncoder();
	const chunks: string[] = [];
	let items: string[] = [], bytes = 2;
	for (const operation of operations) {
		const json = JSON.stringify(operation), size = encoder.encode(json).byteLength;
		if (size + 2 > limit) throw new PermanentReminderSourceError(REMINDER_PROJECTION_SIZE_ISSUE);
		if (bytes + size + (items.length ? 1 : 0) > limit) {
			chunks.push(`[${items.join(',')}]`); items = []; bytes = 2;
		}
		bytes += size + (items.length ? 1 : 0); items.push(json);
	}
	if (items.length || !chunks.length) chunks.push(`[${items.join(',')}]`);
	return chunks;
}

const AWAITING_VERIFICATION = 'Reminder source is awaiting verification with the current parser. Processing will retry within its retry budget. The vault file remains synced.';

/** One reminder of a projection snapshot: its due key, the first observation of that due key,
 * and its projection row: null for none, '' for a row without a schedule, or the schedule's
 * `schedulePayloadKey`. */
type SnapshotEntry = [due: string, firstSeenAt: number | null, row: string | null];
type ProjectionSnapshot = Record<string, SnapshotEntry>;

/** A file's snapshot lists every reminder its last projection saw, with that reminder's row.
 * Only this file's projection writes rows naming it, and a commit that adds or removes one of
 * its reminder identities elsewhere queues its job with `recheck`, which ignores the snapshot. */
function readSnapshot(text: string | null | undefined): ProjectionSnapshot | null {
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as ProjectionSnapshot : null;
	} catch { return null; }
}

const dueKey = (reminder: RemoteReminderRecord) => reminder.dueDatetime ?? reminder.dueDate ?? '';
const projectedIds = (rows: ReadonlyMap<string, { id: string; filePath: string | null }>, path: string) =>
	[...rows.values()].filter(row => row.filePath === path).map(row => row.id);

/** Bounded projection of committed files. Client reminder snapshots never schedule or cancel.
 * Returns whether a commit wrote a schedule, so the dispatcher may need an earlier alarm. */
export async function drainNotificationProjections(env: Env, limit = 4, loaded?: {
	features: FeaturePolicy; policy: NotificationPolicy | null; encryption: EncryptionServerState | null;
	/** Bytes source verification already read in this pass. */
	verified?: Map<string, VerifiedSourceBytes>;
}): Promise<boolean> {
	if (!(loaded ? loaded.features.reminders : await featureEnabled(env.DB, 'reminders'))) return false;
	const policy = loaded ? loaded.policy : await getNotificationPolicy(env.DB);
	if (!policy) return false;
	const jobs = await queryRows<{ path: string; job_token: string }>(env.DB.prepare(
		READY_PROJECTION_JOBS_SQL).bind(JSON.stringify([...loaded?.verified?.keys() ?? []]), limit, limit, limit));
	if (!jobs.length) return false;
	const encrypted = (loaded ? loaded.encryption : await readEncryptionState(env.DB))?.mode === 'active';
	// Projection commits write only projection rows and their own snapshot; a change to any
	// other row read in this pass replaces the job token each commit checks.
	const [files, states] = await Promise.all([
		loadStoredFileRows(env.DB, jobs.map(job => job.path)),
		queryRows<{ file_path: string; recheck: number; file_revision: string | null; verified: number; projection_snapshot: string | null }>(env.DB.prepare(
			`SELECT j.path AS file_path, j.recheck, s.file_revision, s.verified, s.projection_snapshot FROM notification_projection_jobs j
      LEFT JOIN reminder_source_state s ON s.file_path = j.path AND s.parser_version = ?
      WHERE j.path IN (SELECT value FROM json_each(?))`).bind(REMINDER_CACHE_PARSER_VERSION, JSON.stringify(jobs.map(job => job.path)))),
	]);
	const recheck = new Set(states.filter(row => row.recheck).map(row => row.file_path));
	const sourceStates = new Map(states.filter(row => row.file_revision !== null).map(row => [row.file_path, row]));
	// Parsing shares verification's byte budget; later jobs wait for the next pass.
	const sourceLimit = reminderSourceByteLimit(encrypted), budget = reparseByteBudget(encrypted);
	let bytes = 0, admitted = 0;
	for (const job of jobs) {
		const size = files.get(job.path)?.size ?? 0;
		const readable = size <= sourceLimit ? size : 0;
		if (bytes + readable > budget) break;
		bytes += readable; admitted++;
	}
	const operationFor = (reminder: RemoteReminderRecord, firstSeenAt: number | null): NotificationOperation => {
		const dueDatetime = notificationDatetime(reminder, policy);
		const schedule = policy.enabled !== false && !reminder.completed && dueDatetime
			&& firstSeenAt !== null && firstSeenAt <= Date.parse(dueDatetime);
		return schedule ? { id: reminder.id, operation: 'schedule', payload: {
			reminderId: reminder.id, content: reminder.content, project: reminder.project, dueDatetime,
		} } : { id: reminder.id, operation: 'cancel', payload: null };
	};
	// Parse every admitted job first, so the reads below serve the whole pass. A job with a
	// snapshot reads and plans only the reminders whose due key or schedule changed, and checks
	// identity only for reminders new to its note. One without reads and checks every reminder.
	interface Parsed {
		job: typeof jobs[number]; file: FileStorageRow | null; reminders: RemoteReminderRecord[]; cacheWrite: D1PreparedStatement | null;
		snapshot: ProjectionSnapshot | null;
		/** Reminders whose source row this pass reads: every one without a snapshot. */
		unobserved: string[];
		/** Reminders to plan, with the operation when the snapshot already determines it. */
		changed: Map<string, NotificationOperation | null>;
		checked: string[];
		departed: string[];
	}
	type Entry = Parsed | { job: typeof jobs[number]; error: unknown };
	const parsed = await Promise.all(jobs.slice(0, admitted).map(async (job): Promise<Entry> => {
		try {
			const file = files.get(job.path) ?? null;
			let reminders: RemoteReminderRecord[] = [];
			// The web app's list reuses this parse instead of reading the note again.
			let cacheWrite: D1PreparedStatement | null = null;
			const state = sourceStates.get(job.path);
			if (file && isReminderPath(job.path, policy.folderPath)) {
				if (file.size > sourceLimit) throw new PermanentReminderSourceError(REMINDER_SOURCE_SIZE_ISSUE);
				// A revision this parser has not checked waits for verification, which reads it.
				// One it checked and rejected is still parsed, so a retry reports the same issue.
				if (state?.file_revision !== file.storageKey) throw new Error(AWAITING_VERIFICATION);
				const reused = loaded?.verified?.get(job.path);
				// The commit usually ran in this object and left the bytes it published.
				const committed = reused?.storageKey === file.storageKey ? null : await takeCommittedSource(file);
				const [text] = reused?.storageKey === file.storageKey ? [reused]
					: committed ? [{ content: committed }] : await readStoredMarkdownFiles(env.BUCKET, [{ path: job.path, ...file }]);
				if (!text) throw new Error('Committed reminder content could not be verified');
				// Policy changes can revisit sources outside the current folder. Their
				// uncertain content still cannot authorize removal of prior reminders.
				const source = parseReminderSource(job.path, text.content, policy.folderPath, encrypted);
				if (source.issue) throw new PermanentReminderSourceError(source.issue);
				if (!state.verified) throw new Error(AWAITING_VERIFICATION);
				if (job.path.startsWith(`${policy.folderPath}/`)) {
					reminders = source.reminders;
					if (!encrypted) cacheWrite = reminderFileCacheUpsert(env.DB, policy.folderPath, { filePath: job.path, fileHash: file.hash, reminders });
				}
			}
			const ids = new Set(reminders.map(reminder => reminder.id));
			const snapshot = recheck.has(job.path) ? null : readSnapshot(state?.projection_snapshot);
			if (!snapshot) {
				return { job, file, reminders, cacheWrite, snapshot, unobserved: [...ids],
					changed: new Map([...ids].map(id => [id, null])), checked: [...ids], departed: [] };
			}
			const unobserved: string[] = [], changed = new Map<string, NotificationOperation | null>();
			// Payload keys hash in parallel; `changed` keeps the note's reminder order.
			const keyed = await Promise.all(reminders.map(async reminder => {
				const known = snapshot[reminder.id];
				if (!known || known[0] !== dueKey(reminder)) return { reminder, operation: null, key: null };
				const operation = operationFor(reminder, known[1]);
				return { reminder, operation, key: operation.payload ? await schedulePayloadKey(operation.payload) : '' };
			}));
			for (const { reminder, operation, key } of keyed) {
				if (!operation) {
					unobserved.push(reminder.id);
					changed.set(reminder.id, null);
				} else if (key !== (snapshot[reminder.id]![2] ?? '')) changed.set(reminder.id, operation);
			}
			return { job, file, reminders, cacheWrite, snapshot, unobserved, changed,
				checked: [...ids].filter(id => !snapshot[id]), departed: Object.keys(snapshot).filter(id => !ids.has(id)) };
		} catch (error) { return { job, error }; }
	}));
	const ready = parsed.filter((entry): entry is Parsed => !('error' in entry));
	const full = ready.filter(entry => !entry.snapshot).map(entry => entry.job.path);
	const pairs = ready.flatMap(entry => entry.snapshot ? entry.unobserved.map(id => [entry.job.path, id]) : []);
	const [sourceRows, duplicates, shared] = await Promise.all([
		full.length || pairs.length ? queryRows<{ file_path: string; reminder_id: string; due_key: string; first_seen_at: number | null }>(env.DB.prepare(
			`SELECT s.file_path, s.reminder_id, s.due_key, o.first_seen_at FROM reminder_sources s
        LEFT JOIN reminder_occurrences o ON o.reminder_id = s.reminder_id AND o.due_key = s.due_key
        WHERE s.file_path IN (SELECT value FROM json_each(?))
      UNION ALL SELECT s.file_path, s.reminder_id, s.due_key, o.first_seen_at FROM json_each(?) k
        JOIN reminder_sources s ON s.file_path = json_extract(k.value, '$[0]') AND s.reminder_id = json_extract(k.value, '$[1]')
        LEFT JOIN reminder_occurrences o ON o.reminder_id = s.reminder_id AND o.due_key = s.due_key`)
			.bind(JSON.stringify(full), JSON.stringify(pairs))) : [],
		duplicateReminderIds(env.DB, policy.folderPath, [...new Set(ready.flatMap(entry => entry.checked))]),
		readExistingNotifications(env.DB, [...new Set(ready.flatMap(entry => [...entry.changed.keys()]))], full),
	]);
	const observed = new Map(sourceRows.map(row => [`${row.file_path}\n${row.reminder_id}`, row]));
	// A commit rewrites notification state only for its own reminders and those its file
	// projected before, so one read serves every job unless two jobs touch the same one,
	// as when a reminder moves between notes. Those jobs read after each earlier commit.
	const touched = ready.flatMap(entry => [...new Set([...entry.changed.keys(), ...entry.departed,
		...(entry.snapshot ? [] : projectedIds(shared, entry.job.path))])]);
	const existing = new Set(touched).size === touched.length ? shared : null;
	let scheduled = false;
	for (const entry of parsed) {
		const { job } = entry;
		try {
			if ('error' in entry) throw entry.error;
			const { file, reminders, cacheWrite, snapshot, changed } = entry;
			if (reminders.some(reminder => duplicates.has(reminder.id))) throw new ReminderIdentityConflictError();
			const ids = new Set<string>();
			const next: ProjectionSnapshot = {};
			const operations: NotificationOperation[] = [];
			const planned = new Map<string, { due: string; firstSeenAt: number | null }>();
			for (const reminder of reminders) {
				if (ids.has(reminder.id)) throw new PermanentReminderSourceError(DUPLICATE_COMMITTED_REMINDER_ISSUE);
				ids.add(reminder.id);
				const known = snapshot?.[reminder.id];
				if (!changed.has(reminder.id)) { next[reminder.id] = known!; continue; }
				let operation = changed.get(reminder.id) ?? null, firstSeenAt = known?.[1] ?? null;
				if (!operation) {
					const source = observed.get(`${job.path}\n${reminder.id}`);
					if (!source || source.due_key !== dueKey(reminder)) throw new Error('Reminder source changed before projection');
					firstSeenAt = source.first_seen_at;
					operation = operationFor(reminder, firstSeenAt);
				}
				planned.set(reminder.id, { due: dueKey(reminder), firstSeenAt });
				operations.push(operation);
			}
			const token = crypto.randomUUID();
			const current = existing ?? await readExistingNotifications(env.DB, operations.map(operation => operation.id), snapshot ? [] : [job.path]);
			const plan = planNotificationOperations(current, operations, token);
			// Only a schedule creates a row. An existing row is rewritten when it names another
			// file or its token changes, so a reminder that loses its date clears its schedule.
			const writes = plan.filter(operation => {
				const row = current.get(operation.id);
				return row?.present ? row.filePath !== job.path || row.token !== operation.token : operation.operation === 'schedule';
			});
			const keys = await Promise.all(plan.map(async operation => operation.payload ? schedulePayloadKey(operation.payload)
				: current.get(operation.id)?.present ? '' : null));
			plan.forEach((operation, index) => {
				const { due, firstSeenAt } = planned.get(operation.id)!;
				next[operation.id] = [due, firstSeenAt, keys[index]!];
			});
			const snapshotText = JSON.stringify(Object.fromEntries(Object.entries(next).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
			const projections = writes.length ? operationChunks(writes) : [];
			const fileGuard = file ? fileRevisionGuard(job.path, file.storageKey)
				: { sql: `NOT EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH})`, args: filePathArgs(job.path) };
			const guard = `EXISTS (SELECT 1 FROM notification_projection_jobs WHERE path = ? AND job_token = ?)
        AND EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)
        AND ${fileGuard.sql} `;
			const args = [job.path, job.job_token, policy.revision, ...fileGuard.args];
			// Only changed rows are written, and each carries its schedule, so no separate
			// command reaches the dispatcher. Delivery authority comes from the file's verified
			// source state and the absence of a pending projection job, which this transaction
			// removes. Every policy change queues a job for each projected file, so rows carry
			// no policy revision. Reminders that left this file come from its snapshot or the
			// pass's read: only this job's commit adds rows for its path.
			const departed = snapshot ? entry.departed.some(id => snapshot[id]![2] !== null)
				: projectedIds(current, job.path).some(id => !ids.has(id));
			const departedIds = JSON.stringify([...ids]);
			// The same occurrence keeps its delivery progress: retry time, recipients and failure.
			// A new one starts fresh, unless it is the occurrence already delivered.
			const same = 'excluded.due_datetime IS reminder_projections.due_datetime';
			await env.DB.batch([
				// A departed reminder keeps its delivered occurrence, so moving it to another note
				// cannot notify again. Departures also remove detached rows past the delivery window.
				...(departed ? [env.DB.prepare(`DELETE FROM reminder_projections WHERE file_path IS NULL
          AND unixepoch(delivered_due) * 1000 < ? AND ${guard}`).bind(Date.now() - NOTIFICATION_DELIVERY_WINDOW_MS, ...args),
				env.DB.prepare(`UPDATE reminder_projections SET file_path = NULL, notification_token = NULL,
          due_datetime = NULL, content = NULL, project = NULL, due_at = NULL, attempts = 0,
          pending_subscriptions = NULL, delivery_failed_at = NULL
          WHERE file_path = ? AND reminder_id NOT IN (SELECT value FROM json_each(?)) AND delivered_due IS NOT NULL AND ${guard}`)
					.bind(job.path, departedIds, ...args),
				env.DB.prepare(`DELETE FROM reminder_projections WHERE file_path = ?
          AND reminder_id NOT IN (SELECT value FROM json_each(?)) AND ${guard}`).bind(job.path, departedIds, ...args)] : []),
				...projections.map(json => env.DB.prepare(`INSERT INTO reminder_projections
          (reminder_id, file_path, notification_token, due_datetime, content, project, due_at)
          SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.token'), json_extract(value, '$.payload.dueDatetime'),
            json_extract(value, '$.payload.content'), json_extract(value, '$.payload.project'), json_extract(value, '$.dueAt')
          FROM json_each(?) WHERE ${guard}
          ON CONFLICT(reminder_id) DO UPDATE SET file_path = excluded.file_path, notification_token = excluded.notification_token,
            due_datetime = excluded.due_datetime, content = excluded.content, project = excluded.project,
            due_at = CASE WHEN excluded.due_datetime IS NULL THEN NULL WHEN ${same} THEN reminder_projections.due_at
              WHEN excluded.due_datetime IS reminder_projections.delivered_due THEN NULL ELSE excluded.due_at END,
            attempts = CASE WHEN ${same} THEN reminder_projections.attempts ELSE 0 END,
            pending_subscriptions = CASE WHEN ${same} THEN reminder_projections.pending_subscriptions END,
            delivery_failed_at = CASE WHEN ${same} THEN reminder_projections.delivery_failed_at END
          WHERE reminder_projections.file_path IS NOT excluded.file_path
            OR reminder_projections.notification_token IS NOT excluded.notification_token`)
					.bind(job.path, json, ...args)),
				// The snapshot commits with the rows it describes, under the same guard.
				...(snapshotText !== sourceStates.get(job.path)?.projection_snapshot ? [env.DB.prepare(`UPDATE reminder_source_state
          SET projection_snapshot = ? WHERE file_path = ? AND ${guard}`).bind(snapshotText, job.path, ...args)] : []),
				env.DB.prepare(`DELETE FROM notification_file_retries WHERE path = ? AND ${guard}`).bind(job.path, ...args),
				env.DB.prepare(`DELETE FROM notification_projection_jobs WHERE path = ? AND ${guard}`).bind(job.path, ...args),
				...(cacheWrite ? [cacheWrite] : []),
			]);
			if (writes.some(operation => operation.operation === 'schedule')) scheduled = true;
		} catch (error) {
			const message = error instanceof Error ? error.message.slice(0, 512) : 'Projection failed';
			await env.DB.batch([
				env.DB.prepare("UPDATE notification_projection_jobs SET last_error = ?, updated_at = datetime('now') WHERE path = ? AND job_token = ?")
					.bind(message, job.path, job.job_token),
				recordFileFailure(env.DB, job.path, message, 'EXISTS (SELECT 1 FROM notification_projection_jobs WHERE path = ? AND job_token = ?)', [job.path, job.job_token], isPermanentSourceError(error)),
			]);
		}
	}
	return scheduled;
}
