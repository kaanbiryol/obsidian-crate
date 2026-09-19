import { describe, expect, it, vi } from 'vitest';
import { buildDiff, groupDiffContext } from './diff-model';

describe('diff presentation', () => {
    it('numbers before and after independently through multiple edits', () => {
        const diff = buildDiff('a\nb\nc\nd', 'a\nx\ny\nc');
        expect(diff).toMatchObject({ added: 2, removed: 2 });
        expect(diff.lines).toMatchObject([
            { kind: 'context', text: 'a', before: 1, after: 1 },
            { kind: 'removed', text: 'b', before: 2 },
            { kind: 'added', text: 'x', after: 2 },
            { kind: 'added', text: 'y', after: 3 },
            { kind: 'context', text: 'c', before: 3, after: 4 },
            { kind: 'removed', text: 'd', before: 4 },
        ]);
    });
    it('treats empty files as zero lines and preserves trailing newline changes', () => {
        expect(buildDiff('', 'hello')).toMatchObject({ added: 1, removed: 0 });
        expect(buildDiff('hello', '')).toMatchObject({ added: 0, removed: 1 });
        expect(buildDiff('hello', 'hello\n')).toMatchObject({ added: 1, removed: 0 });
        expect(buildDiff('', '').lines).toEqual([]);
    });
    it('shows JSON formatting changes as edits to the original file lines', () => {
        const before = '{"enabled":true}', after = '{\n  "enabled": true\n}';
        const diff = buildDiff(before, after);
        expect(diff).toMatchObject({ added: 3, removed: 1 });
        expect(diff.lines[0]).toMatchObject({ kind: 'removed', text: before, before: 1 });
        expect(buildDiff('', after)).toMatchObject({ added: 3, removed: 0 });
        expect(buildDiff('{invalid', after)).toMatchObject({ added: 3, removed: 1 });
    });
    it('collapses distant context while keeping three lines around changes', () => {
        const before = Array.from({ length: 30 }, (_, i) => String(i));
        const after = [...before];
        after[15] = 'changed';
        const groups = groupDiffContext(buildDiff(before.join('\n'), after.join('\n')).lines);
        expect(groups.map(group => [group.hidden, group.lines.length])).toEqual([[true, 12], [false, 8], [true, 11]]);
        expect(groups[1]?.lines[0]?.text).toBe('12');
        expect(groups[1]?.lines.at(-1)?.text).toBe('18');
    });
    it('preserves exact numbers, escaped strings, and duplicate keys', () => {
        expect(buildDiff('{"id":9007199254740992}', '{"id":9007199254740993}')).toMatchObject({ added: 1, removed: 1 });
        expect(buildDiff('{"a":1,"a":2}', '{"a":2}').removed).toBeGreaterThan(0);
        const before = JSON.stringify({ a: 'quoted "{,}"', b: [] });
        const after = JSON.stringify({ a: 'quoted "{,}"', b: [1] });
        expect(buildDiff(before, after)).toMatchObject({ added: 1, removed: 1 });
    });
    it('bounds work for files with excessive line counts', () => {
        expect(buildDiff('a\n'.repeat(4_001), '').limited).toBe(true);
    });
    it('matches repeated lines without treating the entire region as replaced', () => {
        const before = 'red\nblue\nred\nblue', after = 'blue\nred\nblue\nred';
        const diff = buildDiff(before, after);
        expect(diff).toMatchObject({ added: 1, removed: 1, limited: false });
        expect(diff.lines.filter(line => line.kind !== 'added').map(line => line.text).join('\n')).toBe(before);
        expect(diff.lines.filter(line => line.kind !== 'removed').map(line => line.text).join('\n')).toBe(after);
    });
    it('preserves blank lines, whitespace, Unicode, and exact line endings', () => {
        const before = 'Café ☕\r\n\r\n  task\r\n', after = 'Café ☕\n\n\ttask\n';
        const diff = buildDiff(before, after);
        expect(diff.limited).toBe(false);
        expect(diff.lines.filter(line => line.kind !== 'added').map(line => line.text)).toEqual(before.split('\n'));
        expect(diff.lines.filter(line => line.kind !== 'removed').map(line => line.text)).toEqual(after.split('\n'));
        expect(diff.lines.filter(line => line.before).map(line => line.before)).toEqual([1, 2, 3, 4]);
        expect(diff.lines.filter(line => line.after).map(line => line.after)).toEqual([1, 2, 3, 4]);
    });
    it('gives up on very different files without showing partial results or zero-change statistics', () => {
        const before = Array.from({ length: 1_100 }, (_, i) => `before ${i}`).join('\n');
        const after = Array.from({ length: 1_100 }, (_, i) => `after ${i}`).join('\n');
        expect(buildDiff(before, after)).toEqual({ lines: [], added: 0, removed: 0, limited: true });
    });
    it('stops a comparison when its UI time budget expires', () => {
        let clock = 0;
        const now = vi.spyOn(Date, 'now').mockImplementation(() => clock += 100);
        try {
            expect(buildDiff('a\nb', 'c\nd').limited).toBe(true);
        } finally { now.mockRestore(); }
    });
});

it('highlights replacement phrases without losing whitespace or punctuation', () => {
    const diff = buildDiff('- Morning walk.', '- Sleep.');
    expect(diff.lines.map(line => line.words?.map(word => word.text).join(''))).toEqual(['- Morning walk.', '- Sleep.']);
    expect(diff.lines.map(line => line.words?.filter(word => word.changed).map(word => word.text).join(''))).toEqual(['Morning walk', 'Sleep']);
});
