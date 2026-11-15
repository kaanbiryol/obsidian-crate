import { describe, expect, it } from 'vitest';
import { assertPairingCurrent, createPairingRequester, createPairingResponder, PAIRING_LIFETIME, PairingEndedError, samePairingContext, validatePairingContext, validatePairingRecord, type PairingContext, type PairingRecord } from './protocol';

const context = (): PairingContext => ({ version: 1, id: crypto.randomUUID(), origin: 'https://crate.example', vaultId: 'vault', generation: 2 });
async function pair() {
	const requester = await createPairingRequester(context());
	const responder = await createPairingResponder(requester.request);
	const app = await requester.accept(responder.publicKey);
	const desktop = await responder.accept(app.publicKey);
	return { requester, responder, app, desktop };
}
describe('committed app key transfer', () => {
	it('agrees a verification code and authenticates encrypted packets without exposing secrets', async () => {
		const { requester, app, desktop } = await pair();
		expect(requester.request).not.toHaveProperty('publicKey');
		expect(app.code).toMatch(/^\d{4} \d{4} \d{4}$/);
		expect(app.code).toBe(desktop.code);
		const secret = { grants: ['private-folder-keys'] };
		const sealed = await desktop.seal(secret);
		expect(sealed).not.toContain('private-folder-keys');
		expect(await app.open(sealed)).toEqual(secret);
		const another = await pair();
		await expect(another.app.open(sealed)).rejects.toThrow();
		const tampered = (sealed[0] === 'A' ? 'B' : 'A') + sealed.slice(1);
		await expect(app.open(tampered)).rejects.toThrow();
	});
	it('rejects substituted requester keys against the commitment', async () => {
		const { responder } = await pair();
		const attacker = await pair();
		await expect(responder.accept(attacker.app.publicKey)).rejects.toThrow('verification');
	});
	it('pins the responder before revealing the requester key', async () => {
		const { requester } = await pair();
		const attacker = await pair();
		await expect(requester.accept(attacker.responder.publicKey)).rejects.toThrow('changed');
	});
	it.each(['origin', 'vaultId', 'id', 'generation'] as const)('binds %s into the commitment', async field => {
		const requester = await createPairingRequester(context());
		const changed = { ...requester.request, context: { ...requester.request.context, [field]: field === 'generation' ? 9 : field === 'origin' ? 'https://evil.example' : 'other' } };
		const responder = await createPairingResponder(changed);
		const app = await requester.accept(responder.publicKey);
		await expect(responder.accept(app.publicKey)).rejects.toThrow('verification');
	});
	it('bounds encoded public keys and packet size', async () => {
		const requester = await createPairingRequester(context());
		await expect(requester.accept('bad-key')).rejects.toThrow();
		const { desktop } = await pair();
		await expect(desktop.seal('x'.repeat(16001))).rejects.toThrow('large');
	});
});

describe('pairing record validation', () => {
	it.each([
		['a version 2 request', { version: 2 }],
		['an invalid request ID', { id: 'not/an-id' }],
		['an invalid vault ID', { vaultId: '' }],
		['generation 0', { generation: 0 }],
		['a fractional generation', { generation: 1.5 }],
		['a non-web origin', { origin: 'file:///vault' }],
		['an origin with a path', { origin: 'https://crate.example/app' }],
		['an origin with a trailing slash', { origin: 'https://crate.example/' }],
		['an oversized origin', { origin: `https://${'a'.repeat(2048)}.example` }],
	])('rejects a context with %s', (_, change) => {
		expect(() => validatePairingContext({ ...context(), ...change })).toThrow('Invalid app pairing request.');
	});
	it('rejects a missing context', () => {
		expect(() => validatePairingContext(null)).toThrow('Invalid app pairing request.');
		expect(() => validatePairingRecord(null)).toThrow('Invalid app pairing request.');
	});
	it('compares every context field', () => {
		const base = context();
		expect(samePairingContext(base, { ...base })).toBe(true);
		for (const change of [{ id: 'other' }, { origin: 'https://other.example' }, { vaultId: 'other' }, { generation: 3 }]) {
			expect(samePairingContext(base, { ...base, ...change })).toBe(false);
		}
	});

	const record = async (): Promise<PairingRecord> => ({ ...(await createPairingRequester(context())).request, expiresAt: Date.now() + PAIRING_LIFETIME });
	it('accepts every step a relay can return', async () => {
		const base = await record();
		const { publicKey } = await createPairingResponder(base);
		expect(() => validatePairingRecord({ ...base, responderKey: publicKey, requesterKey: publicKey, payload: 'A'.repeat(38), closed: false })).not.toThrow();
	});
	it.each([
		['a short commitment', { commitment: 'AAAA' }, 'Invalid app pairing response.'],
		['a missing commitment', { commitment: undefined }, 'Invalid app pairing response.'],
		['a fractional expiry', { expiresAt: 1.5 }, 'Invalid app pairing response.'],
		['a damaged responder key', { responderKey: 'A'.repeat(87) }, 'Invalid pairing public key.'],
		['a damaged requester key', { requesterKey: 'bad-key' }, 'Invalid pairing public key.'],
		['a truncated packet', { payload: 'A'.repeat(36) }, 'Invalid pairing packet.'],
		['a non-string packet', { payload: 7 }, 'Invalid pairing packet.'],
		['a non-boolean status', { closed: 'yes' }, 'Invalid pairing status.'],
	])('rejects a record with %s', async (_, change, message) => {
		const base = await record();
		expect(() => validatePairingRecord({ ...base, ...change })).toThrow(message);
	});

	it('ends attempts that changed, closed or outlived their deadline', async () => {
		const base = await record();
		const deadline = base.expiresAt;
		expect(() => assertPairingCurrent(base, base, deadline)).not.toThrow();
		const other = await record();
		for (const changed of [
			{ ...base, commitment: other.commitment },
			{ ...base, context: { ...base.context, generation: 3 } },
			{ ...base, closed: true },
			{ ...base, expiresAt: deadline + 1 },
			{ ...base, expiresAt: Date.now() - 1 },
		]) expect(() => assertPairingCurrent(changed, base, deadline)).toThrow(PairingEndedError);
		expect(() => assertPairingCurrent({ ...base, commitment: 'AAAA' }, base, deadline)).toThrow('Invalid app pairing response.');
	});

	it('pins the requester key on the responder and accepts the same key again', async () => {
		const requester = await createPairingRequester(context());
		const responder = await createPairingResponder(requester.request);
		const app = await requester.accept(responder.publicKey);
		const first = await responder.accept(app.publicKey);
		const again = await responder.accept(app.publicKey);
		expect(again.code).toBe(first.code);
		expect((await requester.accept(responder.publicKey)).code).toBe(app.code);
	});

	it('rejects truncated and malformed packets', async () => {
		const { app, desktop } = await pair();
		const packet = await desktop.seal({ keys: 'k' });
		await expect(app.open(packet.slice(0, 16))).rejects.toThrow();
		await expect(app.open(packet + '!')).rejects.toThrow();
	});
});
