import { issueShortcutPairing, exchangeShortcutPairing } from './shortcut-pairing';
import { armNotificationCoordinator } from '../notification-lifecycle';
import { limitNotificationAction } from '../rate-limit';
import type { Env } from '../types';
import type { AuthPrincipal } from '../authenticate';
import { parseJsonObject } from '../utils';
import { policy, authority, readingResponse, ReadingError, sourceById } from './common';
import { issueReadingAccess, prepareHandoff, updatePolicy, exchangeReadingAccess, handoffAuthority } from './access';
import { mutateReading } from './mutations';
import { projectReading } from './projection';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';

export async function handleReadingRoute(request: Request, env: Env, principal?: AuthPrincipal, state?: DurableObjectState): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    const parsed = request.method === 'GET' ? { ok: true as const, value: {} } : await parseJsonObject(request, 24_576);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (path === '/reading/shortcut-exchange' && request.method === 'POST') return await exchangeShortcutPairing(env.DB, body, request);
    if (path === '/reading/exchange' && request.method === 'POST') return await exchangeReadingAccess(env.DB, body, request);
    if (path === '/reading/handoff' && request.method === 'POST') {
      const handoff = await handoffAuthority(env.DB, request);
      const limited = await limitNotificationAction(request, env.DB, handoff.principal.tokenId); if (limited) return limited;
      if (state) await armNotificationCoordinator(state);
      return await mutateReading(env, handoff.principal, handoff.current, handoff.body, 'capture');
    }
    if (!principal) throw new ReadingError('Reading access is required.', 401);
    const limited = await limitNotificationAction(request, env.DB, principal.tokenId); if (limited) return limited;
    if (path === '/reading/policy') {
      if (principal.scope !== 'vault') throw new ReadingError('Open Crate settings in Obsidian to change Reading setup.', 403);
      if (request.method === 'GET') return readingResponse({ policy: await policy(env.DB) });
      if (request.method === 'POST') return await updatePolicy(env.DB, body);
    }
    const current = await authority(env.DB, principal);
    if (path === '/reading/shortcut-pairing' && request.method === 'POST') return await issueShortcutPairing(env.DB, principal, current, url.origin);
    if (path === '/reading/access' && request.method === 'POST' && principal.scope === 'vault') return await issueReadingAccess(env.DB, current, body, url.origin);
    if (path === '/reading/prepare' && request.method === 'POST') return await prepareHandoff(env.DB, principal, body, url.origin);
    if (path === '/reading/capture' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'capture');
    if (principal.scope === 'reading_capture') throw new ReadingError('This credential can only save links.', 403);
    if (path === '/reading/session' && request.method === 'GET') return readingResponse({ folderPath: current.folder_path, generation: current.generation, day: Math.floor(Date.now() / 86400_000) });
    if (path === '/reading/update' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'update');
    if (path === '/reading/retry' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'retry');
    if (!await projectReading(env, current)) throw new ReadingError('Your Reading library is being indexed. Try refreshing shortly.', 503);
    if (path === '/reading/item' && request.method === 'GET') {
      const source = await sourceById(env, current, url.searchParams.get('id'));
      return readingResponse({ item: { ...source.item, path: source.path }, markdown: readReadingFrontmatter(source.content)?.body ?? '' });
    }
    if (path === '/reading/list' && request.method === 'GET') {
      const cursor = url.searchParams.get('cursor') ?? '';
      if (cursor.length > 4096) throw new ReadingError('Invalid library cursor.');
      const { results } = await env.DB.prepare(`SELECT s.path, s.metadata_json, s.error,
        (SELECT count(*) FROM reading_sources d JOIN files df ON df.path=d.path AND df.storage_key=d.revision WHERE d.item_id=s.item_id AND d.generation=s.generation) AS copies
        FROM reading_sources s JOIN files f ON f.path=s.path AND f.storage_key=s.revision
        WHERE s.generation=? AND s.path>? AND (s.item_id IS NOT NULL OR s.error IS NOT NULL) ORDER BY s.path LIMIT 100`)
        .bind(current.generation, cursor).all<{ path: string; metadata_json: string | null; error: string | null; copies: number }>();
      return readingResponse({ items: results.filter(row => row.metadata_json && row.copies === 1).map(row => ({ ...(JSON.parse(row.metadata_json!) as Record<string, unknown>), path: row.path })),
        issues: results.filter(row => row.error || row.copies > 1).map(row => ({ path: row.path, message: row.error ?? 'Several notes have this Reading ID. Fix the duplicates in Obsidian.' })),
        cursor: results.length === 100 ? results.at(-1)!.path : null });
    }
    return readingResponse({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ReadingError) return readingResponse({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
