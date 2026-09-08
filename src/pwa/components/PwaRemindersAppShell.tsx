import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { BottomTabBar } from '@/reminders/components/BottomTabBar';
import { FloatingActionButton } from '@/reminders/components/FloatingActionButton';
import { ShadowDOMNativeButton } from '@/reminders/components/ShadowDOMNativeButton';
import { ViewHeader } from '@/reminders/components/ViewHeader';
import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import type { Reminder } from '@/reminders/types/reminder';
import type { TabId } from '@/reminders/ui/layoutConstants';
import { useObsidianReducedMotion } from '@/reminders/ui/useObsidianReducedMotion';
import { PwaNavigationScreen, type PwaNavigationMotion } from './PwaNavigationScreen';
import { RemindersViewPanels } from '@/reminders/ui/RemindersViewPanels';
import {
	getCurrentHeaderData,
	getReminderCreateProject,
	getRemindersHeaderData,
	getReorderProject,
	shouldShowReminderFab,
	type ViewMode,
} from '@/reminders/ui/remindersViewModel';
import { PwaThemeIcon } from './PwaThemeIcon';
import { ReminderPageSizeContext } from '@/reminders/ui/reminder-pagination';
import { EmptyStateMessageContext } from '@/reminders/components/EmptyState';
import { useReminderClock } from '@/reminders/ui/useReminderClock';

const INCOMPLETE_EMPTY_MESSAGE = { title: 'No results from available files', description: 'Some source files could not be loaded. Review the notice above for missing reminders.' };

export type PwaReminderCardRenderer = (props: {
	reminder: Reminder;
	index: number;
	hideProject: boolean;
}) => React.ReactNode;

interface PwaRemindersAppShellProps {
	reminders: Reminder[];
	projects: string[];
	isDarkMode: boolean;
	initialTab: TabId;
	initialProject?: string;
	upcomingDays: number;
	headerRightContent?: React.ReactNode;
	belowHeaderContent?: (isProjectDetail: boolean) => React.ReactNode;
	children?: React.ReactNode;
	className?: string;
	suppressFab?: boolean;
	incomplete?: boolean;
	renderCard: PwaReminderCardRenderer;
	onAdd: (defaultProject: string) => void;
	onReorder: (project: string, orderedIds: string[]) => Promise<void> | void;
	onReorderDragActiveChange?: (active: boolean) => void;
}

/**
 * PWA-owned reminders chrome.
 *
 * The plugin has a separate shell because viewport, navigation, safe-area, and
 * modal behavior are host concerns. Panels, cards, and view-model logic remain
 * shared with the plugin.
 */
