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

export async function handleListReminders(request: Request, env: Env): Promise<Response> {
	const folderPath = parseFolderPath(new URL(request.url).searchParams.get('folderPath'));
	if (!folderPath) {
		return corsResponse({ error: 'folderPath required' }, 400);
	}

	const metadata = await listStoredMarkdownFileMetadataByPrefix(env.DB, folderPath);
	const revision = await sha256Hex([
		`parser:${REMINDER_CACHE_PARSER_VERSION}`,
		...metadata.map((file) => `${file.path}\0${file.hash}\0${file.size}`),
	].join('\n'));
	const etag = `"${revision}"`;
	const requestEtags = request.headers.get('If-None-Match')
		?.split(',')
		.map(value => value.trim()) ?? [];
	if (requestEtags.includes('*') || requestEtags.includes(etag)) {
		return new Response(null, {
			status: 304,
			headers: {
				...corsHeaders(),
				'Cache-Control': 'private, no-cache',
				ETag: etag,
			},
		});
	}

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
	return corsResponse({
		reminders: await Promise.all(workspace.reminders.map(reminder => toReminderPayload(reminder))),
		projects: workspace.projects,
		issues: workspace.issues,
	}, 200, {
		'Cache-Control': 'private, no-cache',
		...(workspace.issues.length === 0 ? { ETag: etag } : {}),
	});
}
