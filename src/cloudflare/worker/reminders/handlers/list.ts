import { corsHeaders, corsResponse } from '../../http/cors';
import { listStoredMarkdownFileMetadataByPrefix } from '../../sync/markdown-files';
import type { Env } from '../../types';
import { parseFolderPath } from '../requests';
import {
	loadIncrementalReminderIndex,
	loadReminderDelta,
	REMINDER_CACHE_PARSER_VERSION,
} from '../cache/index';
import { loadReminderFileCache } from '../cache/load';
import { storedReminderRevision } from '../cache/revisions';
import type { RemoteReminderRecord } from '../types';
import { reminderCommandPayload } from '@/reminders/core/reminderFileCommand';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import { changedPathsSince, changeEtag, deltaBase, parseChangeEtags, parseDeltaBase, readVaultChangeState, vaultChangeToken } from '../../sync/change-token';
import { sha256Hex } from '../../../../platform/sha256';
import { isReminderNotePath } from '../../../../protocol/reminder-archive-path';

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
	// An unchanged complete revision advances its delta base too. A list with issues
	// has an ETag marked incomplete, which answers 304 but never gives a delta base.
	const notModified = (etag: string, complete: boolean) => new Response(null, {
		status: 304,
		headers: { ...corsHeaders(), 'Cache-Control': 'private, no-cache', ETag: etag, ...(complete ? { [DELTA_BASE_HEADER]: base } : {}) },
	});
	const cached = requestEtags.map(value => parseChangeEtags(value)[0]);
	const unchanged = cached.findIndex(value => value?.changeToken === changeToken);
	if (unchanged >= 0) return notModified(requestEtags[unchanged]!, !cached[unchanged]!.incomplete);

	const since = parseDeltaBase(url.searchParams.get('since'));
	const sinceSeq = since && since.scope === base.slice(base.indexOf('.') + 1) ? since.seq : null;
	// The change state already read the changelog bounds, so this is one more query.
	const changedPaths = sinceSeq === null ? null
		: (await changedPathsSince(env.DB, folderPath, sinceSeq, state.bounds))?.filter(path => isReminderNotePath(path, folderPath)) ?? null;
	// Other vault writes changed the token. An ETag issued at the client's delta
	// base still holds when no folder path changed since, so skip the listing.
	if (sinceSeq !== null) {
		const issuedAtBase = await vaultChangeToken(env.DB, scope, { ...state, seq: sinceSeq });
		const current = cached.find(value => value?.changeToken === issuedAtBase);
		if (current && changedPaths?.length === 0) return notModified(changeEtag(changeToken, current.revision, !current.incomplete), !current.incomplete);
	}

	// Cache rows do not depend on the folder listing, so read them alongside it: the
	// changed notes for a delta, or every note when no conditional answer is possible.
	const changedCache = changedPaths ? loadReminderFileCache(env.DB, folderPath, changedPaths) : undefined;
	const folderCache = !changedPaths && requestEtags.length === 0 ? loadReminderFileCache(env.DB, folderPath) : undefined;
	// Their failures are handled where they are awaited.
	changedCache?.catch(() => undefined);
	folderCache?.catch(() => undefined);
	// Archived reminders are kept out of the index, its cache and the revision.
	const metadata = (await listStoredMarkdownFileMetadataByPrefix(env.DB, folderPath)).filter(file => isReminderNotePath(file.path, folderPath));
	const revision = (await sha256Hex([
		`parser:${REMINDER_CACHE_PARSER_VERSION}`,
		...metadata.map((file) => `${file.path}\0${file.hash}\0${file.size}`),
	].join('\n'))).slice(0, 32);
	const etag = changeEtag(changeToken, revision, true);
	if (requestEtags.includes('*')) return notModified(etag, true);
	// Issues follow from the folder's files and parser alone, so an equal revision has
	// the completeness it had when it was issued.
	const same = cached.find(value => value?.revision === revision);
	if (same) return notModified(changeEtag(changeToken, revision, !same.incomplete), !same.incomplete);
	const headers = { 'Cache-Control': 'private, no-cache' };
	const delta = changedPaths && await loadReminderDelta(env, folderPath, metadata, changedPaths, changedCache);
	if (changedPaths && delta) {
		return corsResponse({
			delta: true,
			changedPaths,
			reminders: await Promise.all(delta.reminders.map(payload)),
			projects: delta.projects,
			issues: [],
		}, 200, { ...headers, ETag: etag, [DELTA_BASE_HEADER]: base });
	}

	const workspace = await loadIncrementalReminderIndex(env, folderPath, metadata, folderCache);
	if (!workspace.ready) {
		return corsResponse({
			warming: true,
			remainingFiles: workspace.remainingFiles,
			totalFiles: metadata.length,
		}, 202, {
			'Cache-Control': 'private, no-store',
			'Retry-After': '1',
		});
	}
	// A complete, issue-free revision can be the base of a later delta. Issues
	// include duplicate identities, whose visibility can change in unchanged notes.
	const complete = workspace.issues.length === 0;
	const fullHeaders = { ...headers, ...(complete ? { ETag: etag, [DELTA_BASE_HEADER]: base } : { ETag: changeEtag(changeToken, revision, false) }) };
	if (complete && changedPaths) {
		const paths = new Set(changedPaths);
		return corsResponse({
			delta: true,
			changedPaths,
			reminders: await Promise.all(workspace.reminders.filter(reminder => paths.has(reminder.filePath)).map(payload)),
			projects: workspace.projects,
			issues: [],
		}, 200, fullHeaders);
	}
	return corsResponse({
		reminders: await Promise.all(workspace.reminders.map(payload)),
		projects: workspace.projects,
		issues: workspace.issues,
	}, 200, fullHeaders);
}

