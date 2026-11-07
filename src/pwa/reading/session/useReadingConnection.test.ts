import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../../test/react-hooks';
import { AUTH_TOKEN_KEY } from '../../config';
import { connectReadingFromReminders } from './reminders-session';
import { useReadingConnection } from './useReadingConnection';

vi.mock('./reminders-session', async importOriginal => ({ ...await importOriginal<typeof import('./reminders-session')>(), connectReadingFromReminders: vi.fn() }));
vi.mock('./session', async importOriginal => ({ ...await importOriginal<typeof import('./session')>(), readingSession: () => null }));

it('reports the first automatic connection in the same render that becomes ready', async () => {
	vi.mocked(connectReadingFromReminders).mockReturnValue(new Promise(() => {}));
	const renders: Array<{ ready: boolean; connecting: boolean }> = [];
	const hook = renderHook(() => {
		const { ready, connecting } = useReadingConnection(true, true);
		renders.push({ ready, connecting });
		return { ready, connecting };
	}, () => {
		vi.stubGlobal('navigator', { onLine: true });
		vi.stubGlobal('localStorage', { getItem: (key: string) => key === AUTH_TOKEN_KEY ? 'token' : null, setItem: () => {}, removeItem: () => {} });
	});
	await act(async () => {});
	expect(hook.current).toEqual({ ready: true, connecting: true });
	// A ready render without a session or connection would show the library before Reading connects.
	expect(renders).not.toContainEqual({ ready: true, connecting: false });
	expect(connectReadingFromReminders).toHaveBeenCalledTimes(1);
});
