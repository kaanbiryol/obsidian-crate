import { expect, it } from 'vitest';
import { encodeCheckpoint, parseCheckpoint, sameCheckpointRecoveryState, type ManifestCheckpoint } from './manifest-checkpoint';

const operationId = 'e1_00020000_11111111-1111-1111-1111-111111111111';
const otherOperationId = 'e1_00020000_22222222-2222-2222-2222-222222222222';
const hash = 'a'.repeat(64);

function checkpoint(): ManifestCheckpoint {
	return {
		manifest: { version: 1, files: Object.fromEntries([
			['__proto__', { hash, size: 1, modified: '2026-01-01T00:00:00Z', revision: 'r1' }],
			['note.md', { hash, size: 1, modified: 'unverified', revision: 'r2' }],
		]), lastSeq: 42 },
		generation: 7,
		authority: 'https://crate.test',
		settledUploads: [otherOperationId, operationId],
		renames: new Map([['note.md', 'renamed.md'], ['__proto__', 'prototype.md']]),
		uploadDiagnostics: [{
			at: '2026-01-01T00:00:00Z', clientSession: '11111111-1111-1111-1111-111111111111',
			operationId, kind: 'merge', phase: 'checkpointed', generation: 7,
			pathHash: hash, uploadHash: hash, baseHash: hash, appliedHash: hash,
		}],
		restoreIntents: [{
			request: { operationId, path: 'note.md', storageKey: 'retained-version', expectedHash: hash, expectedRevision: 'r2' },
			version: { path: 'note.md', storage_key: 'retained-version', hash, size: 1,
				expires_at: 2_000_000_000_000, created_at: '2026-01-01T00:00:00Z', reason: 'replaced' },
			phase: 'committed',
			encryptedWire: { vaultId: 'vault-id', generation: 2, path: 'aaaaaaaaaaaaaaaaaaaaaaaaaa.md', expectedHash: hash, restoredHash: hash },
		}],
		initialConfigPull: { configDir: '.obsidian', files: { '.obsidian/app.json': hash } },
		initialImportToken: '33333333-3333-4333-8333-333333333333',
	};
}

it('round-trips every recovery field, diagnostic and literal filename without changing order', () => {
	const saved = checkpoint();
	const restored = parseCheckpoint(JSON.parse(encodeCheckpoint(saved)));
	expect(restored).toEqual(saved);
	expect(Object.keys(restored.manifest.files)).toEqual(['__proto__', 'note.md']);
	expect([...restored.renames]).toEqual([...saved.renames]);
	expect(restored.settledUploads).toEqual([otherOperationId, operationId]);
	// Recovery compares parsed generations, including normalized nested field order.
	const reloaded = parseCheckpoint(JSON.parse(encodeCheckpoint(restored)));
	expect(sameCheckpointRecoveryState(restored, reloaded)).toBe(true);
	expect(JSON.parse(encodeCheckpoint(restored))).toMatchObject({ version: 1 });
});

it.each([1])('reads checkpoint version %i and retains empty-field omission rules when encoding', version => {
	const saved = { version, files: {}, generation: 1 };
	const parsed = parseCheckpoint(saved);
	expect(JSON.parse(encodeCheckpoint(parsed))).toEqual({ ...saved, version: 1 });
	expect(parsed.settledUploads).toEqual([]);
	expect(parsed.renames.size).toBe(0);
	expect(parsed.restoreIntents).toEqual([]);
});

it('keeps receipt and rename ordering significant for recovery comparison', () => {
	const saved = checkpoint();
	expect(sameCheckpointRecoveryState(saved, { ...saved, settledUploads: [...saved.settledUploads].reverse() })).toBe(false);
	expect(sameCheckpointRecoveryState(saved, { ...saved, renames: new Map([...saved.renames].reverse()) })).toBe(false);
});

it('does not use generation or diagnostic differences to compare recovery contents', () => {
	const saved = checkpoint();
	expect(sameCheckpointRecoveryState(saved, { ...saved, generation: 8, uploadDiagnostics: [] })).toBe(true);
});
