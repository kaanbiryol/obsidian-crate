import React from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import type { Reminder } from '@/reminders/types/reminder';

const projectDetailRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/reminders/ui/views', async () => {
	const { memo } = await import('react');
	return { ProjectDetailView: memo(function ProjectDetailView() { projectDetailRenders.count++; return null; }) };
});
vi.mock('@/reminders/ui/RemindersViewPanels', () => ({ RemindersViewPanels: () => null }));
vi.mock('@/reminders/components/ViewHeader', () => ({ ViewHeader: () => null }));
vi.mock('./PwaDock', () => ({ PwaDock: () => null, PwaDockAddButton: () => null }));
vi.mock('./PwaTabTransition', () => ({ PwaTabTransition: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./PwaNavigationScreen', () => ({ PwaNavigationScreen: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./PwaScheduleSwitcher', () => ({ PwaScheduleSwitcher: () => null }));
vi.mock('@/ui/shared/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('../hooks/useReminderProjectNavigation', () => {
	const navigation = {
		viewMode: 'browse', selectedProject: 'Work', navigationMotion: 'none', projectOpen: true, canGoBack: true,
		handleViewModeChange: () => {}, handleProjectSelect: () => {}, handleBackToProjects: () => {}, finishProjectClose: () => {},
	};
	return { useReminderProjectNavigation: () => navigation };
});

import { PwaRemindersAppShell } from './PwaRemindersAppShell';

const reminders: Reminder[] = [];
const projects = ['Work'];
const headerRightContent = () => null;
const belowHeaderContent = () => null;
const renderCard = () => null;
const onAdd = () => {};
const onReorder = () => {};

it('does not re-render the open project detail when shell props are unchanged', () => {
	const hook = renderHook(() => null, () => {
		Object.assign(window, { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
	}, () => React.createElement(PwaRemindersAppShell, {
		reminders, projects, isDarkMode: false, initialTab: 'browse', initialProject: 'Work', upcomingDays: 7,
		headerRightContent, belowHeaderContent, renderCard, onAdd, onReorder,
	}));
	const rendered = projectDetailRenders.count;
	expect(rendered).toBeGreaterThan(0);
	hook.rerender();
	hook.rerender();
	expect(projectDetailRenders.count).toBe(rendered);
});
