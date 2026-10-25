import { expect, it } from 'vitest';
import { isGeneratedCapturePath, readingCapturePath } from './filename';
import { getPortablePathIssue } from '@/protocol/portable-path';
const id = 'a1b2c3d4-5678-4abc-9def-123456789abc';
const url = 'https://www.kaanbiryol.com/the-hidden-cost/';
it('names notes after the title and site and extends only a conflicting short ID', async () => {
	const source = { title: 'The Hidden Cost', url };
	expect(await readingCapturePath('Reading', source, id, () => false)).toBe('Reading/The Hidden Cost - kaanbiryol.com - a1b2c3d4.md');
	expect(await readingCapturePath('Reading', source, id, path => path.endsWith('a1b2c3d4.md'))).toBe('Reading/The Hidden Cost - kaanbiryol.com - a1b2c3d45678.md');
	await expect(readingCapturePath('Reading', source, id, () => true)).rejects.toThrow('preserved');
});
it('uses the site alone until the title is known, and a generic name without a source', async () => {
	expect(await readingCapturePath('Reading', { title: 'www.kaanbiryol.com', url }, id, () => false)).toBe('Reading/kaanbiryol.com - a1b2c3d4.md');
	expect(await readingCapturePath('Reading', { title: ' ', url }, id, () => false)).toBe('Reading/kaanbiryol.com - a1b2c3d4.md');
	expect(await readingCapturePath('Reading', null, id, () => false)).toBe('Reading/Article - a1b2c3d4.md');
});
it('produces bounded portable filenames from hostile and Unicode titles and long hostnames', async () => {
	const hosts = ['https://example.com/', `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.com/`, 'https://xn--bcher-kva.example/', 'http://[::1]/'];
	for (const link of hosts) {
		for (const title of ['CON.txt', '../a:b?c* / d', '... ', '#Title [link] ^block', '😀'.repeat(1000)]) {
			// Force the longest ID so the byte budget is checked at its limit.
			const path = await readingCapturePath('Reading', { title, url: link }, id, candidate => !candidate.includes(id.replace(/-/g, '')));
			const name = path.split('/')[1]!;
			expect(path.split('/')).toHaveLength(2);
			expect(getPortablePathIssue(path)).toBeNull();
			expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
		}
	}
});
it('recognizes only names Crate generated for the note', async () => {
	const source = { title: 'kaanbiryol.com', url };
	const path = await readingCapturePath('Reading', source, id, candidate => candidate.endsWith('a1b2c3d4.md'));
	expect(isGeneratedCapturePath(path, 'reading', source, id)).toBe(true);
	expect(isGeneratedCapturePath('Reading/kaanbiryol.com - a1b2c3d4.md', 'Reading', source, id)).toBe(true);
	expect(isGeneratedCapturePath('Reading/My notes.md', 'Reading', source, id)).toBe(false);
	expect(isGeneratedCapturePath('Reading/Archive/kaanbiryol.com - a1b2c3d4.md', 'Reading', source, id)).toBe(false);
	expect(isGeneratedCapturePath('Reading/kaanbiryol.com - ffffffff.md', 'Reading', source, id)).toBe(false);
});
