import { readEncryptionState } from '../encryption/state';
import { handleEncryptedFolderFiles } from '../encryption/encrypted-folder-files';
import { issueShortcutPairing, exchangeShortcutPairing } from './shortcut-pairing';
import { shortcutTransport, validateShortcutBody } from './shortcut-transport';
import { armNotificationCoordinator } from '../notifications/lifecycle';
import { limitNotificationAction } from '../rate-limit';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { parseJsonObject } from '../request-validation';
import { policy, authority, readingResponse, ReadingError, readStoredNote } from './common';
import { prepareHandoff, updatePolicy, handoffAuthority, labelledPolicy } from './access';
import { readFolderLabel } from '../encryption/folder-labels';
import { mutateReading } from './mutations';
import { extractForEncryptedReading } from './encrypted-extract';
import { etagMatches, readingItem, readingList, readingListEtag } from './queries';
import { ensureReadingIndex } from './library-index';
import { corsHeaders } from '../cors';

export async function handleReadingRoute(request: Request, env: Env, principal?: AuthPrincipal, state?: DurableObjectState, authenticatedEncryption?: EncryptionServerState | null, featurePolicyValue?: string | null): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    // Authentication loads the encryption state with the token.
    const encryption = authenticatedEncryption !== undefined ? authenticatedEncryption : await readEncryptionState(env.DB);
    const shortcut = shortcutTransport(request);
    if (path.startsWith('/reading/encrypted-')) {
      if (!principal || principal.scope === 'reading_capture') throw new ReadingError('Library access is required.', 403);
      const current = await authority(env.DB, principal, featurePolicyValue);
      const limited = await limitNotificationAction(request, env.DB, principal.tokenId); if (limited) return limited;
      if (path === '/reading/encrypted-extract' && request.method === 'POST') {
        if (!encryption) throw new ReadingError('Article downloads here are only for encrypted Reading folders.', 409);
        return await extractForEncryptedReading(request, env);
      }
      return await handleEncryptedFolderFiles(request, env, path, 'reading', current.folder_path, encryption) ?? readingResponse({ error: 'Not found' }, 404);
    }
    if (encryption && (shortcut?.kind === 'prepare' || ['/reading/handoff', '/reading/capture', '/reading/update', '/reading/retry', '/reading/list', '/reading/item'].includes(path))) throw new ReadingError('Use an unlocked, updated Reading app for this encrypted vault.', 428);
    if (path === '/reading/encryption' && request.method === 'GET' && principal) {
      const current = await authority(env.DB, principal, featurePolicyValue); // Reading access only.
      // The web app recovers the plaintext folder name from this label with the vault key.
      return readingResponse({ encryption, ...(encryption ? { folderLabel: await readFolderLabel(env.DB, current.folder_path) } : {}) });
    }
    const parsed = request.method === 'GET' ? { ok: true as const, value: {} } : await parseJsonObject(request, path === '/reading/update' ? 262_144 : 24_576);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (shortcut) validateShortcutBody(body, shortcut.kind);
    if (shortcut?.kind === 'exchange') return await exchangeShortcutPairing(env.DB, body, request);
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
      if (request.method === 'GET') return readingResponse({ policy: await labelledPolicy(env.DB, await policy(env.DB)) });
      if (request.method === 'POST') return await updatePolicy(env.DB, body);
    }
    const current = await authority(env.DB, principal, featurePolicyValue);
    if (path === '/reading/shortcut-pairing' && request.method === 'POST') return await issueShortcutPairing(env.DB, principal, current, url.origin);
    if (shortcut?.kind === 'prepare' && request.method === 'POST') return await prepareHandoff(env.DB, principal, body, url.origin);
    if (path === '/reading/capture' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'capture');
    if (principal.scope === 'reading_capture') throw new ReadingError('This credential can only save links.', 403);
    if (path === '/reading/session' && request.method === 'GET') return readingResponse({ id: principal.tokenId, folderPath: current.folder_path, generation: current.generation, expiresAt: principal.expiresAt ?? null, day: Math.floor(Date.now() / 86400_000) });
    if (path === '/reading/update' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'update');
    if (path === '/reading/retry' && request.method === 'POST') return await mutateReading(env, principal, current, body, 'retry');
    if (request.method === 'GET' && (path === '/reading/item' || path === '/reading/list')) {
      const index = await ensureReadingIndex(env, current, file => readStoredNote(env, file));
      // Reads wake notification processing only to continue a rebuild or extract what it queued.
      if (index.rebuilt && state) await armNotificationCoordinator(state);
      if (index.state !== 'complete') throw new ReadingError('Your Reading library is not fully available yet. Try refreshing shortly.', 503);
      if (path === '/reading/item') return readingResponse(await readingItem(env, current, url.searchParams.get('id')));
      // The first list page is conditional, so an unchanged library is one cheap request.
      const cursor = url.searchParams.get('cursor') ?? '';
      const etag = cursor ? null : await readingListEtag(current, index.revision);
      if (etag && etagMatches(request.headers.get('If-None-Match'), etag)) return new Response(null, { status: 304, headers: { ...corsHeaders(), 'Cache-Control': 'no-store', ETag: etag } });
      return readingResponse(await readingList(env, current, cursor), 200, etag ? { ETag: etag } : {});
    }
    return readingResponse({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ReadingError) return error.toResponse();
    throw error;
  }
}
