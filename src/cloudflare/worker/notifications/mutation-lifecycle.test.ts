import { prepareCoordinatedUpload, commitCoordinatedUpload } from '../sync/staging/staged-upload-dispatch';
import { beforeEach, expect, it, vi } from 'vitest';
import { ReminderAlarm } from '../coordinator/reminder-alarm';
import { handleAuthenticatedRoute } from '../router';
import { runMaintenanceEpisode } from '../maintenance/lifecycle';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
vi.mock('../sync/staging/staged-upload-dispatch', () => ({ prepareCoordinatedUpload: vi.fn(), commitCoordinatedUpload: vi.fn(), coordinatedUpload: vi.fn() }));
vi.mock('../router', () => ({ handleAuthenticatedRoute: vi.fn(), isAuthenticatedRouteAllowed: () => true, handlePublicRoute: vi.fn(async () => null) }));
vi.mock('../auth/index', () => ({ authenticateWorkerRequest: vi.fn(async () => ({ principal: { id: 'device', scope: 'vault' } })) }));
vi.mock('../http/request-diagnostics', () => ({ logMutation: vi.fn() }));
vi.mock('../maintenance/lifecycle', async original => ({ ...await original<typeof import('../maintenance/lifecycle')>(), runMaintenanceEpisode: vi.fn() }));
vi.mock('../encryption/state', () => ({ ENCRYPTION_STATE_SQL: '(SELECT encryption FROM server_state WHERE id = 1)', readEncryptionState: vi.fn(async () => null), EncryptionStateError: class extends Error {} }));

function fixture() {
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const storage = {
		get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => { values.set(key, value); },
		getAlarm: async () => alarm,
		setAlarm: vi.fn(async (time: number) => { alarm = time; }),
	};
	const env = { DB: {}, REMINDER_ALARMS: { idFromName: () => 'maintenance', get: () => ({
		fetch: async () => new Response(null, { status: 204 }),
	}) } };
	const object = new ReminderAlarm({ storage } as never, env as never);
	return { object, storage, values };
}
function mutation(path = '/reminders/update') {
	return new Request(`https://worker.test${path}`, { method: 'POST', headers: {
		'X-Crate-Internal-Mutation': '1',
		'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
	} });
}
beforeEach(() => { vi.clearAllMocks(); });

// Most routes arm before routing; a reminder command arms once its receipt check finds a new
// command, which this mocked route does before it commits.
it.each([['/features', false], ['/reminders/update', true]])('has a persisted wake before %s commits and retains it if the request fails', async (path, deferred) => {
	const { object, storage } = fixture();
	vi.mocked(handleAuthenticatedRoute).mockImplementation(async (request, _env, context) => {
		expect(request.url).toBe(`https://worker.test${path}`);
		expect(request.headers.has('X-Crate-Internal-Mutation')).toBe(false);
		if (deferred) {
			expect(await storage.getAlarm()).toBeNull();
			await context.armNotifications!();
		}
		expect(await storage.getAlarm()).not.toBeNull();
		throw new Error('request interrupted after commit');
	});
	expect((await object.fetch(mutation(path))).status).toBe(500);
	expect(await storage.getAlarm()).not.toBeNull();
});

it.each(['/features', '/reminders/update'])('does not commit %s if persisting its alarm fails', async path => {
	const { object, storage } = fixture();
	storage.setAlarm.mockRejectedValue(new Error('storage unavailable'));
	const commit = vi.fn();
	vi.mocked(handleAuthenticatedRoute).mockImplementation(async (_request, _env, context) => {
		await context.armNotifications?.();
		commit();
		return new Response(null);
	});
	expect((await object.fetch(mutation(path))).status).toBe(500);
	expect(commit).not.toHaveBeenCalled();
});

it('serializes concurrent mutations in the coordinator', async () => {
	const { object } = fixture();
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	vi.mocked(handleAuthenticatedRoute).mockImplementationOnce(async () => {
		entered(); await blocked; return new Response('first');
	}).mockResolvedValue(new Response('second'));
	const first = object.fetch(mutation());
	await started;
	const second = object.fetch(mutation());
	expect(handleAuthenticatedRoute).toHaveBeenCalledTimes(1);
	release();
	expect((await first).status).toBe(200);
	expect((await second).status).toBe(200);
	expect(handleAuthenticatedRoute).toHaveBeenCalledTimes(2);
});

it('schedules cleanup once after activity and does not reschedule after running', async () => {
	const { object, storage } = fixture();
	for (let i = 0; i < 3; i++) await object.fetch(new Request('https://do/maintain', { method: 'POST' }));
	expect(storage.setAlarm).toHaveBeenCalledOnce();
	await object.alarm();
	expect(runMaintenanceEpisode).toHaveBeenCalledOnce();
	expect(storage.setAlarm).toHaveBeenCalledOnce();
});

it('initializes parser migration once on authenticated access', async () => {
	const { object, storage } = fixture();
	for (let i = 0; i < 3; i++) await object.fetch(new Request('https://do/ensure', { method: 'POST' }));
	expect(storage.setAlarm).toHaveBeenCalledOnce();
});

it('keeps the coordinator responsive while staged upload bytes are loading', async () => {
	const { object } = fixture();
	let release!: () => void;
	vi.mocked(prepareCoordinatedUpload).mockImplementation(() => new Promise(resolve => {
		release = () => resolve({} as never);
	}));
	vi.mocked(commitCoordinatedUpload).mockResolvedValue(new Response('committed'));
	const pending = object.fetch(new Request('https://do/commit-upload', { method: 'POST' }));
	expect((await object.fetch(new Request('https://do/ensure', { method: 'POST' }))).status).toBe(204);
	expect(commitCoordinatedUpload).not.toHaveBeenCalled();
	release();
	expect((await pending).status).toBe(200);
	expect(commitCoordinatedUpload).toHaveBeenCalledOnce();
});
