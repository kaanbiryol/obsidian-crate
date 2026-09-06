import { describe, expect, it } from 'vitest';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { prepareUploadFromPath, prepareUploadFromVaultFile } from './transfer-prepare';
import { HIDDEN_CONFIG_PATH, createTransferHarness } from './transfer-test-harness';

describe('transfer prepare helpers', () => {
	it('reports oversized files without reading them', async () => {
		const harness = createTransferHarness();

		await expect(prepareUploadFromVaultFile(harness.context, {
			path: 'big.bin',
			size: MAX_FILE_SIZE_BYTES + 1,
			mtime: Date.now(),
			extension: 'bin',
		})).rejects.toThrow('this file is not synced');
		expect(harness.adapter.readBinary).not.toHaveBeenCalled();
	});

	it('skips upload when manifest hash already matches', async () => {
		const harness = createTransferHarness();
		harness.adapter.readBinary.mockResolvedValue(new TextEncoder().encode('same').buffer as ArrayBuffer);
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: 4, mtime: 1 });
		harness.localManifest.hashMatches.mockReturnValue(true);

		const result = await prepareUploadFromVaultFile(harness.context, {
			path: 'notes/a.md',
			size: 4,
			mtime: 1,
			extension: 'md',
		});

		expect(result).toBeNull();
		expect(harness.localManifest.hashMatches).toHaveBeenCalled();
	});

	it('prepares text files with ArrayBuffer content and content type', async () => {
		const harness = createTransferHarness();
		const content = new TextEncoder().encode('hello world').buffer as ArrayBuffer;
		harness.adapter.readBinary.mockResolvedValue(content);
		const mtime = Date.now();
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: 11, mtime });

		const result = await prepareUploadFromVaultFile(harness.context, {
			path: 'notes/a.md',
			size: 11,
			mtime,
			extension: 'md',
		});

		expect(result?.path).toBe('notes/a.md');
		expect(result?.content).toBeInstanceOf(ArrayBuffer);
		expect(result?.contentType).toBe('text/markdown');
		expect(result?.hash).toHaveLength(64);
		expect(result).not.toHaveProperty('binary');
	});

	it('prepares binary files with raw ArrayBuffer content', async () => {
		const harness = createTransferHarness();
		const bytes = new Uint8Array([0, 255, 1]);
		harness.adapter.readBinary.mockResolvedValue(bytes.buffer);
		const mtime = Date.now();
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: 3, mtime });

		const result = await prepareUploadFromVaultFile(harness.context, {
			path: 'images/pixel.png',
			size: 3,
			mtime,
			extension: 'png',
		});

		expect(result?.path).toBe('images/pixel.png');
		expect(result?.content).toBeInstanceOf(ArrayBuffer);
		expect(result?.contentType).toBe('image/png');
		expect(result?.content.byteLength).toBe(3);
		expect(result).not.toHaveProperty('binary');
	});

	it('prepares hidden path uploads by stat + adapter read', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: 7, mtime: 123 });
		harness.adapter.readBinary.mockResolvedValue(new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer);

		const result = await prepareUploadFromPath(harness.context, HIDDEN_CONFIG_PATH);

		expect(result).toEqual(
			expect.objectContaining({
				path: HIDDEN_CONFIG_PATH,
				contentType: 'application/json',
			}),
		);
	});
});
