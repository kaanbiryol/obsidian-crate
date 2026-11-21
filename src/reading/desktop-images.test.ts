import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestUrl, TFile, TFolder, type Vault } from 'obsidian';
import { saveDesktopArticleImages } from './desktop-images';

vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<typeof import('obsidian')>(), requestUrl: vi.fn() }));
beforeEach(() => { vi.stubGlobal('window', { setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay), clearTimeout: (id: number) => clearTimeout(id) }); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const id = '0cf86c65-51e2-4e2b-8987-0a4732473588';
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
const response = (body: Uint8Array | string, status = 200, headers: Record<string, string> = {}) => {
	const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
	return { status, headers, arrayBuffer: bytes.slice().buffer };
};
function vault(existing: string[] = []) {
	const entries = new Map<string, TFile | TFolder>(existing.map(path => [path, Object.assign(new TFile(), { path })]));
	const writes: Array<{ path: string; bytes: number[] }> = [];
	const fake = {
		getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
		createFolder: vi.fn(async (path: string) => { entries.set(path, Object.assign(new TFolder(), { path, children: [] })); }),
		createBinary: vi.fn(async (path: string, data: ArrayBuffer) => { entries.set(path, Object.assign(new TFile(), { path })); writes.push({ path, bytes: [...new Uint8Array(data)] }); }),
		modifyBinary: vi.fn(async (file: TFile, data: ArrayBuffer) => { writes.push({ path: file.path, bytes: [...new Uint8Array(data)] }); }),
	};
	return { vault: fake as unknown as Vault, fake, writes };
}
const article = { markdown: 'Text\n\n![Chart](https://cdn.example/chart.png)\n\n![Page](https://cdn.example/page.html)\n\n![Cut](https://cdn.example/cut.png)\n' };

it('writes images before the note links them and keeps the link of anything it could not store', async () => {
	vi.mocked(requestUrl).mockImplementation((async ({ url }: { url: string }) => url.endsWith('chart.png') ? response(png)
		: url.endsWith('cut.png') ? response(png.slice(0, 4), 206, { 'Content-Range': 'bytes 0-3/9' }) : response('<html>')) as never);
	const { vault: target, fake, writes } = vault();
	const saved = await saveDesktopArticleImages(article, { vault: target, folder: 'Reading', id, signal: new AbortController().signal, allowed: () => true });
	expect(writes).toEqual([{ path: `Reading/attachments/${id}/1.png`, bytes: [...png] }]);
	expect(fake.createFolder.mock.calls.map(call => call[0])).toEqual(['Reading', 'Reading/attachments', `Reading/attachments/${id}`]);
	expect(saved.markdown).toBe(`Text\n\n![Chart](attachments/${id}/1.png)\n\n![Page](https://cdn.example/page.html)\n\n![Cut](https://cdn.example/cut.png)\n`);
	expect(vi.mocked(requestUrl).mock.calls[0]![0]).toMatchObject({ method: 'GET', headers: { Range: `bytes=0-${10 * 1024 * 1024}` } });
});

it('replaces a copy an earlier attempt left and stores nothing outside synced folders', async () => {
	vi.mocked(requestUrl).mockResolvedValue(response(png) as never);
	const retry = vault([`Reading/attachments/${id}/1.png`]);
	await saveDesktopArticleImages(article, { vault: retry.vault, folder: 'Reading', id, signal: new AbortController().signal, allowed: () => true });
	expect(retry.fake.modifyBinary).toHaveBeenCalledTimes(1);
	const excluded = vault();
	const saved = await saveDesktopArticleImages(article, { vault: excluded.vault, folder: 'Reading', id, signal: new AbortController().signal, allowed: () => false });
	expect(excluded.writes).toEqual([]);
	expect(saved).toEqual(article);
});
