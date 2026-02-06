import { describe, it, expect } from 'vitest';
import { merge3 } from './merge';

describe('merge3', () => {
	it('returns base when no changes', () => {
		const base = 'line1\nline2\nline3';
		const result = merge3(base, base, base);
		expect(result).toEqual({ success: true, merged: base });
	});

	it('takes local-only edit', () => {
		const base = 'line1\nline2\nline3';
		const local = 'line1\nmodified\nline3';
		const result = merge3(base, local, base);
		expect(result).toEqual({ success: true, merged: local });
	});

	it('takes remote-only edit', () => {
		const base = 'line1\nline2\nline3';
		const remote = 'line1\nremote-change\nline3';
		const result = merge3(base, base, remote);
		expect(result).toEqual({ success: true, merged: remote });
	});

	it('auto-merges non-overlapping edits', () => {
		const base = 'line1\nline2\nline3\nline4\nline5';
		const local = 'LOCAL\nline2\nline3\nline4\nline5';
		const remote = 'line1\nline2\nline3\nline4\nREMOTE';
		const result = merge3(base, local, remote);
		expect(result).toEqual({
			success: true,
			merged: 'LOCAL\nline2\nline3\nline4\nREMOTE',
		});
	});

	it('clean-merges identical changes on both sides', () => {
		const base = 'line1\nline2\nline3';
		const both = 'line1\nsame-change\nline3';
		const result = merge3(base, both, both);
		expect(result).toEqual({ success: true, merged: both });
	});

	it('returns conflict for same line with different edits', () => {
		const base = 'line1\nline2\nline3';
		const local = 'line1\nlocal-edit\nline3';
		const remote = 'line1\nremote-edit\nline3';
		const result = merge3(base, local, remote);
		expect(result).toEqual({ success: false });
	});

	it('clean-merges insertions at different positions', () => {
		const base = 'line1\nline2\nline3';
		const local = 'inserted-top\nline1\nline2\nline3';
		const remote = 'line1\nline2\nline3\ninserted-bottom';
		const result = merge3(base, local, remote);
		expect(result).toEqual({
			success: true,
			merged: 'inserted-top\nline1\nline2\nline3\ninserted-bottom',
		});
	});

	it('takes deletion on one side', () => {
		const base = 'line1\nline2\nline3';
		const local = 'line1\nline3';
		const result = merge3(base, local, base);
		expect(result).toEqual({ success: true, merged: local });
	});

	it('clean-merges when both delete same section', () => {
		const base = 'line1\nline2\nline3';
		const both = 'line1\nline3';
		const result = merge3(base, both, both);
		expect(result).toEqual({ success: true, merged: both });
	});

	it('returns conflict when empty base and both add content', () => {
		const base = '';
		const local = 'local content';
		const remote = 'remote content';
		const result = merge3(base, local, remote);
		expect(result).toEqual({ success: false });
	});

	it('returns conflict for files exceeding 10k lines', () => {
		const bigContent = Array.from({ length: 10_001 }, (_, i) => `line${i}`).join('\n');
		const result = merge3(bigContent, bigContent, bigContent);
		expect(result).toEqual({ success: false });
	});

	it('handles single-line file edits', () => {
		const base = 'original';
		const local = 'local-version';
		const result = merge3(base, local, base);
		expect(result).toEqual({ success: true, merged: local });
	});

	it('preserves trailing newlines', () => {
		const base = 'line1\nline2\n';
		const local = 'line1\nmodified\n';
		const result = merge3(base, local, base);
		expect(result).toEqual({ success: true, merged: local });
	});
});
