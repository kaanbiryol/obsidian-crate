import { expect, it } from 'vitest';
import { shortcutCompatibility, shortcutLaunchResponse, shortcutTransport, validateShortcutBody } from './shortcut-transport';

it('keeps native capture independent of a future general wire protocol', () => {
  const native = shortcutTransport(new Request('https://crate.example/reading/shortcut/v1/prepare', { method: 'POST', headers: { 'X-Crate-Shortcut-Revision': '2' } }))!;
  expect(shortcutCompatibility(native)).toBeNull();
});
it('does not treat unversioned requests as shortcut transport', () => {
  for (const path of ['/reading/capture', '/sync/upload', '/reading/prepare']) {
    expect(shortcutTransport(new Request(`https://crate.example${path}`, { method: 'POST', headers: { 'X-Crate-Protocol': '12' } }))).toBeNull();
  }
  expect(shortcutTransport(new Request('https://crate.example/reading/shortcut/v01/exchange', { method: 'POST' }))).toBeNull();
});
it('requires an explicit server or shortcut update for unsupported capture contracts', () => {
  expect(shortcutCompatibility({ kind: 'prepare', version: 2, revision: 2 })?.code).toBe('server_update_required');
  expect(shortcutCompatibility({ kind: 'prepare', version: 0, revision: 1 })?.code).toBe('shortcut_update_required');
});
it('limits version-one capture payloads to their original semantics', () => {
  expect(() => validateShortcutBody({ url: 'https://example.com', title: 'Example' }, 'prepare')).not.toThrow();
  expect(() => validateShortcutBody({ token: 'one-use grant' }, 'exchange')).not.toThrow();
  for (const field of ['destinationFolder', 'operationId', 'fetchArticle', 'authorization']) {
    expect(() => validateShortcutBody({ url: 'https://example.com', [field]: 'unexpected' }, 'prepare')).toThrow();
  }
});
it('puts only safe versions and correlation fields into the failure launch URL', async () => {
  const request = new Request('https://crate.example/reading/shortcut/v1/prepare', { method: 'POST',
    headers: { Authorization: 'Bearer private-access', 'X-Crate-Shortcut-Revision': '2' }, body: JSON.stringify({ url: 'https://example.com/private-article' }),
  });
  const response = new Response(JSON.stringify({ code: 'reading_error', error: 'private-error', token: 'private-code', launchUrl: 'https://other.example/private-link' }), { status: 401 });
  const wrapped = await shortcutLaunchResponse(request, response, 'd'.repeat(64));
  const result = await wrapped.json() as { launchUrl: string };
  const url = new URL(result.launchUrl), diagnostic = JSON.parse(decodeURIComponent(url.hash.slice('#error='.length))) as Record<string, unknown>;
  expect(`${url.origin}${url.pathname}`).toBe('https://crate.example/notifications/save-reading');
  expect(diagnostic).toMatchObject({ stage: 'prepare', status: 401, code: 'reading_error', serverFingerprint: 'd'.repeat(64), pwaVersion: 'dev', shortcutRevision: 2 });
  expect(decodeURIComponent(result.launchUrl)).not.toContain('private');
  expect(diagnostic.requestId).toBe(wrapped.headers.get('X-Crate-Request-Id'));
  expect(wrapped.headers.get('Cache-Control')).toBe('no-store');
});
