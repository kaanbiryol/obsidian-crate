import { expect, it, vi } from 'vitest';
import { SharedHistoryApi } from './history-checkpoints';
import { SHARED_CHECKPOINT_CAPABILITY } from '../../protocol/history-checkpoints';
const checkpoint = { id: '12345678-1234-1234-1234-123456789012', sequence: 5, timestamp: '2026-09-20T10:00:00Z', expiresAt: Date.parse('2026-10-20T10:00:00Z'), fileCount: 0 };
function harness(capabilities = [SHARED_CHECKPOINT_CAPABILITY]) {
    const http = { getServerInfo: vi.fn(async () => ({ capabilities })), requestJson: vi.fn(), requestBinary: vi.fn() };
    return { http, api: new SharedHistoryApi(http as never) };
}
it('preserves older-server sync while explaining that shared history needs an update', async () => {
    const { http, api } = harness([]);
    expect(await api.save()).toBeUndefined();
    await expect(api.list()).rejects.toThrow('Update');
    expect(http.requestJson).not.toHaveBeenCalled();
});
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
