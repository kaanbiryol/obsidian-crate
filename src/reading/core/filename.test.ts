import { expect, it } from 'vitest';
import { readingCapturePath } from './filename';
import { getPortablePathIssue } from '@/protocol/portable-path';
const id = 'a1b2c3d4-5678-4abc-9def-123456789abc';
it('uses the title and extends only a conflicting short ID', async () => {
	expect(await readingCapturePath('Reading', 'Article', id, () => false)).toBe('Reading/Article - a1b2c3d4.md');
	expect(await readingCapturePath('Reading', 'Article', id, path => path.endsWith('a1b2c3d4.md'))).toBe('Reading/Article - a1b2c3d45678.md');
	await expect(readingCapturePath('Reading', 'Article', id, () => true)).rejects.toThrow('preserved');
});
it('produces bounded portable filenames from hostile and Unicode titles', async () => {
	for (const title of ['CON.txt', '../a:b?c* / d', '... ', '#Title [link] ^block', '😀'.repeat(1000)]) {
		const path = await readingCapturePath('Reading', title, id, () => false);
		expect(path.split('/')).toHaveLength(2);
		expect(getPortablePathIssue(path)).toBeNull();
		expect(new TextEncoder().encode(path.split('/')[1]).length).toBeLessThanOrEqual(255);
	}
});
