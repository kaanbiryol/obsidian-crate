import { expect, it } from 'vitest';
import { sourceIconUrl } from './ReadingSourceIcon';
import type { ReadingMetadata } from '../core/model';

const item = { source_url: 'https://example.com/essay' } as ReadingMetadata;

it('uses a declared favicon or the site root for older and clipped notes', () => {
	expect(sourceIconUrl(item)).toBe('https://example.com/favicon.ico');
	expect(sourceIconUrl({ ...item, favicon_url: 'https://cdn.example.com/icon.png' })).toBe('https://cdn.example.com/icon.png');
	expect(sourceIconUrl({ ...item, resolved_url: 'https://publisher.example.org/essay' })).toBe('https://publisher.example.org/favicon.ico');
	expect(sourceIconUrl({ ...item, favicon_url: 'data:image/png,AAA' })).toBe('https://example.com/favicon.ico');
});

it('does not request local domains', () => {
	expect(sourceIconUrl({ ...item, source_url: 'http://localhost/read' })).toBeNull();
});
