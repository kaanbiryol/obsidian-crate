import { describe, expect, it } from 'vitest';
import { CompactEncrypt } from 'jose/jwe/compact/encrypt';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, generateEncryptionSecret, importEncryptionSecret, type EncryptionContext } from './envelope';

const context: EncryptionContext = { vaultId: 'vault-a', scopeId: 'scope-a', objectId: 'file-a', purpose: 'file' };
const freshKey = () => importEncryptionSecret(generateEncryptionSecret());

describe('client encryption envelopes', () => {
	it('round-trips binary and empty files without a Node API', async () => {
		const key = await freshKey();
		for (const bytes of [new Uint8Array(), new Uint8Array([0, 255, 128, 10]), crypto.getRandomValues(new Uint8Array(4096))]) {
			expect(await decryptBytes(await encryptBytes(bytes, key, context), key, context)).toEqual(bytes);
		}
		expect(key.key.extractable).toBe(false);
	});

	it('uses independently randomized envelopes and preserves an exact envelope for retries', async () => {
		const key = await freshKey();
		const first = await encryptJson({ text: 'Private reminder 🔐' }, key, context);
		const second = await encryptJson({ text: 'Private reminder 🔐' }, key, context);
		expect(first).not.toBe(second);
		expect(first).not.toContain('Private reminder');
		expect(await decryptJson(first, key, context)).toEqual({ text: 'Private reminder 🔐' });
		expect(await decryptJson(first, key, context)).toEqual(await decryptJson(second, key, context));
	});

	it.each(['vaultId', 'scopeId', 'objectId', 'purpose'] as const)('rejects substitution across %s', async field => {
		const key = await freshKey();
		const sealed = await encryptJson({ text: 'private' }, key, context);
		const changed: EncryptionContext = { ...context, [field]: field === 'purpose' ? 'notification' : 'another-id' };
		await expect(decryptJson(sealed, key, changed)).rejects.toThrow();
	});

	it('rejects another secret even when an attacker reuses the key identifier', async () => {
		const key = await freshKey();
		const sealed = await encryptJson({ text: 'private' }, key, context);
		const wrong = await importEncryptionSecret({ ...generateEncryptionSecret(), id: key.id });
		await expect(decryptJson(sealed, wrong, context)).rejects.toThrow();
	});

	it.each([0, 1, 2, 3, 4])('rejects tampering with JWE segment %i', async segment => {
		const key = await freshKey();
		const sealed = await encryptJson({ text: 'private' }, key, context);
		const parts = sealed.split('.');
		const bytes = decodeBase64Url(parts[segment]!, 4096);
		bytes[0] = bytes[0]! ^ 1;
		parts[segment] = encodeBase64Url(bytes);
		await expect(decryptJson(parts.join('.'), key, context)).rejects.toThrow();
	});

	it('rejects authenticated but unsupported envelope versions', async () => {
		const key = await freshKey();
		const sealed = await new CompactEncrypt(new Uint8Array([1])).setProtectedHeader({
			alg: 'A256KW', enc: 'A256GCM', typ: 'crate-e2ee+jwe', v: 2, kid: key.id,
			vault: context.vaultId, scope: context.scopeId, object: context.objectId, purpose: context.purpose,
		}).encrypt(key.key);
		await expect(decryptBytes(sealed, key, context)).rejects.toThrow();
	});

	it('rejects malformed and noncanonical secret encodings', async () => {
		for (const secret of ['', 'AA', 'A'.repeat(42) + 'B', 'A'.repeat(43) + '=', 'A'.repeat(44)]) {
			await expect(importEncryptionSecret({ id: 'key', secret })).rejects.toThrow();
		}
	});
});
