/* eslint-disable @typescript-eslint/no-unsafe-assignment -- React test doubles intentionally expose partial component props. */
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
	vi.doMock('@/reminders/ui/views', () => ({
		BrowseView: (props: unknown) => {
			browseViewProps(props);
			return React.createElement('div', { 'data-view': 'browse' });
		},
		InboxView: (props: unknown) => {
			inboxViewProps(props);
			return React.createElement('div', { 'data-view': 'inbox' });
		},
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
	vi.doMock('@/reminders/ui/layoutConstants', () => ({
		EASE_EXPO_OUT: [0.16, 1, 0.3, 1],
		PAGE_TRANSITION_DURATION: 0.2,
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
	vi.doUnmock('@/reminders/ui/views');
	vi.doUnmock('@/reminders/ui/layoutConstants');
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

	it.each([true, false])('passes the animation preference %s to every reminder screen', async (enabled) => {
		const { RemindersViewPanels } = await loadPanelsModule();
		for (const viewMode of ['inbox', 'today', 'upcoming', 'browse']) {
			renderToStaticMarkup(React.createElement(RemindersViewPanels, makeProps({
				viewMode, selectedProject: 'Work', animationsEnabled: enabled,
			}) as never));
		}
		for (const capture of [inboxViewProps, todayViewProps, upcomingViewProps, projectDetailViewProps]) {
			expect(capture.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
				animationConfig: { enabled },
			}));
		}
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
		const projectHeaderRightContent = React.createElement('span', null, 'Sync status');
		const sharedProps = makeProps({
			selectedProject: 'Work',
			projectHeaderRightContent,
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
			headerRightContent: projectHeaderRightContent,
			reminders: expect.arrayContaining([expect.objectContaining({ id: 'r1' })]),
			onBack: sharedProps.onBackToProjects,
			onReorder: sharedProps.onReorder,
			hasFab: true,
			animationConfig: { enabled: true },
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

/* eslint-enable @typescript-eslint/no-unsafe-assignment -- End test-only rule relaxation. */
