import { beforeEach, expect, it, vi } from 'vitest';
import { armNotificationCoordinator, runBoundedNotificationCoordinator } from './notification-lifecycle';
import { runNotificationCoordinator } from './notification-coordinator';
vi.mock('./notification-coordinator', () => ({ runNotificationCoordinator: vi.fn() }));

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }),
    setAlarm: vi.fn(async (_time: number) => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  return { values, storage, state: { storage } as never };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(runNotificationCoordinator).mockResolvedValue(undefined); });

it('persists its processing budget and alarm before accepting work', async () => {
  const { state, values, storage } = fixture();
  await armNotificationCoordinator(state);
  expect(values.get('projectionCoordinator')).toBe(true);
  expect(values.get('notificationRun')).toMatchObject({ passes: 0, failures: 0 });
  expect(storage.setAlarm).toHaveBeenCalledOnce();
  expect(storage.put.mock.invocationCallOrder[1]).toBeLessThan(storage.setAlarm.mock.invocationCallOrder[0]!);
});

it('stops after eight coordinator failures instead of retrying forever', async () => {
  const { state, storage } = fixture();
  vi.mocked(runNotificationCoordinator).mockRejectedValue(new Error('database unavailable'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await armNotificationCoordinator(state);
  storage.setAlarm.mockClear();
  for (let i = 0; i < 12; i++) await runBoundedNotificationCoordinator(state, {} as never);
  expect(runNotificationCoordinator).toHaveBeenCalledTimes(8);
  expect(storage.setAlarm).toHaveBeenCalledTimes(7);
  expect(storage.deleteAlarm).toHaveBeenCalled();
});

it.each([
  { startedAt: Date.now() - 86400_001, passes: 1, failures: 0 },
  { startedAt: Date.now(), passes: 10_000, failures: 0 },
])('stops an exhausted episode and allows a subsequent change to resume it', async run => {
  const { state, values, storage } = fixture();
  values.set('notificationRun', run);
  await runBoundedNotificationCoordinator(state, {} as never);
  expect(runNotificationCoordinator).not.toHaveBeenCalled();
  expect(storage.deleteAlarm).toHaveBeenCalledOnce();
  await armNotificationCoordinator(state);
  await runBoundedNotificationCoordinator(state, {} as never);
  expect(runNotificationCoordinator).toHaveBeenCalledOnce();
});

it('does not add a timer when the coordinator finishes idle', async () => {
  const { state, storage } = fixture();
  await runBoundedNotificationCoordinator(state, {} as never);
  expect(storage.setAlarm).not.toHaveBeenCalled();
});
