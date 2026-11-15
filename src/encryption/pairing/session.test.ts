import { describe, expect, it } from 'vitest';
import { PAIRING_LIFETIME, PairingEndedError, type PairingContext, type PairingRecord, type PairingTransport } from './protocol';
import { answerAppPairing, requestAppPairing } from './session';

const context = (): PairingContext => ({ version: 1, id: crypto.randomUUID(), origin: 'https://crate.example', vaultId: 'vault', generation: 2 });
const ok = () => undefined;

/** An in-memory relay with the Worker's step semantics, shared by both peers. Tests
 * reach into `row` to play a misbehaving or malicious relay. */
function relay() {
	const state: { row?: PairingRecord; writes: Record<string, unknown>[]; fail: ((body: Record<string, unknown>) => Error | undefined)[] } = { writes: [], fail: [] };
	const view = () => structuredClone(state.row!);
	const transport: PairingTransport = {
		read() { return Promise.resolve({ requests: state.row ? [view()] : [] }); },
		write(body) {
			state.writes.push(structuredClone(body));
			const failure = state.fail.shift()?.(body);
			if (failure) return Promise.reject(failure);
			if (body.action === 'start') state.row ??= { context: body.context as PairingContext, commitment: body.commitment as string, expiresAt: Date.now() + PAIRING_LIFETIME };
			else if (body.action === 'accept') state.row!.responderKey ??= body.key as string;
			else if (body.action === 'reveal') state.row!.requesterKey = body.key as string;
			else if (body.action === 'approve') state.row!.payload = body.payload as string;
			else { state.row!.closed = true; delete state.row!.payload; }
			return Promise.resolve({ request: view() });
		},
	};
	return { state, transport, actions: () => state.writes.map(write => write.action) };
}

async function paired() {
	const net = relay();
	const app = await requestAppPairing(context(), net.transport, ok);
	const desktop = await answerAppPairing((await net.transport.read()).requests[0]!, net.transport, ok);
	return { net, app, desktop };
}

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code });

