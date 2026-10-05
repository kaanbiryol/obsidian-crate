import { beforeEach, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import type { EncryptionServerState } from '../../encryption/server-state';
import { authenticateWorkerRequest } from './auth/index';
import { handleCoordinatorRequest } from './coordinator-requests';
import { fetchWorkerRequest } from './request-handler';
import { handleAuthenticatedRoute, isAuthenticatedRouteAllowed } from './router';
import { forwardTransferRequest } from './transfer-dispatch';
import type { Env } from './types';

vi.mock('./auth/index', () => ({ authenticateWorkerRequest: vi.fn() }));
vi.mock('./router', () => ({
	handlePublicRoute: vi.fn(async () => null),
	handleAuthenticatedRoute: vi.fn(),
	isAuthenticatedRouteAllowed: vi.fn(() => true),
}));
vi.mock('./rate-limit', () => ({ limitNotificationRequest: vi.fn(async () => null) }));
vi.mock('./admission-state', () => ({ rememberAuthenticatedRequest: vi.fn() }));
vi.mock('./transfer-dispatch', () => ({ forwardTransferRequest: vi.fn() }));

const env = { DB: {} } as Env;
const authorized = { principal: { tokenId: 'device', scope: 'vault' as const }, resetGeneration: null };
function upload(protocol = String(CRATE_PLUGIN_PROTOCOL.current)) {
	return new Request('https://worker.test/sync/upload?path=note.md', {
		method: 'PUT', body: 'note', headers: { 'X-Crate-Protocol': protocol, Authorization: 'Bearer device' },
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(authenticateWorkerRequest).mockResolvedValue(authorized);
	vi.mocked(isAuthenticatedRouteAllowed).mockReturnValue(true);
});

it.each(['protocol', 'authentication', 'scope', 'encryption reset'] as const)(
	'rejects %s failures before forwarding upload bytes or dispatching a route', async failure => {
		if (failure === 'authentication') vi.mocked(authenticateWorkerRequest).mockResolvedValue({ response: new Response(null, { status: 401 }) });
		if (failure === 'scope') vi.mocked(isAuthenticatedRouteAllowed).mockReturnValue(false);
		if (failure === 'encryption reset') vi.mocked(authenticateWorkerRequest).mockResolvedValue({
			...authorized, encryption: {
				version: 1, vaultId: 'vault', keyId: 'key', generation: 1, mode: 'resetting', scopes: [],
				recovery: { version: 1, vaultId: 'vault', envelope: '' },
			} satisfies EncryptionServerState,
		});
		const response = await fetchWorkerRequest(upload(failure === 'protocol' ? 'invalid' : undefined), env);
		expect(response.status).toBe({ protocol: 428, authentication: 401, scope: 403, 'encryption reset': 423 }[failure]);
		expect(forwardTransferRequest).not.toHaveBeenCalled();
		expect(handleAuthenticatedRoute).not.toHaveBeenCalled();
		if (failure === 'protocol') expect(authenticateWorkerRequest).not.toHaveBeenCalled();
	},
);

it('reauthenticates inside the transfer queue before a revoked upload can be dispatched', async () => {
	let release!: () => void;
	let queued!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const waiting = new Promise<void>(resolve => { queued = resolve; });
	vi.mocked(forwardTransferRequest).mockImplementation((request, transferEnv, path) => {
		const target = new URL(request.url);
		target.pathname = path;
		return handleCoordinatorRequest(new Request(target, request), {} as DurableObjectState, transferEnv,
			async action => { queued(); await gate; return action(); },
			async () => { throw new Error('Unexpected reminder route'); });
	});
	const pending = fetchWorkerRequest(upload(), env);
	await waiting;
	expect(authenticateWorkerRequest).toHaveBeenCalledTimes(1);
	vi.mocked(authenticateWorkerRequest).mockResolvedValue({ response: new Response(null, { status: 401 }) });
	release();
	expect((await pending).status).toBe(401);
	expect(authenticateWorkerRequest).toHaveBeenCalledTimes(2);
	expect(forwardTransferRequest).toHaveBeenCalledTimes(1);
	expect(handleAuthenticatedRoute).not.toHaveBeenCalled();
});
