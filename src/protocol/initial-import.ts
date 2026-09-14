export const INITIAL_IMPORT_CAPABILITY = 'resumable-initial-import-v2';
// Initial imports omit the history/projection statements used by normal uploads.
// Leave room for authentication, staging and cleanup within D1's 50-query limit.
export const INITIAL_IMPORT_MAX_FILES = 32;
export interface InitialImport { token: string; state: 'importing' | 'complete' }

/** Both peers hash the same ordered inventory, independent of database collation. */
export async function importInventoryHash(files: Record<string, { hash: string; size: number }>): Promise<string> {
  const inventory = Object.keys(files).sort().map(path => [path, files[path]!.hash, files[path]!.size]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(inventory)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
