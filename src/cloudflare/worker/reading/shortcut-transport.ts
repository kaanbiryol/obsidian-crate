import { READING_SHORTCUT_CONTRACT as contract } from '@/reading/shortcut';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
import { REQUEST_ID_HEADER } from '@/protocol/http-headers';
import release from '../../server-release.json';
import { PWA_ASSET_VERSION } from '../../../pwa/shell/version';
import { ReadingError } from './common';
import { isSha256Hex } from '@/platform/validation';

export interface ShortcutTransport { kind: 'prepare' | 'exchange'; revision: number }
const revision = (value: string | null) => value && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1;
/** Only the current contract's routes are shortcut transport; other versions are not admitted. */
export function shortcutTransport(request: Request): ShortcutTransport | null {
  if (request.method !== 'POST') return null;
  const path = new URL(request.url).pathname;
  const kind = path === contract.preparePath ? 'prepare' : path === contract.exchangePath ? 'exchange' : null;
  return kind && { kind, revision: revision(request.headers.get(contract.revisionHeader)) };
}
export function shortcutCompatibility(transport: ShortcutTransport): ReadingError | null {
  if (transport.revision < contract.minimumRevision) return new ReadingError('Install the latest Save to Crate shortcut, then reconnect it in Reading settings.', 426, 'shortcut_update_required');
  return null;
}
export function validateShortcutBody(body: Record<string, unknown>, kind: ShortcutTransport['kind']): void {
  const keys = kind === 'prepare' ? ['url', 'title'] : ['token'];
  if (Object.keys(body).some(key => !keys.includes(key))) throw new ReadingError('This shortcut request is not supported. Install the latest shortcut.', 400, 'invalid_shortcut_request');
}

/** Only allowlisted, non-private fields can leave the request in an error URL. */
export async function shortcutLaunchResponse(request: Request, response: Response, serverFingerprint?: string): Promise<Response> {
  const transport = shortcutTransport(request);
  if (!transport) return response;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = await response.clone().json();
    data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  catch { data = {}; }
  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  if (!response.ok) {
    const diagnostic = { stage: transport.kind === 'exchange' ? 'pair' : 'prepare', status: response.status,
      code: typeof data.code === 'string' && /^[a-z_]{1,64}$/.test(data.code) ? data.code : 'request_failed', requestId,
      serverRevision: release.revision, serverFingerprint: serverFingerprint && isSha256Hex(serverFingerprint) ? serverFingerprint : null,
      pwaVersion: PWA_ASSET_VERSION, wireProtocol: CRATE_PLUGIN_PROTOCOL.current,
      shortcutContract: contract.version, shortcutRevision: transport.revision };
    data.launchUrl = `${new URL(request.url).origin}/notifications/save-reading#error=${encodeURIComponent(JSON.stringify(diagnostic))}`;
  } else if (transport.kind === 'prepare' && typeof data.launchUrl === 'string') {
    const launch = new URL(data.launchUrl);
    launch.searchParams.set('shortcut', String(transport.revision));
    launch.searchParams.set('contract', String(contract.version));
    data.launchUrl = launch.href;
  }
  data.shortcut = { version: contract.version, revision: contract.revision, updateAvailable: transport.revision < contract.revision, downloadUrl: contract.downloadUrl };
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'application/json');
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(JSON.stringify(data), { status: response.status, headers });
}
