import { describe, it, expect, vi, beforeAll } from 'vitest';
import { getPlainText } from './richTextPlainText';
import { findProjectMatches, findPriorityMatches, findLinkMatches, findAllMatches } from './richTextMatchers';

describe('findProjectMatches', () => {
    it.each(['Café', 'Cafe\u0301', '日本語', 'İş', '家/買い物', 'Café/2026'])('matches the entire Unicode project %s', project => {
        expect(findProjectMatches(`Task #${project}`)).toEqual([
            { text: `#${project}`, index: 5, length: project.length + 1, type: 'project' },
        ]);
    });

    it.each(['Learn C#development', 'Task \\#Work'])('requires a project token boundary: %s', text => {
        expect(findProjectMatches(text, ['development', 'Work'])).toEqual([]);
    });

    it('matches single-word project tags', () => {
        const matches = findProjectMatches('buy milk #forge');
        expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toBe('#forge');
		expect(matches[0]?.index).toBe(9);
    });

    it('matches known multi-word projects', () => {
        const matches = findProjectMatches('task #my project done', ['my project']);
        expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toBe('#my project');
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
		expect(matches[0]?.text).toBe('!');
    });
});

describe('findLinkMatches', () => {
    it('finds markdown links with safe URLs', () => {
        const matches = findLinkMatches('click [here](https://example.com)');
        expect(matches).toHaveLength(1);
		expect(matches[0]?.type).toBe('link');
		expect(matches[0]?.linkText).toBe('here');
		expect(matches[0]?.linkUrl).toBe('https://example.com');
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
    type MockNode = {
        nodeType: number;
        nodeName: string;
        textContent: string;
        childNodes: MockNode[];
        hasAttribute?: (name: string) => boolean;
        getAttribute?: (name: string) => string | null;
    };

    beforeAll(() => {
        if (typeof globalThis.Node === 'undefined') {
            vi.stubGlobal('Node', { TEXT_NODE: 3, ELEMENT_NODE: 1 });
        }
    });

    function textNode(content: string): MockNode {
        return { nodeType: TEXT_NODE, nodeName: '#text', textContent: content, childNodes: [] };
    }

    function elementNode(tag: string, children: MockNode[], attrs: Record<string, string> = {}): MockNode {
        return {
            nodeType: ELEMENT_NODE,
            nodeName: tag.toUpperCase(),
            textContent: children.map((child) => child.textContent).join(''),
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

    it('preserves bare URLs when reading editor text for autocomplete', () => {
        const root = elementNode('div', [elementNode('a', [textNode('https://example.com')], {
            'data-markdown-link': 'true', 'data-direct-link': 'true', href: 'https://example.com',
        })]);
        expect(getPlainText(root as unknown as HTMLElement)).toBe('https://example.com');
    });

    it('extracts plain text from regular elements', () => {
        const root = elementNode('div', [
            textNode('just '),
            elementNode('span', [textNode('plain')]),
            textNode(' text'),
        ]);
        expect(getPlainText(root as unknown as HTMLElement)).toBe('just plain text');
    });

    it('preserves a project marker split from its visible label', () => {
        const root = elementNode('div', [
            elementNode('span', [
                elementNode('span', [textNode('#')]),
                textNode('Crate Demo'),
            ]),
        ]);

        expect(getPlainText(root as unknown as HTMLElement)).toBe('#Crate Demo');
    });

});
