import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { renderHook } from '../../test/react-hooks';
import { loadReadingArticle } from './api';
import { cacheReadingArticle, readReadingArticle, removeReadingArticle, type ReadingCache } from './storage/storage';
import { READING_SESSION_KEY, type ReadingSession } from './session/session';
import { AUTH_TOKEN_KEY } from '../config';
import { useReadingArticle } from './useReadingArticle';

vi.mock('./session/encryption-session', () => ({ prepareReadingEncryption: vi.fn(async () => null), readingEncryptionKeys: () => null, readingNoteFolder: ({ folderPath }: { folderPath: string }) => folderPath, readingEncryptionHeaders: () => ({}) }));
vi.mock('./storage/storage', async importOriginal => ({
	...await importOriginal<typeof import('./storage/storage')>(),
	readReadingArticle: vi.fn(), cacheReadingArticle: vi.fn(async () => true), removeReadingArticle: vi.fn(async () => {}),
}));
vi.mock('./storage/article-history', () => ({
	openReadingArticleHistory: async (id: string) => {
		location.href = `https://example.test/notifications?section=reading&item=${id}`;
		return 'article-stack';
	},
	hasReadingArticleHistory: () => true,
	dismissReadingArticleHistory: vi.fn(),
}));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'one', folderPath: 'Reading', expiresAt: 1 };
const item: ReadingItem = { crate_reading_version: 1, crate_reading_id: '12345678-1234-4123-8123-123456789abc',
	title: 'Saved article', path: 'Reading/article.md', source_url: 'https://example.test/article',
	saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' };
const saved = { item, markdown: 'Verified saved article.', usedAt: 1 };
const network = vi.fn<typeof fetch>();
const reportSessionError = vi.fn();
const malformed = [
	{ reason: 'non-text Markdown', value: { item, markdown: { text: 'Unreadable' } } },
	{ reason: 'a different article ID', value: { item: { ...item, crate_reading_id: '87654321-1234-4123-8123-123456789abc' }, markdown: 'Wrong article.' } },
	{ reason: 'a path outside the folder', value: { item: { ...item, path: 'Other/article.md' }, markdown: 'Wrong folder.' } },
];

beforeEach(() => {
	vi.clearAllMocks(); network.mockReset();
	vi.mocked(readReadingArticle).mockReset().mockResolvedValue(saved);
	vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(session) : key === AUTH_TOKEN_KEY ? session.token : null });
	vi.stubGlobal('location', { href: 'https://example.test/notifications?section=reading' });
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('fetch', network);
	vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

function harness() {
	let cache: ReadingCache = { items: [item], issues: [], savedAt: 1 };
	const hook = renderHook(() => useReadingArticle({ session, cache, pending: [], isCurrentSession: () => true,
		reportSessionError, run: async action => action() }));
	return { hook, update: (next: ReadingItem) => { cache = { ...cache, items: [next] }; hook.rerender(); } };
}

it('loads a validated live article without changing its content', async () => {
	const article = { item, markdown: 'A complete online article.' };
	network.mockResolvedValue(Response.json(article));
	await expect(loadReadingArticle(session, item.crate_reading_id)).resolves.toEqual(article);
	expect(network.mock.calls[0]?.[0]).toBe(`/reading/item?id=${item.crate_reading_id}`);
});

it.each(malformed)('keeps the saved reader and offline copy when opening receives $reason', async ({ value }) => {
	network.mockResolvedValue(Response.json(value));
	const { hook } = harness();
	await act(async () => { await hook.current.open(item); });
	expect(hook.current.reader).toMatchObject({ item, markdown: saved.markdown, availableOffline: true });
	expect(cacheReadingArticle).not.toHaveBeenCalled();
	expect(reportSessionError).toHaveBeenLastCalledWith(session, 'Showing saved copy. Reading article response is unreadable.');
});

it.each(malformed)('keeps confirmed text and cache when a background refresh receives $reason', async ({ value }) => {
	network.mockResolvedValueOnce(Response.json({ item, markdown: 'Confirmed online text.' }));
	const { hook, update } = harness();
	await act(async () => { await hook.current.open(item); });
	expect(hook.current.reader?.markdown).toBe('Confirmed online text.');
	expect(cacheReadingArticle).toHaveBeenCalledOnce();
	vi.mocked(cacheReadingArticle).mockClear();
	network.mockResolvedValueOnce(Response.json(value));
	await act(async () => { update({ ...item, extraction_status: 'pending' }); });
	expect(network).toHaveBeenCalledTimes(2);
	expect(hook.current.reader?.markdown).toBe('Confirmed online text.');
	expect(cacheReadingArticle).not.toHaveBeenCalled();
	expect(reportSessionError).toHaveBeenLastCalledWith(session, 'Reading article response is unreadable.');
});

it('shows a load error without publishing invalid Markdown when no saved copy exists', async () => {
	vi.mocked(readReadingArticle).mockResolvedValue(undefined);
	network.mockResolvedValue(Response.json(malformed[0]!.value));
	const { hook } = harness();
	await act(async () => { await hook.current.open(item); });
	expect(hook.current.reader).toMatchObject({ item, markdown: null, availableOffline: false, error: 'Reading article response is unreadable.' });
	expect(cacheReadingArticle).not.toHaveBeenCalled();
});

it('downloads an article with a stale offline copy once', async () => {
	// The offline copy predates the extraction the library now reports.
	vi.mocked(readReadingArticle).mockResolvedValue({ ...saved, item: { ...item, extraction_status: 'pending' } });
	let respond!: (response: Response) => void;
	network.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
	const { hook } = harness();
	let opened!: Promise<void>;
	await act(async () => { opened = hook.current.open(item); });
	expect(hook.current.reader).toMatchObject({ markdown: saved.markdown, availableOffline: true });
	// Before: the stale copy's highlights also started a background refresh, a second download.
	expect(network).toHaveBeenCalledOnce();
	await act(async () => { respond(Response.json({ item, markdown: 'Current online text.' })); await opened; });
	expect(hook.current.reader).toMatchObject({ markdown: 'Current online text.' });
	expect(network).toHaveBeenCalledOnce();
});

it('keeps a saved copy the server reports unchanged, without downloading its body', async () => {
	vi.mocked(readReadingArticle).mockResolvedValue({ ...saved, etag: '"current"' });
	network.mockResolvedValue(new Response(null, { status: 304, headers: { ETag: '"current"' } }));
	const { hook } = harness();
	await act(async () => { await hook.current.open(item); });
	expect(new Headers(network.mock.calls[0]![1]!.headers).get('If-None-Match')).toBe('"current"');
	expect(hook.current.reader).toMatchObject({ item, markdown: saved.markdown, availableOffline: true });
	// An unchanged copy is not written again.
	expect(cacheReadingArticle).not.toHaveBeenCalled();
	expect(reportSessionError).toHaveBeenLastCalledWith(session, null);
});

it('keeps an opened article only in memory until it is saved for offline, with its ETag', async () => {
	vi.mocked(readReadingArticle).mockResolvedValue(undefined);
	network.mockResolvedValue(Response.json({ item, markdown: 'Online text.' }, { headers: { ETag: '"revision"' } }));
	const { hook } = harness();
	await act(async () => { await hook.current.open(item); });
	expect(new Headers(network.mock.calls[0]![1]!.headers).has('If-None-Match')).toBe(false);
	// Before: every opened article was stored on the device.
	expect(cacheReadingArticle).not.toHaveBeenCalled();
	expect(hook.current.reader).toMatchObject({ markdown: 'Online text.', availableOffline: false });
	vi.mocked(cacheReadingArticle).mockResolvedValue(true);
	await act(async () => { await hook.current.setOffline(true); });
	expect(cacheReadingArticle).toHaveBeenCalledWith(session, item, 'Online text.', { etag: '"revision"' });
	expect(hook.current.reader).toMatchObject({ availableOffline: true });
	await act(async () => { await hook.current.setOffline(false); });
	expect(removeReadingArticle).toHaveBeenCalledWith(session, item.crate_reading_id);
	expect(hook.current.reader).toMatchObject({ availableOffline: false });
});

it('reports a full offline storage instead of removing another saved copy', async () => {
	vi.mocked(readReadingArticle).mockResolvedValue(undefined);
	network.mockResolvedValue(Response.json({ item, markdown: 'Online text.' }));
	const { hook } = harness();
	await act(async () => { await hook.current.open(item); });
	vi.mocked(cacheReadingArticle).mockResolvedValue(false);
	await expect(hook.current.setOffline(true)).rejects.toThrow('Offline storage is full');
	expect(hook.current.reader).toMatchObject({ availableOffline: false });
});

it('shows a saved copy already moved to an edited item instead of downloading it again', async () => {
	network.mockResolvedValueOnce(Response.json({ item, markdown: 'Confirmed online text.' }));
	const { hook, update } = harness();
	await act(async () => { await hook.current.open(item); });
	const highlighted = { ...item, highlights: [{ start: 0, end: 9, text: 'Confirmed' }] };
	// A saved highlight refreshed the offline copy before the library reported it.
	vi.mocked(readReadingArticle).mockResolvedValue({ item: highlighted, markdown: 'Confirmed online text.', usedAt: 1, etag: '"new"' });
	await act(async () => { update(highlighted); });
	expect(network).toHaveBeenCalledOnce();
	expect(hook.current.reader).toMatchObject({ item: highlighted, markdown: 'Confirmed online text.', availableOffline: true });
});
