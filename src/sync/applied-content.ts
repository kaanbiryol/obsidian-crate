import { computeHash } from './hasher';
import { isMarkdownPath } from './markdown-base-cache';
import type { FileEntry } from '../protocol/sync-types';
import type { TransferContext } from './transfer-types';

// A remote baseline can be valid even when its local metadata is not. The
// planners deliberately hash entries whose modification time is not a date.
export const UNVERIFIED_MODIFIED = 'unverified';

export async function recordAppliedContent(
  context: TransferContext,
  path: string,
  content: ArrayBuffer,
  revision?: string,
): Promise<FileEntry> {
  const hash = await computeHash(content);
  let modified = UNVERIFIED_MODIFIED;
  try {
    const before = await context.getModifiedIso(path);
    const current = await context.vault.adapter.readBinary(path);
    const after = await context.getModifiedIso(path);
    if (before === after && current.byteLength === content.byteLength && await computeHash(current) === hash) {
      modified = before;
    }
  } catch {
    // A disappearing or unreadable file must remain detectable after restart.
  }
  const entry = { hash, size: content.byteLength, modified, revision };
  context.localManifest.setEntry(path, entry);
  if (isMarkdownPath(path)) await context.markdownBaseCache?.putBase(path, hash, content);
  await context.api.recordMergeApplication?.(path, hash, 'local-applied');
  return entry;
}
