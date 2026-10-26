import { isMarkdownPath } from '../../protocol/note-paths';
import type { FileEntry } from '../../protocol/sync-types';
import type { TransferContext } from './types';
import { sha256Hex } from '../../platform/sha256';
import { isSyncRevision } from '../../protocol/sync-validation';

// A remote baseline can be valid even when its local metadata is not. The
// planners deliberately hash entries whose modification time is not a date.
export const UNVERIFIED_MODIFIED = 'unverified';

export async function recordAppliedContent(
  context: TransferContext,
  path: string,
  content: ArrayBuffer,
  revision?: string,
  // Callers that already verified these bytes pass their hash to skip rehashing.
  knownHash?: string,
): Promise<FileEntry> {
  const hash = knownHash ?? await sha256Hex(content);
  let modified = UNVERIFIED_MODIFIED;
  try {
    const before = await context.getModifiedIso(path);
    const current = await context.vault.adapter.readBinary(path);
    const after = await context.getModifiedIso(path);
    if (before === after && current.byteLength === content.byteLength && await sha256Hex(current) === hash) {
      modified = before;
    }
  } catch {
    // A disappearing or unreadable file must remain detectable after restart.
  }
  // A baseline without a revision is reconciled before any delete, while an
  // invalid one would make the saved checkpoint unreadable after a restart.
  const entry = { hash, size: content.byteLength, modified, revision: isSyncRevision(revision) ? revision : undefined };
  context.localManifest.setEntry(path, entry);
  if (isMarkdownPath(path)) await context.markdownBaseCache?.putBase(path, hash, content);
  await context.conflictStore?.resolveAppliedIncoming?.(path, hash);
  await context.files.recordMergeApplication?.(path, hash, 'local-applied');
  return entry;
}
