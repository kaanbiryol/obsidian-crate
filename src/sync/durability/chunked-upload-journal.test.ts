import { expect, it, vi } from 'vitest';
import { DurableUploads } from './durable-uploads';
import { LocalManifest } from '../manifest/manifest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { sha256Hex } from '@/platform/sha256';
import type { UploadResult } from '@/protocol/sync-types';

const directory = `${TEST_PLUGIN_DIR}/pending-uploads`;
const bytes = new TextEncoder().encode('large attachment bytes').buffer;

async function fixture() {
	const disk = new PersistentTestVault();
	const create = () => new LocalManifest({ vault: disk.vault }, { dir: TEST_PLUGIN_DIR }, 'https://server.test');
	const file = { path: 'media/video.bin', hash: await sha256Hex(bytes), size: bytes.byteLength, contentType: 'application/octet-stream', expectedHash: null };
	return { disk, create, file };
}

it('saves a chunked upload\'s bytes beside its record, never as base64 in it, and replays them', async () => {
	const { disk, create, file } = await fixture();
	const manifest = create();
	const upload = await manifest.uploadJournal.prepareChunked(file, bytes, 20000);
	const record = JSON.parse(disk.text(`${directory}/${upload.operationId}.json`)) as { version: number; file: { content: string; contentFile: string } };
	expect(record).toMatchObject({ version: 1, file: { content: '', contentFile: `${upload.operationId}.bin` } });
	expect(new TextDecoder().decode(disk.read(`${directory}/${upload.operationId}.bin`))).toBe('large attachment bytes');
	await manifest.close();

	const reopened = create(); await reopened.load();
	const [pending] = reopened.uploadJournal.pending();
	expect(pending).toMatchObject({ operationId: upload.operationId, contentFile: `${upload.operationId}.bin` });
	expect(new TextDecoder().decode(await reopened.uploadJournal.readContent(pending!))).toBe('large attachment bytes');
	reopened.completeUpload(upload.operationId);
	await reopened.save();
	expect(disk.has(`${directory}/${upload.operationId}.json`)).toBe(false);
	expect(disk.has(`${directory}/${upload.operationId}.bin`)).toBe(false);
});

it('removes bytes whose record was never written and fails closed on a record without its bytes', async () => {
	const { disk, create, file } = await fixture();
	const manifest = create();
	await disk.vault.adapter.mkdir(directory);
	disk.write(`${directory}/e1_00020000_11111111-1111-4111-8111-111111111111.bin`, bytes);
	await manifest.load();
	expect(disk.has(`${directory}/e1_00020000_11111111-1111-4111-8111-111111111111.bin`)).toBe(false);

	const upload = await manifest.uploadJournal.prepareChunked(file, bytes, 20000);
	await manifest.close();
	await disk.vault.adapter.remove(`${directory}/${upload.operationId}.bin`);
	await expect(create().load()).rejects.toThrow('lost its saved bytes');
	expect(disk.has(`${directory}/${upload.operationId}.json`)).toBe(true);
});

it('refuses damaged saved bytes instead of sending them', async () => {
	const { disk, create, file } = await fixture();
	const manifest = create();
	const upload = await manifest.uploadJournal.prepareChunked(file, bytes, 20000);
	disk.write(`${directory}/${upload.operationId}.bin`, new TextEncoder().encode('large attachment bytez').buffer);
	await expect(manifest.uploadJournal.readContent(upload)).rejects.toThrow('damaged');
});

it('retries an unconfirmed chunked upload from its saved bytes under the same operation', async () => {
	const { create, file } = await fixture();
	const manifest = create();
	await manifest.load();
	const sent: Array<{ operationId: string; text: string }> = [];
	let respond: () => UploadResult = () => { throw new Error('Connection lost'); };
	const transport = {
		assertPreparedUpload: async () => {},
		getServerInfo: async () => ({ reminderOperationDay: 20000 }),
		batchUpload: vi.fn(),
		uploadFile: vi.fn(),
		uploadChunked: vi.fn(async (_path: string, content: ArrayBuffer, _hash: string, _size: number, _type: string, _expected: string | null, operationId: string) => {
			sent.push({ operationId, text: new TextDecoder().decode(content) });
			return respond();
		}),
	};
	const uploads = new DurableUploads(manifest, transport, { putBase: vi.fn(), readBase: vi.fn() } as never, '33333333-3333-4333-8333-333333333333');
	await expect(uploads.chunked(file, bytes)).rejects.toThrow('Connection lost');
	expect(manifest.uploadJournal.pending()).toHaveLength(1);
	respond = () => ({ success: true, path: file.path, hash: file.hash, revision: `__crate__/files/${file.hash}/00000000-0000-4000-8000-000000000000` });
	await uploads.recover();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toEqual(sent[0]);
	expect(manifest.uploadJournal.pending()).toEqual([]);
	expect(manifest.getEntry(file.path)).toMatchObject({ hash: file.hash, revision: `__crate__/files/${file.hash}/00000000-0000-4000-8000-000000000000` });
	expect(transport.uploadFile).not.toHaveBeenCalled();
});
