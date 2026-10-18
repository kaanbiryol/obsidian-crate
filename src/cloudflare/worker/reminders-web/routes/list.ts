import { sha256Hex } from '../../auth';
import { corsHeaders, corsResponse } from '../../cors';
import { listStoredMarkdownFileMetadataByPrefix } from '../../storage';
import type { Env } from '../../types';
import { parseFolderPath } from '../requests';
import {
	loadIncrementalReminderIndex,
	REMINDER_CACHE_PARSER_VERSION,
} from '../reminder-cache';
import { toReminderPayload } from '../scan';
import { changedPathsSince, deltaBase, parseChangeEtags, parseDeltaBase, readVaultChangeState, vaultChangeToken } from '../../vault-change-token';

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
	// An ETag is only issued for a complete revision, so an unchanged one can
	// advance its delta base too.
	const notModified = (etag: string) => new Response(null, {
		status: 304,
		headers: { ...corsHeaders(), 'Cache-Control': 'private, no-cache', ETag: etag, 'X-Crate-Delta-Base': base },
	});
	const cached = requestEtags.map(value => parseChangeEtags(value)[0]);
	const unchanged = requestEtags.find((_, index) => cached[index]?.changeToken === changeToken);
	if (unchanged) return notModified(unchanged);

	const since = parseDeltaBase(url.searchParams.get('since'));
	const sinceSeq = since && since.scope === base.slice(base.indexOf('.') + 1) ? since.seq : null;
	let changedSinceBase: Promise<string[] | null> | undefined;
	const changed = () => changedSinceBase ??= sinceSeq === null ? Promise.resolve(null) : changedPathsSince(env.DB, folderPath, sinceSeq);
	// Other vault writes changed the token. An ETag issued at the client's delta
	// base still holds when no folder path changed since, so skip the listing.
	if (sinceSeq !== null) {
		const issuedAtBase = await vaultChangeToken(env.DB, scope, { ...state, seq: sinceSeq });
		const current = cached.find(value => value?.changeToken === issuedAtBase);
		if (current && (await changed())?.length === 0) return notModified(`"${changeToken}.${current.revision}"`);
	}

	const metadata = await listStoredMarkdownFileMetadataByPrefix(env.DB, folderPath);
	const revision = (await sha256Hex([
		`parser:${REMINDER_CACHE_PARSER_VERSION}`,
		...metadata.map((file) => `${file.path}\0${file.hash}\0${file.size}`),
	].join('\n'))).slice(0, 32);
	const etag = `"${changeToken}.${revision}"`;
	if (requestEtags.includes('*') || cached.some(value => value?.revision === revision)) return notModified(etag);

	const workspace = await loadIncrementalReminderIndex(env, folderPath, metadata);
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
	const headers = { 'Cache-Control': 'private, no-cache', ...(complete ? { ETag: etag, 'X-Crate-Delta-Base': base } : {}) };
	const changedPaths = complete ? await changed() : null;
	if (changedPaths) {
		const paths = new Set(changedPaths);
		return corsResponse({
			delta: true,
			changedPaths,
			reminders: await Promise.all(workspace.reminders.filter(reminder => paths.has(reminder.filePath)).map(reminder => toReminderPayload(reminder))),
			projects: workspace.projects,
			issues: [],
		}, 200, headers);
	}
	return corsResponse({
		reminders: await Promise.all(workspace.reminders.map(reminder => toReminderPayload(reminder))),
		projects: workspace.projects,
		issues: workspace.issues,
	}, 200, headers);
}

