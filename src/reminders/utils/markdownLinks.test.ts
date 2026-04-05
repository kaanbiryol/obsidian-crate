import { describe, it, expect } from 'vitest';
import { parseMarkdownLinks, isSafeUrl } from './markdownLinks';

describe('parseMarkdownLinks', () => {
    it('parses a single markdown link', () => {
        const links = parseMarkdownLinks('click [here](https://example.com) now');
        expect(links).toHaveLength(1);
        expect(links[0]).toEqual({
            fullMatch: '[here](https://example.com)',
            text: 'here',
            url: 'https://example.com',
            index: 6,
        });
    });

    it('parses multiple links', () => {
        const links = parseMarkdownLinks('[a](https://a.com) and [b](https://b.com)');
        expect(links).toHaveLength(2);
        expect(links[0].text).toBe('a');
        expect(links[1].text).toBe('b');
    });

    it('returns empty array for no links', () => {
        expect(parseMarkdownLinks('plain text')).toEqual([]);
    });

    it('handles empty link text', () => {
        const links = parseMarkdownLinks('[](https://example.com)');
        expect(links).toHaveLength(1);
        expect(links[0].text).toBe('');
    });

    it('handles empty url', () => {
        const links = parseMarkdownLinks('[text]()');
        expect(links).toHaveLength(1);
        expect(links[0].url).toBe('');
    });
});

describe('isSafeUrl', () => {
    it('allows https URLs', () => {
        expect(isSafeUrl('https://example.com')).toBe(true);
    });

    it('allows http URLs', () => {
        expect(isSafeUrl('http://example.com')).toBe(true);
    });

    it('allows mailto URLs', () => {
        expect(isSafeUrl('mailto:user@example.com')).toBe(true);
    });

    it('allows obsidian URLs', () => {
        expect(isSafeUrl('obsidian://open?vault=test')).toBe(true);
    });

    it('blocks javascript URLs', () => {
        expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    });

    it('blocks data URLs', () => {
        expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    });

    it('rejects relative URLs', () => {
        expect(isSafeUrl('/path/to/file')).toBe(false);
    });

    it('rejects malformed URLs', () => {
        expect(isSafeUrl('')).toBe(false);
    });
});
