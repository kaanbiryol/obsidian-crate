import { BATCH_FILE_SIZE_LIMIT, BULK_NEW_UPLOAD_MAX_FILES, BATCH_UPLOAD_MAX_BYTES } from '../protocol/sync-limits';
import { portablePathKey } from '../protocol/portable-path';
import type { JournalUpload } from './upload-intent';

/** Keep journal order; merges, large files, and conflicting paths form barriers. */
export function* recoveryChunks(files: JournalUpload[]): Generator<JournalUpload[]> {
  let chunk: JournalUpload[] = [];
  let keys: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const single = file.intent.kind === 'merge' || file.size >= BATCH_FILE_SIZE_LIMIT;
    const key = portablePathKey(file.path);
    const dependent = keys.some(prior => prior === key || prior.startsWith(key + '/') || key.startsWith(prior + '/'));
    if (chunk.length && (single || dependent || chunk.length >= BULK_NEW_UPLOAD_MAX_FILES || bytes + file.size > BATCH_UPLOAD_MAX_BYTES)) {
      yield chunk; chunk = []; keys = []; bytes = 0;
    }
    if (single) { yield [file]; continue; }
    chunk.push(file); keys.push(key); bytes += file.size;
  }
  if (chunk.length) yield chunk;
}
