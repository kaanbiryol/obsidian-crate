import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';

const url = vi.hoisted(() => ({ href: 'https://crate.test/' }));
const openProjectHistory = vi.hoisted(() => vi.fn(async (project: string) => {
	url.href = `https://crate.test/?project=${encodeURIComponent(project)}`;
	return 'stack';
}));
vi.mock('../navigation/project-history', () => ({
	openProjectHistory, hasProjectHistory: () => false, dismissProjectHistory: () => {},
}));

import { useReminderProjectNavigation } from './useReminderProjectNavigation';

function render(initial?: string) {
	let requestedProject = initial;
	url.href = initial ? `https://crate.test/?project=${initial}` : 'https://crate.test/';
	openProjectHistory.mockClear();
	const hook = renderHook(() => useReminderProjectNavigation({ initialTab: 'today', requestedProject, reduceMotion: false }), () => {
		vi.stubGlobal('location', url);
		vi.stubGlobal('cancelAnimationFrame', () => {});
	});
	const request = async (project?: string) => {
		requestedProject = project;
		hook.rerender();
		await act(async () => {});
	};
	return { hook, request };
}

it('pushes a later requested project with its slide instead of remounting', async () => {
	const { hook, request } = render();
	expect(hook.current.viewMode).toBe('today');
	await request('Work');
	expect(openProjectHistory).toHaveBeenCalledWith('Work');
	expect(hook.current.viewMode).toBe('browse');
	expect(hook.current.selectedProject).toBe('Work');
	expect(hook.current.navigationMotion).toEqual({ direction: 1, reduceMotion: false });
});

it('returns to Projects when the requested project is cleared', async () => {
	const { hook, request } = render('Work');
	expect(hook.current.selectedProject).toBe('Work');
	openProjectHistory.mockClear();
	await request(undefined);
	expect(hook.current.selectedProject).toBeNull();
	expect(hook.current.viewMode).toBe('browse');
	expect(openProjectHistory).not.toHaveBeenCalled();
});

it('keeps a project the user opened when an earlier request is cleared', async () => {
	const { hook, request } = render('Work');
	act(() => hook.current.handleBackToProjects());
	act(() => hook.current.finishProjectClose());
	await act(async () => { await hook.current.handleProjectSelect('Home'); });
	expect(hook.current.selectedProject).toBe('Home');
	await request(undefined);
	expect(hook.current.selectedProject).toBe('Home');
});