export const PwaRemindersAppShell: React.FC<PwaRemindersAppShellProps> = ({
	reminders,
	projects,
	isDarkMode,
	initialTab,
	initialProject,
	upcomingDays,
	headerRightContent,
	belowHeaderContent,
	children,
	className = '',
	suppressFab = false,
	incomplete = false,
	renderCard,
	onAdd,
	onReorder,
	onReorderDragActiveChange,
}) => {
	const [viewMode, setViewMode] = useState<ViewMode>(initialProject ? 'browse' : initialTab);
	const [direction, setDirection] = useState<PwaNavigationMotion['direction']>(0);
	const reduceMotion = useObsidianReducedMotion();
	const navigationMotion = { direction, reduceMotion };
	const [selectedProject, setSelectedProject] = useState<string | null>(initialProject ?? null);

	const handleViewModeChange = useCallback((mode: ViewMode) => {
		setDirection(mode === 'browse' && selectedProject ? -1 : 0);
		setViewMode(mode);
		setSelectedProject(null);
	}, [selectedProject]);

	const handleProjectSelect = useCallback((project: string) => {
		setDirection(1);
		setSelectedProject(project);
	}, []);

	const handleBackToProjects = useCallback(() => {
		setDirection(-1);
		setSelectedProject(null);
	}, []);

	const clock = useReminderClock(reminders);
	const headerData = useMemo(() => {
		return getRemindersHeaderData(reminders, projects, upcomingDays, clock.now);
	}, [reminders, projects, upcomingDays, clock]);

	const currentHeader = useMemo(() => {
		return getCurrentHeaderData(viewMode, headerData);
	}, [headerData, viewMode]);

	const showFab = shouldShowReminderFab(viewMode, selectedProject);

	const handleAdd = useCallback(() => {
		onAdd(getReminderCreateProject(viewMode, selectedProject));
	}, [onAdd, selectedProject, viewMode]);

	const panelCardRenderer = useCallback((reminder: Reminder, index: number) => {
		return renderCard({
			reminder,
			index,
			hideProject: viewMode === 'browse' && selectedProject !== null,
		});
	}, [renderCard, selectedProject, viewMode]);

	const renderToggleButton = useCallback(({ onPress, showCompleted, count }: {
		onPress: () => void;
		showCompleted: boolean;
		count: number;
	}) => (
		<ShadowDOMNativeButton
			onClick={onPress}
			className="completed-section-toggle w-full justify-between h-10 px-0"
		>
			<span className="text-sm font-semibold reminders-muted-label">
				Completed ({count})
			</span>
			{
				<motion.span
					animate={{ rotate: showCompleted ? 180 : 0 }}
					transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
					className="inline-flex"
				>
					<ChevronDown size={18} />
				</motion.span>
			}
		</ShadowDOMNativeButton>
	), [reduceMotion]);

	const currentProject = getReorderProject(viewMode, selectedProject);

	const handleReorder = useCallback((orderedIds: string[]) => {
		if (!currentProject) return;
		return onReorder(currentProject, orderedIds);
	}, [currentProject, onReorder]);

	const viewPanels = (
		<RemindersViewPanels
			viewMode={viewMode}
			selectedProject={selectedProject}
			isInitialLoadComplete
			reminders={reminders}
			projects={projects}
			showFab={showFab}
			upcomingDays={upcomingDays}
			renderCard={panelCardRenderer}
			renderToggleButton={renderToggleButton}
			onProjectSelect={handleProjectSelect}
			onBackToProjects={handleBackToProjects}
			onReorder={handleReorder}
			onReorderDragActiveChange={onReorderDragActiveChange}
			colorScheme={isDarkMode ? 'dark' : 'light'}
			reorderInteraction="long-press"
			pageTransitionsEnabled={false}
			animationsEnabled={!reduceMotion}
		/>
	);

	return (
		<ReminderPageSizeContext.Provider value={200}>
		<EmptyStateMessageContext.Provider value={incomplete ? INCOMPLETE_EMPTY_MESSAGE : null}>
		<ThemeIconProvider renderer={PwaThemeIcon}>
		  <div
				className={[
					'reminders-view',
					'is-primary',
					isDarkMode ? 'dark' : 'light',
					'is-fullscreen',
					'is-modal',
					viewMode === 'browse' && selectedProject ? 'is-project-detail' : `is-${viewMode}`,
					className,
				].filter(Boolean).join(' ')}
			>
				<div className="pwa-navigation-viewport">
					<AnimatePresence initial={false} custom={navigationMotion}>
						{/* Keep shared header actions mounted when switching main tabs. */}
						<PwaNavigationScreen
							key={selectedProject === null ? 'tabs' : `project-${selectedProject}`}
							motion={navigationMotion}
						>
							{!(viewMode === 'browse' && selectedProject) && (
								<div className="overflow-hidden">
									<ViewHeader
										{...currentHeader}
										countUnit={viewMode === 'browse' ? 'project' : 'reminder'}
										large
										showMeta
										rightContent={headerRightContent}
									/>
								</div>
							)}

							{belowHeaderContent && (
								<div className="pwa-below-header-content">
									{belowHeaderContent(viewMode === 'browse' && selectedProject !== null)}
								</div>
							)}

							<div className="reminders-content">
								{viewPanels}
							</div>

						</PwaNavigationScreen>
					</AnimatePresence>
				</div>

				<BottomTabBar
					activeTab={viewMode}
					onTabChange={handleViewModeChange}
					className="animated-tab-bar animated-tab-bar-bottom"
					animateActiveIndicator={!reduceMotion}
				/>

				<AnimatePresence>
					{showFab && !suppressFab && (
						<FloatingActionButton
							onClick={handleAdd}
							className="fab"
							animateOnMount={false}
							data-action="open-create-modal"
						/>
					)}
				</AnimatePresence>

				{children}
		  </div>
		</ThemeIconProvider>
		</EmptyStateMessageContext.Provider>
		</ReminderPageSizeContext.Provider>
	);
};
