/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browseViewProps = vi.fn();
const inboxViewProps = vi.fn();
const todayViewProps = vi.fn();
const upcomingViewProps = vi.fn();
const projectDetailViewProps = vi.fn();

async function loadPanelsModule() {
	vi.doMock('framer-motion', () => ({
		motion: {
			div: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('div', props, children),
		},
	}));
	vi.doMock('@/reminders', () => ({
		BrowseView: (props: unknown) => {
			browseViewProps(props);
			return React.createElement('div', { 'data-view': 'browse' });
		},
		EASE_EXPO_OUT: [0.16, 1, 0.3, 1],
		InboxView: (props: unknown) => {
			inboxViewProps(props);
			return React.createElement('div', { 'data-view': 'inbox' });
		},
		PAGE_TRANSITION_DURATION: 0.2,
		ProjectDetailView: (props: unknown) => {
			projectDetailViewProps(props);
			return React.createElement('div', { 'data-view': 'project-detail' });
		},
		TodayView: (props: unknown) => {
			todayViewProps(props);
			return React.createElement('div', { 'data-view': 'today' });
		},
		UpcomingView: (props: unknown) => {
			upcomingViewProps(props);
			return React.createElement('div', { 'data-view': 'upcoming' });
		},
	}));

	return import('./RemindersViewPanels');
}

function makeProps(overrides: Record<string, unknown> = {}) {
	return {
		viewMode: 'browse',
		selectedProject: null,
		isInitialLoadComplete: true,
		reminders: [{
			id: 'r1',
			content: 'Task',
			priority: 4,
			completed: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		}],
		projects: ['Inbox', 'Work'],
		showFab: true,
		upcomingDays: 9,
		renderCard: vi.fn(() => null),
		renderToggleButton: vi.fn(() => null),
		onProjectSelect: vi.fn(),
		onBackToProjects: vi.fn(),
		onReorder: vi.fn(async () => {}),
		...overrides,
	};
}

beforeEach(() => {
	browseViewProps.mockReset();
	inboxViewProps.mockReset();
	todayViewProps.mockReset();
	upcomingViewProps.mockReset();
	projectDetailViewProps.mockReset();
});

afterEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('framer-motion');
	vi.doUnmock('@/reminders');
});

describe('RemindersViewPanels', () => {
	it('renders the browse project list when no project is selected', async () => {
		const { RemindersViewPanels } = await loadPanelsModule();
		const props = makeProps();

		const html = renderToStaticMarkup(React.createElement(RemindersViewPanels, props as never));
		const browseProps = browseViewProps.mock.calls[0]?.[0];

		expect(html).toContain('data-view="browse"');
		expect(browseProps).toEqual(expect.objectContaining({
			projects: ['Inbox', 'Work'],
			reminders: expect.arrayContaining([expect.objectContaining({ id: 'r1' })]),
			onProjectSelect: props.onProjectSelect,
		}));
		expect(projectDetailViewProps).not.toHaveBeenCalled();
	});

	it('suppresses the project detail panel until the initial load completes', async () => {
		const { RemindersViewPanels } = await loadPanelsModule();
		const props = makeProps({
			selectedProject: 'Work',
			isInitialLoadComplete: false,
		});

		const html = renderToStaticMarkup(React.createElement(RemindersViewPanels, props as never));

		expect(html).toBe('');
		expect(projectDetailViewProps).not.toHaveBeenCalled();
	});

	it('renders project detail and upcoming panels with the expected cross-module props', async () => {
		const { RemindersViewPanels } = await loadPanelsModule();
		const sharedProps = makeProps({
			selectedProject: 'Work',
		});

		const projectHtml = renderToStaticMarkup(React.createElement(RemindersViewPanels, {
			...sharedProps,
			viewMode: 'browse',
		} as never));
		const upcomingHtml = renderToStaticMarkup(React.createElement(RemindersViewPanels, {
			...sharedProps,
			viewMode: 'upcoming',
			showFab: false,
		} as never));
		const projectProps = projectDetailViewProps.mock.calls[0]?.[0];
		const upcomingProps = upcomingViewProps.mock.calls[0]?.[0];

		expect(projectHtml).toContain('data-view="project-detail"');
		expect(projectProps).toEqual(expect.objectContaining({
			project: 'Work',
			reminders: expect.arrayContaining([expect.objectContaining({ id: 'r1' })]),
			onBack: sharedProps.onBackToProjects,
			onReorder: sharedProps.onReorder,
			hasFab: true,
			animationConfig: { enabled: false },
			renderCard: sharedProps.renderCard,
		}));

		expect(upcomingHtml).toContain('data-view="upcoming"');
		expect(upcomingProps).toEqual(expect.objectContaining({
			days: 9,
			hasFab: false,
			reminders: expect.arrayContaining([expect.objectContaining({ id: 'r1' })]),
			renderCard: sharedProps.renderCard,
		}));
	});
});
