import { expect, it } from 'vitest';
import { dockReadingSections } from './useReadingLibrarySource';

it('prefetches the Reading sections in the dock, in dock order', () => {
	expect(dockReadingSections(['inbox', 'today', 'browse', 'reading'])).toEqual(['inbox']);
	expect(dockReadingSections(['highlights', 'today', 'archive', 'favorites'])).toEqual(['highlights', 'archived', 'favorites']);
	expect(dockReadingSections(['inbox', 'today', 'browse'])).toEqual([]);
});
