import { describe, it, expect } from 'vitest';
import { isMergeableFile } from './conflict';

describe('isMergeableFile', () => {
	it('returns true for .md files', () => {
		expect(isMergeableFile('notes/test.md')).toBe(true);
	});

	it('returns true for .txt files', () => {
		expect(isMergeableFile('notes/test.txt')).toBe(true);
	});

	it('returns false for .png files', () => {
		expect(isMergeableFile('images/photo.png')).toBe(false);
	});

	it('returns false for .json files', () => {
		expect(isMergeableFile('data.json')).toBe(false);
	});

	it('returns false for files without extension', () => {
		expect(isMergeableFile('no-extension')).toBe(false);
	});
});
