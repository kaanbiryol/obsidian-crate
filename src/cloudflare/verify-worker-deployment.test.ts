import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifyWorkerDeployment } from './verify-worker-deployment';
import release from './server-release.json';
import type { HttpTransport } from './http';

const origin = 'https://crate.example.workers.dev';
const fingerprint = 'f'.repeat(64);
const identity = { service: 'crate', serverRevision: release.revision, schemaVersion: release.schemaVersion, deploymentFingerprint: fingerprint };
const response = (changes = {}) => ({ status: 200, text: JSON.stringify({ ...identity, ...changes }) });

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('window', { setTimeout });
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('waits for an older public build to catch up, using only unauthenticated reads', async () => {
	const transport = vi.fn<HttpTransport>()
		.mockResolvedValueOnce(response({ serverRevision: release.revision - 1, deploymentFingerprint: 'a'.repeat(64) }))
		.mockResolvedValueOnce(response({ deploymentFingerprint: 'a'.repeat(64) }))
		.mockResolvedValue(response());
	const check = verifyWorkerDeployment(transport, origin, fingerprint);
	await vi.advanceTimersByTimeAsync(1999);
	expect(transport).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(2001);
	await check;
	expect(transport).toHaveBeenCalledTimes(3);
	for (const call of transport.mock.calls) expect(call).toEqual([
		`${origin}/.well-known/crate`, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } },
	]);
});

it.each([
	{ status: 404, text: '<html>Not ready</html>' },
	{ status: 503, text: 'Temporarily unavailable' },
	{ status: 200, text: 'null' },
])('recovers from a temporary public response: %j', async pending => {
	const transport = vi.fn<HttpTransport>().mockResolvedValueOnce(pending).mockResolvedValue(response());
	const check = verifyWorkerDeployment(transport, origin, fingerprint);
	await vi.runAllTimersAsync();
	await check;
	expect(transport).toHaveBeenCalledTimes(2);
});

it.each([
	{ service: 'other' }, { serverRevision: release.revision + 1 },
	{ schemaVersion: release.schemaVersion + 1 }, { deploymentFingerprint: 'a'.repeat(64) },
])('rejects a persistently mismatched deployment after bounded retries: %j', async changes => {
	const transport = vi.fn<HttpTransport>().mockResolvedValue(response(changes));
	const check = expect(verifyWorkerDeployment(transport, origin, fingerprint)).rejects.toThrow('live check after 8 attempts');
	await vi.runAllTimersAsync();
	await check;
	expect(transport).toHaveBeenCalledTimes(8);
	expect(vi.getTimerCount()).toBe(0);
});

it('reports the expected and observed build without arbitrary response contents', async () => {
	const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ serverRevision: 1, deploymentFingerprint: 'a'.repeat(64), secret: 'private-value' }));
	const check = verifyWorkerDeployment(transport, origin, fingerprint).catch((error: Error) => error.message);
	await vi.runAllTimersAsync();
	const message = await check;
	expect(message).toContain(`Expected revision ${release.revision}`);
	expect(message).toContain('Observed HTTP 200; Crate identity matched; revision 1');
	expect(message).toContain('fingerprint ' + 'a'.repeat(64));
	expect(message).not.toContain('private-value');
});

it('propagates transport cancellation without scheduling another check', async () => {
	const transport = vi.fn<HttpTransport>().mockRejectedValue(new DOMException('Plugin unloaded', 'AbortError'));
	await expect(verifyWorkerDeployment(transport, origin, fingerprint)).rejects.toThrow('Plugin unloaded');
	expect(transport).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});

it('verifies a published older release only against its exact fingerprint and the supported schema', async () => {
	const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ serverRevision: release.revision - 1 }));
	await expect(verifyWorkerDeployment(transport, origin, fingerprint, true)).resolves.toEqual({ revision: release.revision - 1, schemaVersion: release.schemaVersion });
});

it.each([{ serverRevision: release.revision + 1 }, { serverRevision: 0 }, { schemaVersion: release.schemaVersion + 1 }, { deploymentFingerprint: 'a'.repeat(64) }])('rejects an incompatible published release: %j', async changes => {
	const transport = vi.fn<HttpTransport>().mockResolvedValue(response(changes));
	const check = expect(verifyWorkerDeployment(transport, origin, fingerprint, true)).rejects.toThrow('live check');
	await vi.runAllTimersAsync();
	await check;
});
