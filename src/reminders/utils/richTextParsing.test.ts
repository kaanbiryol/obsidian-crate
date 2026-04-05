import { describe, it, expect, vi, beforeAll } from 'vitest';
import { getChipStyle, createChipHTML, buildHTML, findProjectMatches, findPriorityMatches, findLinkMatches, findAllMatches, getPlainText } from './richTextParsing';

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

    it('renders markdown links as anchor tags', () => {
        const html = buildHTML('click [here](https://example.com) please');
        expect(html).toContain('<a href="https://example.com"');
        expect(html).toContain('data-markdown-link="true"');
        expect(html).toContain('>here</a>');
        expect(html).toMatch(/^click /);
        expect(html).toMatch(/ please$/);
    });

    it('escapes HTML in link text and URL', () => {
        const html = buildHTML('[a<b](https://example.com?x=1&y=2)');
        expect(html).toContain('>a&lt;b</a>');
        expect(html).toContain('href="https://example.com?x=1&amp;y=2"');
    });

    it('does not render links with unsafe URLs', () => {
        const html = buildHTML('[click](javascript:alert(1))');
        // Should not contain an anchor tag
        expect(html).not.toContain('<a ');
    });

});

describe('findLinkMatches', () => {
    it('finds markdown links with safe URLs', () => {
        const matches = findLinkMatches('click [here](https://example.com)');
        expect(matches).toHaveLength(1);
        expect(matches[0].type).toBe('link');
        expect(matches[0].linkText).toBe('here');
        expect(matches[0].linkUrl).toBe('https://example.com');
    });

    it('excludes links with unsafe URLs', () => {
        const matches = findLinkMatches('[xss](javascript:alert(1))');
        expect(matches).toHaveLength(0);
    });
});

describe('findAllMatches', () => {
    it('does not match project tags inside links', () => {
        const matches = findAllMatches('[#forge info](https://example.com)');
        const projectMatches = matches.filter(m => m.type === 'project');
        expect(projectMatches).toHaveLength(0);
    });

    it('includes link matches alongside other types', () => {
        const matches = findAllMatches('buy [milk](https://shop.com) #forge !');
        const types = matches.map(m => m.type);
        expect(types).toContain('link');
        expect(types).toContain('project');
        expect(types).toContain('priority');
    });

});

describe('getPlainText', () => {
    const TEXT_NODE = 3;
    const ELEMENT_NODE = 1;

    beforeAll(() => {
        if (typeof globalThis.Node === 'undefined') {
            vi.stubGlobal('Node', { TEXT_NODE: 3, ELEMENT_NODE: 1 });
        }
    });

    function textNode(content: string) {
        return { nodeType: TEXT_NODE, nodeName: '#text', textContent: content, childNodes: [] };
    }

    function elementNode(tag: string, children: unknown[], attrs: Record<string, string> = {}) {
        return {
            nodeType: ELEMENT_NODE,
            nodeName: tag.toUpperCase(),
            textContent: children.map((c: any) => c.textContent ?? '').join(''),
            childNodes: children,
            hasAttribute: (name: string) => name in attrs,
            getAttribute: (name: string) => attrs[name] ?? null,
        };
    }

    it('reconstructs markdown link syntax from anchor elements', () => {
        const root = elementNode('div', [
            textNode('click '),
            elementNode('a', [textNode('here')], { 'data-markdown-link': 'true', href: 'https://example.com' }),
            textNode(' done'),
        ]);
        expect(getPlainText(root as unknown as HTMLElement)).toBe('click [here](https://example.com) done');
    });

    it('extracts plain text from regular elements', () => {
        const root = elementNode('div', [
            textNode('just '),
            elementNode('span', [textNode('plain')]),
            textNode(' text'),
        ]);
        expect(getPlainText(root as unknown as HTMLElement)).toBe('just plain text');
    });

});
