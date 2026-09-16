import { describe, expect, it } from 'vitest';
import { buildDiff, groupDiffContext } from './diff-model';

describe('diff presentation', () => {
    it('numbers before and after independently through multiple edits', () => {
        const diff = buildDiff('a\nb\nc\nd', 'a\nx\ny\nc');
        expect(diff).toMatchObject({ added: 2, removed: 2 });
        expect(diff.lines).toEqual([
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
        expect(diff.lines[0]).toEqual({ kind: 'removed', text: before, before: 1 });
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
});
