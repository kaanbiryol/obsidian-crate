import { corsHeaders, corsResponse } from '../../http/cors';
import { listStoredMarkdownFileMetadataByPaths, listStoredMarkdownFileMetadataByPrefix } from '../../sync/markdown-files';
import type { Env } from '../../types';
import { parseFolderPath } from '../requests';
import {
	loadIncrementalReminderIndex,
	loadReminderDelta,
	REMINDER_CACHE_PARSER_VERSION,
	reminderProjects,
} from '../cache/index';
import { loadReminderFileCache } from '../cache/load';
import { REMINDER_INDEX_WARM_MAX_FILES } from '../cache/types';
import { continueReminderIndexWarm, readReminderWarmCursor, saveReminderWarmCursor } from '../cache/warm-cursor';
import { storedReminderRevision } from '../cache/revisions';
import type { RemoteReminderRecord } from '../types';
import { reminderCommandPayload } from '@/reminders/core/reminderFileCommand';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import { changedPathsSince, changeEtag, deltaBase, parseChangeEtags, parseDeltaBase, readVaultChangeState, vaultChangeToken } from '../../sync/change-token';
import { sha256Hex } from '../../../../platform/sha256';
import { isReminderNotePath } from '../../../../protocol/reminder-archive-path';
import { compareCodePoints } from '@/protocol/portable-path';
import { MAX_DELTA_CONFLICT_NOTES, REMINDER_IDENTITY_CONFLICT_ISSUE } from '@/reminders/core/reminder-list';

// Cached rows usually hold each revision, which saves hashing every listed reminder.
const payload = (reminder: RemoteReminderRecord) => reminderCommandPayload(reminder, storedReminderRevision(reminder));