describe('app pairing sessions', () => {
	it('transfers an approved payload only after both peers derive the same code', async () => {
		const net = relay();
		const app = await requestAppPairing(context(), net.transport, ok);
		expect(app.expiresAt).toBe(net.state.row!.expiresAt);
		expect(await app.poll()).toEqual({});
		const desktop = await answerAppPairing((await net.transport.read()).requests[0]!, net.transport, ok);
		expect(await desktop.poll()).toBeUndefined();
		await expect(desktop.approve({ keys: 'private-vault-keys' })).rejects.toThrow('Wait for the verification code.');
		const { code } = await app.poll();
		expect(code).toMatch(/^\d{4} \d{4} \d{4}$/);
		expect(await desktop.poll()).toBe(code);
		await desktop.approve({ keys: 'private-vault-keys' });
		expect(net.state.row!.payload).not.toContain('private-vault-keys');
		expect(await app.poll()).toEqual({ code, payload: { keys: 'private-vault-keys' } });
		await app.close(true);
		expect(net.actions()).toEqual(['start', 'accept', 'reveal', 'approve', 'finish']);
		expect(net.state.row).toMatchObject({ closed: true });
		expect(net.state.row).not.toHaveProperty('payload');
	});

	it('reveals the requester key once and reuses one approval packet across retries', async () => {
		const { net, app, desktop } = await paired();
		await app.poll();
		await app.poll();
		expect(net.actions().filter(action => action === 'reveal')).toHaveLength(1);
		await desktop.poll();
		net.state.fail.push(() => status(503));
		await expect(desktop.approve({ keys: 'k' })).rejects.toThrow('HTTP 503');
		await desktop.approve({ keys: 'k' });
		const packets = net.state.writes.filter(write => write.action === 'approve').map(write => write.payload);
		expect(packets).toHaveLength(2);
		expect(packets[1]).toBe(packets[0]);
	});

	it('retries a lost opening response once with the same commitment and key', async () => {
		const net = relay();
		net.state.fail.push(() => new Error('network'));
		const app = await requestAppPairing(context(), net.transport, ok);
		const starts = net.state.writes.filter(write => write.action === 'start');
		expect(starts).toHaveLength(2);
		expect(starts[1]).toEqual(starts[0]);
		net.state.fail.push(() => status(502));
		await answerAppPairing((await net.transport.read()).requests[0]!, net.transport, ok);
		const accepts = net.state.writes.filter(write => write.action === 'accept');
		expect(accepts).toHaveLength(2);
		expect(accepts[1]).toEqual(accepts[0]);
		expect((await app.poll()).code).toMatch(/^\d{4} \d{4} \d{4}$/);
	});

	it('surfaces definitive rejections and second failures instead of retrying', async () => {
		const rejected = relay();
		rejected.state.fail.push(() => status(429));
		await expect(requestAppPairing(context(), rejected.transport, ok)).rejects.toThrow('HTTP 429');
		expect(rejected.actions()).toEqual(['start']);
		const twice = relay();
		twice.state.fail.push(() => status(500), () => status(500));
		await expect(requestAppPairing(context(), twice.transport, ok)).rejects.toThrow('HTTP 500');
		expect(twice.actions()).toEqual(['start', 'start']);
	});

	it('does not retry or write after the screen has been fenced', async () => {
		const net = relay();
		let fenced = false;
		const current = () => { if (fenced) throw new Error('fenced'); };
		net.state.fail.push(() => { fenced = true; return new Error('network'); });
		await expect(requestAppPairing(context(), net.transport, current)).rejects.toThrow('fenced');
		expect(net.actions()).toEqual(['start']);

		fenced = false;
		const later = relay();
		const app = await requestAppPairing(context(), later.transport, current);
		await answerAppPairing((await later.transport.read()).requests[0]!, later.transport, ok);
		fenced = true;
		await expect(app.poll()).rejects.toThrow('fenced');
		await expect(app.close()).rejects.toThrow('fenced');
		expect(later.actions()).toEqual(['start', 'accept']);
	});

	it('ends both sessions when the relay forgets, closes or expires the request', async () => {
		const gone = await paired();
		delete gone.net.state.row;
		await expect(gone.app.poll()).rejects.toBeInstanceOf(PairingEndedError);
		await expect(gone.desktop.poll()).rejects.toBeInstanceOf(PairingEndedError);
		const closed = await paired();
		closed.net.state.row!.closed = true;
		await expect(closed.app.poll()).rejects.toBeInstanceOf(PairingEndedError);
		await expect(closed.desktop.poll()).rejects.toBeInstanceOf(PairingEndedError);
		const extended = await paired();
		extended.net.state.row!.expiresAt += 60_000;
		await expect(extended.app.poll()).rejects.toBeInstanceOf(PairingEndedError);
		await expect(extended.desktop.poll()).rejects.toBeInstanceOf(PairingEndedError);
	});

	it('refuses a relay that answers the opening with another request', async () => {
		const net = relay();
		net.state.row = { context: context(), commitment: 'A'.repeat(43), expiresAt: Date.now() + PAIRING_LIFETIME };
		await expect(requestAppPairing(context(), net.transport, ok)).rejects.toBeInstanceOf(PairingEndedError);
		const late = relay();
		const write = late.transport.write.bind(late.transport);
		late.transport.write = async body => {
			const result = await write(body);
			result.request.expiresAt = Date.now() + PAIRING_LIFETIME + 60_000;
			return result;
		};
		await expect(requestAppPairing(context(), late.transport, ok)).rejects.toBeInstanceOf(PairingEndedError);
	});

	it('refuses a substituted responder after the app pinned the first one', async () => {
		const { net, app } = await paired();
		await app.poll();
		const intruder = await paired();
		net.state.row!.responderKey = intruder.net.state.row!.responderKey;
		await expect(app.poll()).rejects.toThrow('Pairing device changed. Start again.');
	});

	it('refuses a requester key the app did not reveal', async () => {
		const { net, app } = await paired();
		const intruder = await paired();
		await intruder.app.poll();
		net.state.row!.requesterKey = intruder.net.state.row!.requesterKey;
		await expect(app.poll()).rejects.toThrow('Pairing verification failed. Start again.');
	});

	it('refuses a packet that arrives before the reveal is recorded', async () => {
		const { net, app } = await paired();
		const reveal = net.transport.write.bind(net.transport);
		net.transport.write = async body => body.action === 'reveal' ? { request: structuredClone(net.state.row!) } : reveal(body);
		net.state.row!.payload = 'A'.repeat(40);
		await expect(app.poll()).rejects.toThrow('Pairing verification failed. Start again.');
	});

	it('rejects a tampered or foreign approval packet', async () => {
		const { net, app, desktop } = await paired();
		await app.poll();
		await desktop.poll();
		await desktop.approve({ keys: 'k' });
		const packet = net.state.row!.payload!;
		net.state.row!.payload = packet.slice(0, 30) + (packet[30] === 'A' ? 'B' : 'A') + packet.slice(31);
		await expect(app.poll()).rejects.toThrow();
		const other = await paired();
		await other.app.poll();
		await other.desktop.poll();
		await other.desktop.approve({ keys: 'other' });
		net.state.row!.payload = other.net.state.row!.payload;
		await expect(app.poll()).rejects.toThrow();
	});

	it('answers only fresh requests and only when this device won the accept', async () => {
		const net = relay();
		await requestAppPairing(context(), net.transport, ok);
		const fresh = (await net.transport.read()).requests[0]!;
		const intruder = await paired();
		for (const field of ['responderKey', 'requesterKey'] as const) {
			await expect(answerAppPairing({ ...fresh, [field]: intruder.net.state.row!.responderKey }, net.transport, ok)).rejects.toThrow('Start a fresh pairing request in the app.');
		}
		await expect(answerAppPairing({ ...fresh, payload: 'A'.repeat(40) }, net.transport, ok)).rejects.toThrow('Start a fresh pairing request in the app.');
		await answerAppPairing(fresh, net.transport, ok);
		await expect(answerAppPairing(fresh, net.transport, ok)).rejects.toThrow('Another device accepted this request.');
	});

	it('refuses a changed responder or requester on the approving device', async () => {
		const responder = await paired();
		const intruder = await paired();
		await intruder.app.poll();
		responder.net.state.row!.responderKey = intruder.net.state.row!.responderKey;
		await expect(responder.desktop.poll()).rejects.toThrow('Pairing device changed. Start again.');

		const requester = await paired();
		await requester.app.poll();
		await requester.desktop.poll();
		requester.net.state.row!.requesterKey = intruder.net.state.row!.requesterKey;
		await expect(requester.desktop.poll()).rejects.toThrow('Pairing device changed. Start again.');
		await expect(requester.desktop.approve({ keys: 'k' })).rejects.toThrow('Pairing device changed. Start again.');
		expect(requester.net.actions()).not.toContain('approve');
	});

	it('cancels from either side', async () => {
		const { net, app, desktop } = await paired();
		await desktop.close();
		await app.close();
		expect(net.actions().slice(-2)).toEqual(['cancel', 'cancel']);
	});
});
