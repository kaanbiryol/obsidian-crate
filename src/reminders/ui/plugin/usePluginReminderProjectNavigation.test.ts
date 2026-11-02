import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import { usePluginReminderProjectNavigation } from './usePluginReminderProjectNavigation';

it('opens a project and keeps the projects list covered until the detail exits', () => {
	const navigation = renderHook(() => usePluginReminderProjectNavigation({ initialTab: 'browse' }));

	act(() => navigation.current.handleProjectSelect('Work'));
	expect(navigation.current).toMatchObject({ selectedProject: 'Work', direction: 1, closingProject: false });

	act(() => navigation.current.handleBackToProjects());
	expect(navigation.current).toMatchObject({ selectedProject: null, direction: -1, closingProject: true });

	act(() => navigation.current.finishProjectClose());
	expect(navigation.current.closingProject).toBe(false);
});

it('starts in Projects for an initial project and reports tab changes', () => {
	const onTabChange = vi.fn();
	const navigation = renderHook(() => usePluginReminderProjectNavigation({ initialTab: 'today', initialProject: 'Home', onTabChange }));
	expect(navigation.current).toMatchObject({ viewMode: 'browse', selectedProject: 'Home' });

	act(() => navigation.current.handleViewModeChange('inbox'));
	expect(navigation.current).toMatchObject({ viewMode: 'inbox', selectedProject: null });
	expect(onTabChange).toHaveBeenCalledWith('inbox');
});

it('follows a controlled tab', () => {
	const navigation = renderHook(() => usePluginReminderProjectNavigation({ initialTab: 'inbox', activeTab: 'upcoming' }));

	act(() => navigation.current.handleViewModeChange('today'));
	expect(navigation.current.viewMode).toBe('upcoming');
});
