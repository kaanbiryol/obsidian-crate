import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { renderHook } from '../../test/react-hooks';
import { queueReading } from './outbox';
import type { ReadingSession } from './storage';
import { useReadingMutations } from './useReadingMutations';

vi.mock('./outbox', () => ({ queueReading: vi.fn() }));
vi.mock('./storage', () => ({ assertReadingSession: vi.fn(), removeReadingShare: vi.fn() }));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const item = (index: number, url = `https://example.com/${index}`): ReadingItem => ({
	crate_reading_version: 1, crate_reading_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Article ${index}`,
	source_url: url, saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', path: `Reading/${index}.md`,
});

function setup(items: ReadingItem[], url: string) {
	const showToast = vi.fn();
	const refresh = vi.fn(async () => {});
	const connection = {
		session, cache: { items, issues: [], cursor: null }, pending: [], url, share: null,
		run: vi.fn((work: () => Promise<void>) => work()), isCurrentSession: () => true,
		publishPending: vi.fn(), reportSessionError: vi.fn(), finishCapture: () => true,
	} as unknown as Parameters<typeof useReadingMutations>[0];
	const hook = renderHook(() => useReadingMutations(connection, { refresh, showToast }), () => vi.stubGlobal('navigator', { onLine: true }));
	return { hook, showToast };
}

beforeEach(() => { vi.mocked(queueReading).mockReset(); });

describe('reading mutations', () => {
	it('opens an already saved link instead of capturing it again', async () => {
		const saved = item(1, 'https://example.com/article');
		const { hook, showToast } = setup([saved], 'https://example.com/article');
		const openSaved = vi.fn(async () => {});
		await act(async () => { expect(await hook.current.saveLink(openSaved)).toBe(true); });
		expect(openSaved).toHaveBeenCalledWith(saved);
		expect(queueReading).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith('info', 'Opened your saved link');
	});

	it('refuses to choose between duplicate notes for one link', async () => {
		const { hook } = setup([item(1, 'https://example.com/article'), item(2, 'https://example.com/article')], 'https://example.com/article');
		await act(async () => {
			await expect(hook.current.saveLink(async () => {})).rejects.toThrow('Several notes save this link');
		});
		expect(queueReading).not.toHaveBeenCalled();
	});

	it('blocks app updates until a new link is durably queued', async () => {
		let finish!: () => void;
		vi.mocked(queueReading).mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as never); }));
		const { hook, showToast } = setup([], 'https://example.com/new');
		let saving!: Promise<boolean>;
		act(() => { saving = hook.current.saveLink(async () => {}); });
		expect(hook.current.canApplyUpdate()).toBe(false);
		await act(async () => { finish(); expect(await saving).toBe(true); });
		expect(hook.current.canApplyUpdate()).toBe(true);
		expect(queueReading).toHaveBeenCalledWith(session, { action: 'capture', intent: { url: 'https://example.com/new', fetchArticle: true } });
		expect(showToast).toHaveBeenCalledWith('success', 'Link saved');
	});

	it('reports a change that could not be queued on this device', async () => {
		vi.mocked(queueReading).mockRejectedValue(new Error('Storage is full.'));
		const { hook, showToast } = setup([item(1)], '');
		await act(async () => { await expect(hook.current.retryArticle(item(1))).rejects.toThrow('Storage is full.'); });
		expect(showToast).toHaveBeenCalledWith('error', 'Storage is full.');
		expect(hook.current.canApplyUpdate()).toBe(true);
	});
});
