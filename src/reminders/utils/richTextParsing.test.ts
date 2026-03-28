import { describe, it, expect } from 'vitest';
import { getChipStyle, createChipHTML, buildHTML, findProjectMatches, findPriorityMatches } from './richTextParsing';

describe('getChipStyle', () => {
    it('uses display: inline, not inline-flex', () => {
        const style = getChipStyle('project', '#forge');
        expect(style).toContain('display: inline;');
        expect(style).not.toContain('inline-flex');
        expect(style).not.toContain('align-items');
    });

    it('returns project-specific colors', () => {
        const style = getChipStyle('project', '#work');
        expect(style).toContain('--heroui-primary');
    });

    it('returns priority-specific colors', () => {
        const style = getChipStyle('priority', '!');
        expect(style).toContain('--heroui-danger');
    });

    it('returns date-specific colors', () => {
        const style = getChipStyle('date', 'tomorrow');
        expect(style).toContain('--heroui-success');
    });
});

describe('createChipHTML', () => {
    it('wraps text in a rich-text-chip span', () => {
        const html = createChipHTML('project', '#forge');
        expect(html).toMatch(/^<span class="rich-text-chip" style="[^"]+">.*<\/span>$/);
        expect(html).toContain('#forge');
    });

    it('escapes HTML entities', () => {
        const html = createChipHTML('project', '#a<b');
        expect(html).toContain('&lt;');
        expect(html).not.toContain('<b');
    });
});

describe('findProjectMatches', () => {
    it('matches single-word project tags', () => {
        const matches = findProjectMatches('buy milk #forge');
        expect(matches).toHaveLength(1);
        expect(matches[0].text).toBe('#forge');
        expect(matches[0].index).toBe(9);
    });

    it('matches known multi-word projects', () => {
        const matches = findProjectMatches('task #my project done', ['my project']);
        expect(matches).toHaveLength(1);
        expect(matches[0].text).toBe('#my project');
    });

    it('skips purely numeric tags', () => {
        const matches = findProjectMatches('see #338 for details');
        expect(matches).toHaveLength(0);
    });
});

describe('findPriorityMatches', () => {
    it('matches standalone !', () => {
        const matches = findPriorityMatches('important !');
        expect(matches).toHaveLength(1);
        expect(matches[0].text).toBe('!');
    });
});

describe('buildHTML', () => {
    it('returns empty string for empty input', () => {
        expect(buildHTML('')).toBe('');
    });

    it('wraps project tags in chip spans', () => {
        const html = buildHTML('buy milk #forge');
        expect(html).toContain('<span class="rich-text-chip"');
        expect(html).toContain('#forge');
        expect(html).toMatch(/^buy milk /);
    });

    it('leaves plain text unmodified', () => {
        const html = buildHTML('just plain text');
        expect(html).toBe('just plain text');
    });

    it('escapes HTML in non-chip text', () => {
        const html = buildHTML('a < b');
        expect(html).toContain('&lt;');
    });
});
