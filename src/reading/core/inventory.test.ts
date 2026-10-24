import { describe, expect, it } from 'vitest';
import { filterUniqueReadingIds, findSavedReadingLink } from './inventory';

const item = (id: string, url: string, path = `${id}.md`) => ({ crate_reading_id: id, source_url: url, path });

describe('Reading inventory rules', () => {
	it('keeps unique IDs and reports every copy of a shared ID in input order', () => {
		const a = item('a', 'https://example.com/a'), b1 = item('b', 'https://example.com/b', 'b1.md'), c = item('c', ''), b2 = item('b', 'https://example.com/b', 'b2.md');
		expect(filterUniqueReadingIds([a, b1, c, b2])).toEqual({ unique: [a, c], duplicates: [b1, b2] });
	});

	it('matches saved links by identity and refuses to choose between several', () => {
		const video = item('v', 'https://youtu.be/jNQXAC9IVRw?t=42'), source = item('s', ''), page = item('p', 'https://example.com/page#top');
		expect(findSavedReadingLink([video, source, page], 'https://www.youtube.com/watch?v=jNQXAC9IVRw')).toEqual({ kind: 'one', item: video });
		expect(findSavedReadingLink([video, source, page], 'https://example.com/page')).toEqual({ kind: 'one', item: page });
		expect(findSavedReadingLink([video, source, page], 'https://example.com/other')).toEqual({ kind: 'none' });
		expect(findSavedReadingLink([page, item('q', 'https://example.com/page')], 'https://example.com/page')).toEqual({ kind: 'many' });
	});
});