export async function handleListReminders(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const folderPath = parseFolderPath(url.searchParams.get('folderPath'));
	if (!folderPath) {
		return corsResponse({ error: 'folderPath required' }, 400);
	}

	// ETags pair a vault change token with the folder's content revision. An
	// unchanged token proves no file changed anywhere, so idle polls skip the
	// folder scan; otherwise an unchanged folder still answers 304.
	const requestEtags = request.headers.get('If-None-Match')
		?.split(',')
		.map(value => value.trim()) ?? [];
	// Read the vault position before listing: a write after this point is
	// replayed by the next delta even if this response already includes it.
	const scope = `parser:${REMINDER_CACHE_PARSER_VERSION}\nfolder:${folderPath}`;
	const state = await readVaultChangeState(env.DB);
	const changeToken = await vaultChangeToken(env.DB, scope, state);
	const base = await deltaBase(scope, state);
	// An unchanged revision advances its delta base too.
	const notModified = (etag: string) => new Response(null, {
		status: 304,
		headers: { ...corsHeaders(), 'Cache-Control': 'private, no-cache', ETag: etag, [DELTA_BASE_HEADER]: base },
	});
	const cached = requestEtags.map(value => parseChangeEtags(value)[0]);
	const unchanged = cached.findIndex(value => value?.changeToken === changeToken);
	if (unchanged >= 0) return notModified(requestEtags[unchanged]!);

	// The notes the client's base lists with a duplicate identity. Another note's change can
	// resolve their duplicate, so a delta re-reads them; with more, the client asks in full.
	const conflicts = url.searchParams.getAll('conflict');
	const named = conflicts.length <= MAX_DELTA_CONFLICT_NOTES && conflicts.every(path => isReminderNotePath(path, folderPath));
	const since = named ? parseDeltaBase(url.searchParams.get('since')) : null;
	const sinceSeq = since && since.scope === base.slice(base.indexOf('.') + 1) ? since.seq : null;
	// The change state already read the changelog bounds, so this is one more query.
	const changedPaths = sinceSeq === null ? null
		: (await changedPathsSince(env.DB, folderPath, sinceSeq, state.bounds))?.filter(path => isReminderNotePath(path, folderPath)) ?? null;
	// Other vault writes changed the token. An ETag issued at the client's delta
	// base still holds when no folder path changed since, so skip the listing.
	if (sinceSeq !== null) {
		const issuedAtBase = await vaultChangeToken(env.DB, scope, { ...state, seq: sinceSeq });
		const current = cached.find(value => value?.changeToken === issuedAtBase);
		if (current && changedPaths?.length === 0) return notModified(changeEtag(changeToken, current.revision));
	}
	const deltaPaths = changedPaths && [...new Set([...changedPaths, ...conflicts])];

	const warmingResponse = (remainingFiles: number, totalFiles: number) => corsResponse({ warming: true, remainingFiles, totalFiles }, 202, {
		'Cache-Control': 'private, no-store',
		'Retry-After': '1',
	});
	// A folder still warming resumes after the last indexed note, without listing the folder.
	const warmCursor = requestEtags.includes('*') ? null : await readReminderWarmCursor(env.DB, folderPath);
	if (warmCursor) {
		const progress = await continueReminderIndexWarm(env, folderPath, warmCursor);
		return warmingResponse(progress.remainingFiles, progress.totalFiles);
	}

	// Cache rows do not depend on the folder listing, so read them alongside it: the
	// delta's notes, or every note when no conditional answer is possible.
	const changedCache = deltaPaths ? loadReminderFileCache(env.DB, folderPath, deltaPaths) : undefined;
	const folderCache = !deltaPaths && requestEtags.length === 0 ? loadReminderFileCache(env.DB, folderPath) : undefined;
	// Their failures are handled where they are awaited.
	changedCache?.catch(() => undefined);
	folderCache?.catch(() => undefined);
	const headers = { 'Cache-Control': 'private, no-cache' };

	// A delta comes from the rows of its notes and of the notes sharing their identities
	// alone, so its cost follows the changes rather than the folder's size. One note is one
	// project, so the projects of the listed notes that still exist are all the client needs
	// to update its list.
	if (deltaPaths && !requestEtags.includes('*')) {
		const files = await listStoredMarkdownFileMetadataByPaths(env.DB, deltaPaths);
		const delta = await loadReminderDelta(env, folderPath, files, changedCache);
		if (delta) {
			// The folder's content revision needs the whole listing. This one never equals a
			// content revision, so a later full read that sends it is answered in full.
			const revision = (await sha256Hex(`delta:${changeToken}`)).slice(0, 32);
			return corsResponse({
				delta: true,
				changedPaths: [...new Set([...deltaPaths, ...delta.files.map(file => file.path)])].sort(compareCodePoints),
				reminders: await Promise.all(delta.reminders.map(payload)),
				changedProjects: reminderProjects(delta.files, folderPath),
				issues: delta.issues,
			}, 200, { ...headers, ETag: changeEtag(changeToken, revision), [DELTA_BASE_HEADER]: base });
		}
	}
	// Archived reminders are kept out of the index, its cache and the revision.
	const metadata = (await listStoredMarkdownFileMetadataByPrefix(env.DB, folderPath)).filter(file => isReminderNotePath(file.path, folderPath));
	const revision = (await sha256Hex([
		`parser:${REMINDER_CACHE_PARSER_VERSION}`,
		...metadata.map((file) => `${file.path}\0${file.hash}\0${file.size}`),
	].join('\n'))).slice(0, 32);
	const etag = changeEtag(changeToken, revision);
	if (requestEtags.includes('*')) return notModified(etag);
	// Issues follow from the folder's files and parser alone, so an equal revision is unchanged.
	if (cached.some(value => value?.revision === revision)) return notModified(etag);
	const workspace = await loadIncrementalReminderIndex(env, folderPath, metadata, folderCache);
	if (!workspace.ready) {
		// Beyond one more batch, later requests warm from a cursor instead of listing the
		// folder each time. Notes this request indexed are skipped there.
		if (workspace.remainingFiles > REMINDER_INDEX_WARM_MAX_FILES) {
			await saveReminderWarmCursor(env.DB, folderPath, { after: '', remaining: workspace.remainingFiles, total: metadata.length }).catch(() => {});
		}
		return warmingResponse(workspace.remainingFiles, metadata.length);
	}
	const fullHeaders = { ...headers, ETag: etag, [DELTA_BASE_HEADER]: base };
	// Duplicates can appear or remain in unchanged notes, which then list a conflict, and
	// resolve in the notes the client named; every other unchanged note is as it was.
	if (deltaPaths) {
		const paths = new Set([...deltaPaths, ...workspace.issues.filter(issue => issue.reason === REMINDER_IDENTITY_CONFLICT_ISSUE).map(issue => issue.path)]);
		return corsResponse({
			delta: true,
			changedPaths: [...paths].sort(compareCodePoints),
			reminders: await Promise.all(workspace.reminders.filter(reminder => paths.has(reminder.filePath)).map(payload)),
			changedProjects: reminderProjects(metadata.filter(file => paths.has(file.path)), folderPath),
			issues: workspace.issues.filter(issue => paths.has(issue.path)),
		}, 200, fullHeaders);
	}
	return corsResponse({
		reminders: await Promise.all(workspace.reminders.map(payload)),
		projects: workspace.projects,
		issues: workspace.issues,
	}, 200, fullHeaders);
}

