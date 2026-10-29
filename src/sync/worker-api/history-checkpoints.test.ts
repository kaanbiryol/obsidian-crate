import { expect, it, vi } from 'vitest';
import { SharedHistoryApi } from './history-checkpoints';
import { SHARED_CHECKPOINT_CAPABILITY } from '../../protocol/history-checkpoints';
import { HttpError } from './http';
import { HistoryVersionUnavailableError } from '../history/source';
const checkpoint = { id: '12345678-1234-1234-1234-123456789012', sequence: 5, timestamp: '2026-09-20T10:00:00Z', expiresAt: Date.parse('2026-10-20T10:00:00Z'), fileCount: 0 };
function harness(capabilities = [SHARED_CHECKPOINT_CAPABILITY]) {
	const http = { getServerInfo: vi.fn(async () => ({ capabilities })), requestJson: vi.fn(), requestBinary: vi.fn() };
	return { http, api: new SharedHistoryApi(http as never) };
}
it('validates shared history instead of accepting incomplete inventories', async () => {
	const { http, api } = harness();
	http.requestJson.mockResolvedValue({ version: 1, checkpoint: { ...checkpoint, fileCount: 1 }, files: {} });
	await expect(api.load(checkpoint.id)).rejects.toThrow('Incomplete');
	http.requestJson.mockResolvedValue({ version: 1, checkpoint, files: {} });
	await expect(api.load('different')).rejects.toThrow('different checkpoint');
});
it('checks downloaded size and hash before a restore can apply bytes', async () => {
	const { http, api } = harness();
	http.requestBinary.mockResolvedValue({ body: new TextEncoder().encode('bad').buffer });
	await expect(api.download(checkpoint.id, 'note.md', { hash: 'a'.repeat(64), revision: 'key', size: 3, modified: '2026-09-20' })).rejects.toThrow('integrity');
});
it('reports a file version the server no longer keeps, but not an expired checkpoint, as unavailable', async () => {
	const { http, api } = harness();
	const file = { hash: 'a'.repeat(64), revision: 'key', size: 3, modified: '2026-09-20' };
	http.requestBinary.mockRejectedValueOnce(new HttpError('A file version required by this checkpoint is no longer available.', 410, null, 'version_unavailable'));
	await expect(api.download(checkpoint.id, 'note.md', file)).rejects.toBeInstanceOf(HistoryVersionUnavailableError);
	http.requestBinary.mockRejectedValueOnce(new HttpError('This shared checkpoint expired or was replaced.', 410));
	await expect(api.download(checkpoint.id, 'note.md', file)).rejects.toBeInstanceOf(HttpError);
});
