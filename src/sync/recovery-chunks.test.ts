import { expect, it } from 'vitest';
import { recoveryChunks } from './recovery-chunks';
import type { JournalUpload } from './upload-intent';
import { BATCH_FILE_SIZE_LIMIT } from '../protocol/sync-limits';
const file = (path: string, size = 1) => ({ path, size, intent: { kind: 'local' }, content: 'eA==' }) as JournalUpload;
it('bounds batches to eight uploads', () => {
  expect([...recoveryChunks(Array.from({ length: 20 }, (_, i) => file(`${i}.md`)))].map(chunk => chunk.length)).toEqual([8, 8, 4]);
});
it('keeps large files and merge uploads as ordered single requests', () => {
  const merge = { ...file('merge.md'), intent: { kind: 'merge', preimage: { hash: 'h', content: 'eA==', size: 1 } } } as JournalUpload;
  const files = [file('a.md'), file('b.md'), file('large.bin', BATCH_FILE_SIZE_LIMIT), merge, file('c.md'), file('d.md')];
  expect([...recoveryChunks(files)].map(chunk => chunk.map(f => f.path))).toEqual([
    ['a.md', 'b.md'], ['large.bin'], ['merge.md'], ['c.md', 'd.md'],
  ]);
});
it.each([['Folder', 'folder/child.md'], ['note.md', 'NOTE.md'], ['folder/child.md', 'Folder']])('keeps conflicting paths %s and %s in separate requests', (a, b) => {
  expect([...recoveryChunks([file(a), file(b)])]).toHaveLength(2);
});
