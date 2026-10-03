/** Browser drafts, caches and immutable semantic requests retain their enrolled
 * namespace. Only the encrypted transport maps it to the authenticated live path. */
export function routeFolderPath(path: string, from: string, to: string): string {
  return path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path;
}

export class EncryptionScopeChangedError extends Error {}

export function routeFolderRequest(path: string, init: RequestInit, from: string, to: string): { path: string; init: RequestInit } {
  if (from === to) return { path, init };
  const url = new URL(path, 'https://crate.invalid');
  if (url.searchParams.get('folderPath') === from) url.searchParams.set('folderPath', to);
  if (typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body) as { folderPath?: string } | null;
      if (body?.folderPath === from) init = { ...init, body: JSON.stringify({ ...body, folderPath: to }) };
    } catch { /* Non-JSON requests do not contain folder routing metadata. */ }
  }
  return { path: url.pathname + url.search, init };
}
