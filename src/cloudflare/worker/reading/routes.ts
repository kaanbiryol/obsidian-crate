import { readConvertedScopeEnvelope } from '../encryption/receipts';
import { readEncryptionState, scopedEncryptionState } from '../encryption/state';
import { handleEncryptedFolderFiles } from '../encryption/encrypted-folder-files';
import { issueShortcutPairing, exchangeShortcutPairing } from './shortcut-pairing';
import { shortcutTransport, validateShortcutBody } from './shortcut-transport';
import { armNotificationCoordinator } from '../notifications/lifecycle';
import { limitNotificationAction } from '../rate-limit';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { parseJsonObject } from '../request-validation';
import { policy, authority, readingResponse, ReadingError } from './common';
import { issueReadingAccess, prepareHandoff, updatePolicy, exchangeReadingAccess, handoffAuthority } from './access';
import { mutateReading } from './mutations';
import { projectReading } from './projection';
import { readingItem, readingList, readingListEtag } from './queries';
import { corsHeaders } from '../cors';

export async function handleReadingRoute(request: Request, env: Env, principal?: AuthPrincipal, state?: DurableObjectState, authenticatedEncryption?: EncryptionServerState | null): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    // Authentication loads the encryption state with the token.
    const encryption = authenticatedEncryption !== undefined ? authenticatedEncryption : await readEncryptionState(env.DB);
    const shortcut = shortcutTransport(request);
    if (path.startsWith('/reading/encrypted-')) {
      if (!principal || principal.scope === 'reading_capture') throw new ReadingError('Library access is required.', 403);
      const current = await authority(env.DB, principal);
      const limited = await limitNotificationAction(request, env.DB, principal.tokenId); if (limited) return limited;
      if (path === '/reading/encrypted-receipt' && request.method === 'GET') {
        const id = url.searchParams.get('operationId') ?? '';
        const receipt = url.searchParams.get('wire') === '1' ? { kind: 'reminder' as const } : { kind: 'reading' as const, generation: current.generation };
        const scope = encryption?.scopes.find(scope => scope.folderPath === current.folder_path);
        return readingResponse({ envelope: await readConvertedScopeEnvelope(env.DB, receipt, id, scope?.id) });
      }
      return await handleEncryptedFolderFiles(request, env, path, 'reading', current.folder_path) ?? readingResponse({ error: 'Not found' }, 404);
    }
    if (encryption && (shortcut?.kind === 'prepare' || ['/reading/handoff', '/reading/capture', '/reading/update', '/reading/retry', '/reading/list', '/reading/item'].includes(path))) throw new ReadingError('Use an unlocked, updated Reading app for this encrypted vault.', 428);
    if (path === '/reading/encryption' && request.method === 'GET' && principal) {
      const current = await authority(env.DB, principal);
      return readingResponse({ encryption: encryption ? scopedEncryptionState(encryption, current.folder_path) : null });
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
    if (shortcut?.kind === 'prepare' && request.method === 'POST') return await prepareHandoff(env.DB, principal, body, url.origin);
    if (path === '/reading/capture' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'capture');
    if (principal.scope === 'reading_capture') throw new ReadingError('This credential can only save links.', 403);
    if (path === '/reading/session' && request.method === 'GET') return readingResponse({ id: principal.tokenId, folderPath: current.folder_path, generation: current.generation, expiresAt: principal.expiresAt ?? null, day: Math.floor(Date.now() / 86400_000) });
    if (path === '/reading/update' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'update');
    if (path === '/reading/retry' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'retry');
    // The first list page is conditional, so an unchanged library is one cheap request.
    const listTag = path === '/reading/list' && request.method === 'GET' && !url.searchParams.get('cursor')
      ? await readingListEtag(env.DB, current, request.headers.get('If-None-Match')) : null;
    if (listTag?.notModified) return new Response(null, { status: 304, headers: { ...corsHeaders(), 'Cache-Control': 'no-store', ETag: listTag.etag } });
    if (await projectReading(env, current) !== 'complete') throw new ReadingError('Your Reading library is not fully available yet. Try refreshing shortly.', 503);
    if (path === '/reading/item' && request.method === 'GET') return readingResponse(await readingItem(env, current, url.searchParams.get('id')));
    if (path === '/reading/list' && request.method === 'GET') return readingResponse(await readingList(env, current, url.searchParams.get('cursor') ?? ''), 200, listTag ? { ETag: listTag.etag } : {});
    return readingResponse({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ReadingError) return readingResponse({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
