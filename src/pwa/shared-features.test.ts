import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../test/react-hooks';
import { AUTH_TOKEN_KEY } from './config';
import { requestSharedFeaturesRefresh, useServerFeatures } from './shared-features';

const values = new Map<string, string>();
const network = vi.fn<typeof fetch>();
const setItem = vi.fn((key: string, value: string) => { values.set(key, value); });
let policy = { reading: true, reminders: true, revision: 'one' };

function setup() {
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem, removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('fetch', network);
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function mount() {
  let renders = 0;
  const hook = renderHook(() => { renders++; return useServerFeatures(); }, setup);
  return { hook, renders: () => renders };
}

beforeEach(() => {
  values.clear();
  values.set(AUTH_TOKEN_KEY, 'reminders-token');
  policy = { reading: true, reminders: true, revision: 'one' };
  network.mockReset().mockImplementation(async () => new Response(JSON.stringify(policy)));
  setItem.mockClear();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'setTimeout'] });
});
afterEach(() => { vi.useRealTimers(); });

it('checks once on open and never on a timer', async () => {
  mount();
  await settle();
  expect(network).toHaveBeenCalledOnce();
  // Before: a request every 15 seconds in every tab, visible or not.
  await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
  expect(network).toHaveBeenCalledOnce();
});

it('rechecks after a data refresh at most every five minutes, and at once after a paused response', async () => {
  mount();
  await settle();
  act(() => requestSharedFeaturesRefresh());
  await settle();
  expect(network).toHaveBeenCalledOnce();

  vi.advanceTimersByTime(5 * 60_000);
  act(() => requestSharedFeaturesRefresh());
  await settle();
  expect(network).toHaveBeenCalledTimes(2);

  policy = { reading: true, reminders: false, revision: 'two' };
  act(() => requestSharedFeaturesRefresh(true));
  await settle();
  expect(network).toHaveBeenCalledTimes(3);
});

it('does not re-render or rewrite storage when the policy is unchanged', async () => {
  const { hook, renders } = mount();
  await settle();
  const first = hook.current;
  const rendered = renders();
  const writes = setItem.mock.calls.length;

  act(() => requestSharedFeaturesRefresh(true));
  await settle();
  expect(network).toHaveBeenCalledTimes(2);
  expect(hook.current).toBe(first);
  expect(renders()).toBe(rendered);
  expect(setItem.mock.calls.length).toBe(writes);

  policy = { reading: false, reminders: true, revision: 'two' };
  act(() => requestSharedFeaturesRefresh(true));
  await settle();
  expect(hook.current).toEqual({ reading: false, reminders: true });
});

it('checks again when the app regains focus after 30 seconds or reconnects', async () => {
  const { hook } = mount();
  await settle();
  policy = { reading: false, reminders: true, revision: 'two' };
  // Before: every focus requested the policy again.
  act(() => { window.dispatchEvent(new window.Event('focus')); });
  await settle();
  expect(network).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000);
  act(() => { window.dispatchEvent(new window.Event('focus')); });
  await settle();
  expect(network).toHaveBeenCalledTimes(2);
  expect(hook.current).toEqual({ reading: false, reminders: true });
  act(() => { window.dispatchEvent(new window.Event('online')); });
  await settle();
  expect(network).toHaveBeenCalledTimes(3);
});
