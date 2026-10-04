import { readEncryptedReceipt } from '../encrypted-receipt-storage';
import { readEncryptionState } from '../encryption-state';
import { handleEncryptedReminders } from '../encrypted-reminders';
import { issueShortcutPairing, exchangeShortcutPairing } from './shortcut-pairing';
import { shortcutTransport, validateShortcutBody } from './shortcut-transport';
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
import { parseReadingNote } from '@/reading/core/notes';
import { validateReadingMetadata } from '@/reading/core/model';

export async function handleReadingRoute(request: Request, env: Env, principal?: AuthPrincipal, state?: DurableObjectState): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    const encryption = await readEncryptionState(env.DB);
    const shortcut = shortcutTransport(request);
    if (path.startsWith('/reading/encrypted-')) {
      if (!principal || principal.scope === 'reading_capture') throw new ReadingError('Library access is required.', 403);
      const current = await authority(env.DB, principal);
      const limited = await limitNotificationAction(request, env.DB, principal.tokenId); if (limited) return limited;
      if (path === '/reading/encrypted-receipt' && request.method === 'GET') {
        const id = url.searchParams.get('operationId') ?? '';
        const wire = url.searchParams.get('wire') === '1';
        const row = await (wire ? env.DB.prepare('SELECT response_json FROM reminder_operations WHERE operation_id=?').bind(id)
          : env.DB.prepare('SELECT response_json FROM reading_operations WHERE operation_id=? AND generation=?').bind(id, current.generation)).first<{ response_json: string }>();
        const legacy = row ? (await readEncryptedReceipt(env.DB, wire ? 'reminder' : 'reading', id, row.response_json) as { e2eeLegacy?: { scopes: Array<{ id: string; envelope: string }> } }).e2eeLegacy : undefined;
        const scope = encryption?.scopes.find(scope => scope.folderPath === current.folder_path);
        return readingResponse({ envelope: legacy?.scopes.find(item => item.id === scope?.id)?.envelope ?? null });
      }
      return await handleEncryptedReminders(request, env, path, '/reading', current.folder_path) ?? readingResponse({ error: 'Not found' }, 404);
    }
    if (encryption && (shortcut?.kind === 'prepare' || ['/reading/prepare', '/reading/handoff', '/reading/capture', '/reading/update', '/reading/retry', '/reading/list', '/reading/item'].includes(path))) throw new ReadingError('Use an unlocked, updated Reading app for this encrypted vault.', 428);
    if (path === '/reading/encryption' && request.method === 'GET' && principal) {
      const current = await authority(env.DB, principal);
      return readingResponse({ encryption: encryption ? { version: encryption.version, vaultId: encryption.vaultId, generation: encryption.generation, mode: encryption.mode, recovery: encryption.recovery, scope: encryption.scopes.find(scope => scope.folderPath === current.folder_path) ?? null } : null });
    }
    const parsed = request.method === 'GET' ? { ok: true as const, value: {} } : await parseJsonObject(request, path === '/reading/update' ? 262_144 : 24_576);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (shortcut) validateShortcutBody(body, shortcut.kind);
    if (shortcut?.kind === 'exchange') return await exchangeShortcutPairing(env.DB, body, request);
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
    if (path === '/reading/fetching' && principal.scope !== 'reading_capture') {
      if (request.method === 'GET') return readingResponse({ enabled: Boolean(current.enabled), revision: current.revision });
      if (request.method === 'POST') {
        if (typeof body.enabled !== 'boolean') throw new ReadingError('Choose whether to fetch articles.');
        await updatePolicy(env.DB, { enabled: body.enabled, folderPath: current.folder_path, revision: body.revision });
        const updated = await policy(env.DB);
        return readingResponse({ enabled: Boolean(updated?.enabled), revision: updated?.revision });
      }
    }
    if (path === '/reading/shortcut-pairing' && request.method === 'POST') return await issueShortcutPairing(env.DB, principal, current, url.origin);
    if (path === '/reading/access' && request.method === 'POST' && principal.scope === 'vault') return await issueReadingAccess(env.DB, current, body, url.origin);
    if ((path === '/reading/prepare' || shortcut?.kind === 'prepare') && request.method === 'POST') return await prepareHandoff(env.DB, principal, body, url.origin);
    if (path === '/reading/capture' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'capture');
    if (principal.scope === 'reading_capture') throw new ReadingError('This credential can only save links.', 403);
    if (path === '/reading/session' && request.method === 'GET') return readingResponse({ id: principal.tokenId, folderPath: current.folder_path, generation: current.generation, expiresAt: principal.expiresAt ?? null, day: Math.floor(Date.now() / 86400_000) });
    if (path === '/reading/update' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'update');
    if (path === '/reading/retry' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'retry');
    if (await projectReading(env, current) !== 'complete') throw new ReadingError('Your Reading library is not fully available yet. Try refreshing shortly.', 503);
    if (path === '/reading/item' && request.method === 'GET') {
      const queued = await env.DB.prepare('SELECT note FROM reading_captures WHERE id=? AND generation=?').bind(url.searchParams.get('id'), current.generation).first<{ note: string }>();
      if (queued) return readingResponse({ item: { ...parseReadingNote(queued.note)!, path: '' }, markdown: '' });
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
      const queued = cursor ? [] : (await env.DB.prepare('SELECT note FROM reading_captures WHERE generation=? ORDER BY available_at LIMIT 1000').bind(current.generation).all<{ note: string }>()).results;
      return readingResponse({ items: [...queued.map(row => ({ ...parseReadingNote(row.note)!, path: '' })), ...results.filter(row => row.metadata_json && row.copies === 1).map(row => ({ ...validateReadingMetadata(JSON.parse(row.metadata_json!) as Record<string, unknown>), path: row.path }))],
        issues: results.filter(row => row.error || row.copies > 1).map(row => ({ path: row.path, message: row.error ?? 'Several notes have this Reading ID. Fix the duplicates in Obsidian.' })),
        cursor: results.length === 100 ? results.at(-1)!.path : null });
    }
    return readingResponse({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ReadingError) return readingResponse({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
