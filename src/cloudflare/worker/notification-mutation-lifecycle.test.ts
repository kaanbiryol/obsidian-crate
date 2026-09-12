import { prepareCoordinatedUpload, commitCoordinatedUpload } from './staged-upload-dispatch';
import { beforeEach, expect, it, vi } from 'vitest';
import { ReminderAlarm } from './notifications/reminder-alarm';
import { handleAuthenticatedRoute } from './router';
import { runMaintenanceEpisode } from './maintenance/lifecycle';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
vi.mock('./staged-upload-dispatch', () => ({ prepareCoordinatedUpload: vi.fn(), commitCoordinatedUpload: vi.fn(), coordinatedUpload: vi.fn() }));
vi.mock('./router', () => ({ handleAuthenticatedRoute: vi.fn(), isAuthenticatedRouteAllowed: () => true, handlePublicRoute: vi.fn(async () => null) }));
vi.mock('./auth/index', () => ({ authenticateWorkerRequest: vi.fn(async () => ({ principal: { id: 'device', scope: 'vault' } })) }));
vi.mock('./request-diagnostics', () => ({ logMutation: vi.fn() }));
vi.mock('./maintenance/lifecycle', () => ({ runMaintenanceEpisode: vi.fn() }));

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
function mutation() {
  return new Request('https://worker.test/reminders/update', { method: 'POST', headers: {
    'X-Crate-Internal-Mutation': '1',
    'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
  } });
}
beforeEach(() => { vi.clearAllMocks(); });

it('has a persisted wake before the mutation and retains it if the request fails', async () => {
  const { object, storage } = fixture();
  vi.mocked(handleAuthenticatedRoute).mockImplementation(async request => {
    expect(request.url).toBe('https://worker.test/reminders/update');
    expect(request.headers.has('X-Crate-Internal-Mutation')).toBe(false);
    expect(await storage.getAlarm()).not.toBeNull();
    throw new Error('request interrupted after commit');
  });
  expect((await object.fetch(mutation())).status).toBe(500);
  expect(await storage.getAlarm()).not.toBeNull();
});

it('does not execute a mutation if persisting its alarm fails', async () => {
  const { object, storage } = fixture();
  storage.setAlarm.mockRejectedValue(new Error('storage unavailable'));
  expect((await object.fetch(mutation())).status).toBe(500);
  expect(handleAuthenticatedRoute).not.toHaveBeenCalled();
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
