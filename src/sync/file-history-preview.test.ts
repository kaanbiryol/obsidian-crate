import { computeHash } from './hasher';
import { expect, it, vi } from 'vitest';
import { loadFileHistoryPreview, loadCurrentSyncedPreview } from './file-history-preview';
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const version = { path: 'note.md', storage_key: 'key', hash: 'a'.repeat(64), size: 5, reason: 'replaced' as const, created_at: '2026-09-19', expires_at: 1 };
const api = () => ({ previewFileVersion: vi.fn().mockResolvedValue(bytes('saved')) });
it('compares saved text with a local snapshot without writing files', async () => {
 const adapter = { stat: vi.fn().mockResolvedValue({ type: 'file', size: 7 }), readBinary: vi.fn().mockResolvedValue(bytes('current')) };
 expect(await loadFileHistoryPreview(adapter, api(), version)).toEqual({ saved: 'saved', current: 'current' });
});
it('preserves the saved preview when the local copy is missing or unreadable', async () => {
 const adapter = { stat: vi.fn().mockResolvedValue(null), readBinary: vi.fn() };
 expect(await loadFileHistoryPreview(adapter, api(), version)).toEqual({ saved: 'saved', current: '', localMissing: true });
 adapter.stat.mockRejectedValue(new Error('Offline'));
 const preview = await loadFileHistoryPreview(adapter, api(), version);
 expect(preview.saved).toBe('saved'); expect(preview.comparisonUnavailable).toBeTypeOf('string');
});
it('does not download binary or oversized versions', async () => {
 const client = api(); const adapter = { stat: vi.fn(), readBinary: vi.fn() };
 for (const entry of [{ ...version, path: 'image.png' }, { ...version, size: 256_001 }]) {
  expect((await loadFileHistoryPreview(adapter, client, entry)).unavailable).toBeTypeOf('string');
 }
 expect(client.previewFileVersion).not.toHaveBeenCalled();
});
it('rejects binary content masquerading as text', async () => {
 const client = api(); client.previewFileVersion.mockResolvedValue(bytes('a\0b'));
 expect((await loadFileHistoryPreview({ stat: vi.fn(), readBinary: vi.fn() }, client, version)).unavailable).toBeTypeOf('string');
});

it('reads the current synced copy and verifies its bytes, hash and revision', async () => {
 const content = bytes('server'); const hash = await computeHash(content);
 const file = { hash, size: content.byteLength, revision: 'current', modified: '2026-09-19' };
 const client = { getFileMetadata: vi.fn().mockResolvedValue({ files: { 'note.md': file } }), downloadFile: vi.fn().mockResolvedValue({ content, hash, revision: 'current' }) };
 expect(await loadCurrentSyncedPreview(client, 'note.md')).toEqual({ file, text: 'server' });
 client.downloadFile.mockResolvedValue({ content, hash, revision: 'changed' });
 await expect(loadCurrentSyncedPreview(client, 'note.md')).rejects.toThrow('changed while loading');
 client.downloadFile.mockResolvedValue({ content: bytes('forged'), hash, revision: 'current' });
 await expect(loadCurrentSyncedPreview(client, 'note.md')).rejects.toThrow('changed while loading');
});
it('does not download absent, binary or oversized current files', async () => {
 const client = { getFileMetadata: vi.fn().mockResolvedValue({ files: {} }), downloadFile: vi.fn() };
 await expect(loadCurrentSyncedPreview(client, 'note.md')).rejects.toThrow('no longer on the server');
 client.getFileMetadata.mockResolvedValue({ files: { 'note.md': { size: 256_001 } } });
 expect((await loadCurrentSyncedPreview(client, 'note.md')).unavailable).toContain('too large');
 client.getFileMetadata.mockResolvedValue({ files: { 'image.png': { size: 20 } } });
 expect((await loadCurrentSyncedPreview(client, 'image.png')).unavailable).toContain('file type');
 expect(client.downloadFile).not.toHaveBeenCalled();
});
