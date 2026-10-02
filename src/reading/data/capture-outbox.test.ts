import { expect, it, vi } from 'vitest';
import { parseCaptureRecord, ReadingCaptureOutbox, type CaptureStorage } from './capture-outbox';
function harness() {
	const files = new Map<string, string>();
	const storage: CaptureStorage = { list: async () => [...files.keys()], read: async key => files.get(key)!, write: async (key, value) => { files.set(key, value); }, remove: async key => { files.delete(key); } };
	const open = (authority = 'server') => new ReadingCaptureOutbox(storage, authority, 'Reading', new AbortController().signal);
	return { files, storage, open };
}
it('persists before dispatch and replays identical requests after restart or a lost response', async () => {
	const h = harness(), item = await h.open().add('https://example.com/page', 'A title');
	expect(item.path).toBe(''); expect(h.files.size).toBe(1);
	const send = vi.fn().mockRejectedValueOnce(new Error('Lost response')).mockResolvedValue({ saved: true });
	await expect(h.open().drain([], send)).rejects.toThrow('Lost response');
	await h.open().drain([], send);
	expect(send.mock.calls[0]).toEqual(send.mock.calls[1]); expect(h.files.size).toBe(1);
	await h.open().drain([{ ...item, path: 'Reading/A title - 12345678.md' }], send);
	expect(h.files.size).toBe(0); expect(send).toHaveBeenCalledTimes(2);
});
it('retains damaged and differently scoped records without sending them', async () => {
	const h = harness(); await h.open().add('https://example.com');
	const send = vi.fn();
	await expect(h.open('another server').drain([], send)).rejects.toThrow('another server');
	h.files.set('broken.json', '{broken');
	await expect(h.open().drain([], send)).rejects.toThrow();
	expect(send).not.toHaveBeenCalled(); expect(h.files.size).toBe(2);
});
it('does not report a successful save when storage fails', async () => {
	const h = harness(); h.storage.write = async () => { throw new Error('Disk full'); };
	await expect(h.open().add('https://example.com')).rejects.toThrow('Disk full');
});
it('keeps exact queued requests across an authenticated address relocation', async () => {
  const h = harness(); await h.open('original authority').add('https://example.com/private');
  const raw = [...h.files.values()][0]!;
  const moved = new ReadingCaptureOutbox(h.storage, 'new authority', 'Reading', new AbortController().signal, ['original authority']);
  const send = vi.fn(); await moved.drain([], send);
  expect(send).toHaveBeenCalledWith(parseCaptureRecord(raw).body);
  expect([...h.files.values()]).toEqual([raw]);
  await expect(new ReadingCaptureOutbox(h.storage, 'new authority', 'Elsewhere', new AbortController().signal, ['original authority']).list()).rejects.toThrow('another server or folder');
});
