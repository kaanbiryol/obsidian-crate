import { featureEnabled } from '../server/feature-policy';
import type { FeaturePolicy } from '../../../protocol/feature-policy';
import { NOTIFICATION_DELIVERY_WINDOW_MS, planNotificationOperations, readExistingNotifications, type NotificationOperation } from './projection-plan';
import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from '../sync/file-identity';
import { recordFileFailure } from './file-retries';
import { READY_PROJECTION_JOBS_SQL } from './queue';
import { parseDateTime, toZoned } from '@internationalized/date';
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

export function notificationDatetime(reminder: Pick<RemoteReminderRecord, 'dueDate' | 'dueDatetime'>, policy: NotificationPolicy): string | undefined {
	if (reminder.dueDatetime) return reminder.dueDatetime;
	if (!reminder.dueDate || !policy.allDayTime) return undefined;
	return toZoned(parseDateTime(`${reminder.dueDate}T${policy.allDayTime}`), policy.timezone).toDate().toISOString();
}

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
	// Read every job's file, verification, source and projection rows once. Projection
	// commits write only the projection rows, which are used to detect shared reminders
	// below; a change to any other row replaces the job token each commit checks.
	const paths = JSON.stringify(jobs.map(job => job.path));
	const [files, states, sourceRows, projectedRows] = await Promise.all([
		loadStoredFileRows(env.DB, jobs.map(job => job.path)),
		queryRows<{ file_path: string; file_revision: string; verified: number }>(env.DB.prepare(`SELECT file_path, file_revision, verified FROM reminder_source_state
      WHERE file_path IN (SELECT value FROM json_each(?)) AND parser_version = ?`).bind(paths, REMINDER_CACHE_PARSER_VERSION)),
		queryRows<{ file_path: string; reminder_id: string; due_key: string; first_seen_at: number | null }>(env.DB.prepare(
			`SELECT s.file_path, s.reminder_id, s.due_key, o.first_seen_at FROM reminder_sources s
        LEFT JOIN reminder_occurrences o ON o.reminder_id = s.reminder_id AND o.due_key = s.due_key
        WHERE s.file_path IN (SELECT value FROM json_each(?))`).bind(paths)),
		queryRows<{ file_path: string; reminder_id: string }>(env.DB.prepare(
			'SELECT file_path, reminder_id FROM reminder_projections WHERE file_path IN (SELECT value FROM json_each(?))').bind(paths)),
	]);
	const sourceStates = new Map(states.map(row => [row.file_path, row]));
	// Parsing shares verification's byte budget; later jobs wait for the next pass.
	const sourceLimit = reminderSourceByteLimit(encrypted), budget = reparseByteBudget(encrypted);
	let bytes = 0, admitted = 0;
	for (const job of jobs) {
		const size = files.get(job.path)?.size ?? 0;
		const readable = size <= sourceLimit ? size : 0;
		if (bytes + readable > budget) break;
		bytes += readable; admitted++;
	}
	// Parse every admitted job first, so the reads below serve the whole pass.
	type Parsed = { job: typeof jobs[number]; file: FileStorageRow | null; reminders: RemoteReminderRecord[]; cacheWrite: D1PreparedStatement | null } | { job: typeof jobs[number]; error: unknown };
	const parsed = await Promise.all(jobs.slice(0, admitted).map(async (job): Promise<Parsed> => {
		try {
			const file = files.get(job.path) ?? null;
			let reminders: RemoteReminderRecord[] = [];
			// The web app's list reuses this parse instead of reading the note again.
			let cacheWrite: D1PreparedStatement | null = null;
			if (file && isReminderPath(job.path, policy.folderPath)) {
				if (file.size > sourceLimit) throw new PermanentReminderSourceError(REMINDER_SOURCE_SIZE_ISSUE);
				// A revision this parser has not checked waits for verification, which reads it.
				// One it checked and rejected is still parsed, so a retry reports the same issue.
				const state = sourceStates.get(job.path);
				if (state?.file_revision !== file.storageKey) throw new Error(AWAITING_VERIFICATION);
				const reused = loaded?.verified?.get(job.path);
				const [text] = reused?.storageKey === file.storageKey ? [reused] : await readStoredMarkdownFiles(env.BUCKET, [{ path: job.path, ...file }]);
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
			return { job, file, reminders, cacheWrite };
		} catch (error) { return { job, error }; }
	}));
	const ids = [...new Set(parsed.flatMap(entry => 'reminders' in entry ? entry.reminders.map(reminder => reminder.id) : []))];
	// A commit rewrites notification state only for its own reminders and those its file
	// projected before, so one read serves every job unless two jobs touch the same one,
	// as when a reminder moves between notes. Those jobs read after each earlier commit.
	const touched = parsed.flatMap(entry => [...new Set([
		...('reminders' in entry ? entry.reminders.map(reminder => reminder.id) : []),
		...projectedRows.filter(row => row.file_path === entry.job.path).map(row => row.reminder_id),
	])]);
	const [duplicates, existing] = await Promise.all([
		duplicateReminderIds(env.DB, policy.folderPath, ids),
		new Set(touched).size === touched.length ? readExistingNotifications(env.DB, ids) : null,
	]);
	let scheduled = false;
	for (const entry of parsed) {
		const { job } = entry;
		try {
			if ('error' in entry) throw entry.error;
			const { file, reminders, cacheWrite } = entry;
			if (reminders.some(reminder => duplicates.has(reminder.id))) throw new ReminderIdentityConflictError();
			const observed = new Map(sourceRows.filter(row => row.file_path === job.path).map(row => [row.reminder_id, row]));
			const ids = new Set<string>();
			const operations = reminders.map<NotificationOperation>(reminder => {
				if (ids.has(reminder.id)) throw new PermanentReminderSourceError(DUPLICATE_COMMITTED_REMINDER_ISSUE);
				ids.add(reminder.id);
				const dueDatetime = notificationDatetime(reminder, policy);
				const source = observed.get(reminder.id);
				if (!source || source.due_key !== (reminder.dueDatetime ?? reminder.dueDate ?? '')) throw new Error('Reminder source changed before projection');
				const schedule = policy.enabled !== false && !reminder.completed && dueDatetime
					&& source.first_seen_at !== null && source.first_seen_at <= Date.parse(dueDatetime);
				return schedule ? { id: reminder.id, operation: 'schedule', payload: {
					reminderId: reminder.id, content: reminder.content, project: reminder.project, dueDatetime,
				} } : { id: reminder.id, operation: 'cancel', payload: null };
			});
			const token = crypto.randomUUID();
			const current = existing ?? await readExistingNotifications(env.DB, operations.map(operation => operation.id));
			const plan = planNotificationOperations(current, operations, token);
			// A projection row already naming this file and token needs no upsert. When jobs of
			// this pass share reminders, `projectedRows` may be stale, so every row is upserted.
			const projected = new Set(existing ? projectedRows.filter(row => row.file_path === job.path).map(row => row.reminder_id) : []);
			const reprojected = plan.filter(entry => !projected.has(entry.id) || current.get(entry.id)?.token !== entry.token);
			const projections = reprojected.length ? operationChunks(reprojected) : [];
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
			// no policy revision. Reminders that left this file come from the pass's read:
			// only this job's commit adds rows for its path, so an empty read means none left.
			const departed = projectedRows.some(row => row.file_path === job.path && !ids.has(row.reminder_id));
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
          pending_subscriptions = NULL, delivery_failed_at = NULL, last_error = NULL
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
            delivery_failed_at = CASE WHEN ${same} THEN reminder_projections.delivery_failed_at END,
            last_error = CASE WHEN ${same} THEN reminder_projections.last_error END
          WHERE reminder_projections.file_path IS NOT excluded.file_path
            OR reminder_projections.notification_token IS NOT excluded.notification_token`)
					.bind(job.path, json, ...args)),
				env.DB.prepare(`DELETE FROM notification_file_retries WHERE path = ? AND ${guard}`).bind(job.path, ...args),
				env.DB.prepare(`DELETE FROM notification_projection_jobs WHERE path = ? AND ${guard}`).bind(job.path, ...args),
				...(cacheWrite ? [cacheWrite] : []),
			]);
			if (reprojected.some(entry => entry.operation === 'schedule')) scheduled = true;
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
