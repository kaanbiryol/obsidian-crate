import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { BottomTabBar } from '@/reminders/components/BottomTabBar';
import { FloatingActionButton } from '@/reminders/components/FloatingActionButton';
import { ShadowDOMNativeButton } from '@/reminders/components/ShadowDOMNativeButton';
import { ViewHeader } from '@/reminders/components/ViewHeader';
import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import type { Reminder } from '@/reminders/types/reminder';
import type { TabId } from '@/reminders/ui/layoutConstants';
import { useObsidianReducedMotion } from '@/reminders/ui/useObsidianReducedMotion';
import { PwaNavigationScreen, type PwaNavigationMotion } from './PwaNavigationScreen';
import { PwaRemindersSkeletonRows } from './PwaRemindersOpening';
import { RemindersViewPanels } from '@/reminders/ui/RemindersViewPanels';
import { ProjectDetailView } from '@/reminders/ui/views';
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
import { dismissProjectHistory, hasProjectHistory, openProjectHistory } from '../project-history';

const LOADING_EMPTY_MESSAGE = { title: 'Loading reminders…', description: 'Checking for the latest reminders.' };
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
	headerRightContent?: (isProjectDetail: boolean) => React.ReactNode;
	headerTitleContent?: React.ReactNode;
	headerMetaContent?: React.ReactNode;
	belowHeaderContent?: (isProjectDetail: boolean) => React.ReactNode;
	children?: React.ReactNode;
	className?: string;
	suppressFab?: boolean;
	backgroundInert?: boolean;
	incomplete?: boolean;
	checkingReminders?: boolean;
	showLoadingSkeleton?: boolean;
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
	headerTitleContent,
	headerMetaContent,
	belowHeaderContent,
	children,
	className = '',
	suppressFab = false,
	backgroundInert = false,
	incomplete = false,
	checkingReminders = false,
	showLoadingSkeleton = false,
	renderCard,
	onAdd,
	onReorder,
	onReorderDragActiveChange,
}) => {
	const [viewMode, setViewMode] = useState<ViewMode>(initialProject ? 'browse' : initialTab);
	const [direction, setDirection] = useState<PwaNavigationMotion['direction']>(0);
	const reduceMotion = useObsidianReducedMotion();
	const [skipProjectMotion, setSkipProjectMotion] = useState(Boolean(initialProject));
	const navigationMotion = { direction, reduceMotion: reduceMotion || skipProjectMotion };
	const [selectedProject, setSelectedProject] = useState<string | null>(initialProject ?? null);
	const projectStack = useRef<string | null>(null);
	const closingProject = useRef(false);
	const lastProject = useRef(initialProject ?? null);
	const historyFrame = useRef(0);

	useLayoutEffect(() => {
		if (initialProject) projectStack.current = openProjectHistory(initialProject);
		return () => cancelAnimationFrame(historyFrame.current);
	}, [initialProject]);

	useEffect(() => {
		const back = () => {
			if (new URL(location.href).searchParams.get('section') === 'reading' || !projectStack.current) return;
			closingProject.current = false;
			setSkipProjectMotion(true);
			setDirection(-1);
			setSelectedProject(null);
			const stack = projectStack.current;
			projectStack.current = null;
			cancelAnimationFrame(historyFrame.current);
			historyFrame.current = requestAnimationFrame(() => {
				historyFrame.current = requestAnimationFrame(() => {
					dismissProjectHistory(stack);
					const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-action="open-project"]'))
						.find(candidate => candidate.dataset.project === lastProject.current);
					button?.focus({ preventScroll: true });
				});
			});
		};
		window.addEventListener('popstate', back);
		return () => window.removeEventListener('popstate', back);
	}, []);

	const handleViewModeChange = useCallback((mode: ViewMode) => {
		if (selectedProject || closingProject.current) return;
		setDirection(0);
		setViewMode(mode);
	}, [selectedProject]);

	const handleProjectSelect = useCallback((project: string) => {
		if (selectedProject || closingProject.current) return;
		projectStack.current = openProjectHistory(project);
		lastProject.current = project;
		setSkipProjectMotion(false);
		setDirection(1);
		setSelectedProject(project);
	}, [selectedProject]);

	const handleBackToProjects = useCallback(() => {
		if (closingProject.current || !selectedProject) return;
		closingProject.current = true;
		setSkipProjectMotion(false);
		setDirection(-1);
		setSelectedProject(null);
	}, [selectedProject]);

	const finishProjectClose = useCallback(() => {
		if (!closingProject.current) return;
		if (hasProjectHistory()) history.back();
		else closingProject.current = false;
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
		if (backgroundInert) return;
		onAdd(getReminderCreateProject(viewMode, selectedProject));
	}, [backgroundInert, onAdd, selectedProject, viewMode]);

	const panelCardRenderer = useCallback((reminder: Reminder, index: number) => {
		return renderCard({
			reminder,
			index,
			hideProject: viewMode === 'browse' && selectedProject !== null,
		});
	}, [renderCard, selectedProject, viewMode]);
	const listCardRenderer = useCallback((reminder: Reminder, index: number) => renderCard({ reminder, index, hideProject: false }), [renderCard]);

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
			selectedProject={null}
			isInitialLoadComplete
			reminders={reminders}
			projects={projects}
			showFab={shouldShowReminderFab(viewMode, null)}
			upcomingDays={upcomingDays}
			renderCard={listCardRenderer}
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
		<EmptyStateMessageContext.Provider value={checkingReminders ? LOADING_EMPTY_MESSAGE : incomplete ? INCOMPLETE_EMPTY_MESSAGE : null}>
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
				<div className="pwa-navigation-viewport" inert={backgroundInert || Boolean(selectedProject) || closingProject.current}>
					{/* Keep the Projects list and its scroll position mounted behind detail. */}
					<PwaNavigationScreen motion={{ direction: 0, reduceMotion }}>
						<div className="overflow-hidden">
							<ViewHeader
								{...currentHeader}
								countUnit={viewMode === 'browse' ? 'project' : 'reminder'}
								large
								showMeta={!showLoadingSkeleton}
								reserveMetaSpace={showLoadingSkeleton}
								titleContent={headerTitleContent}
								metaContent={headerMetaContent}
								rightContent={headerRightContent?.(false)}
							/>
						</div>

						{belowHeaderContent && (
							<div className="pwa-below-header-content">
								{belowHeaderContent(false)}
							</div>
						)}

						<div className="reminders-content">
							{showLoadingSkeleton ? <PwaRemindersSkeletonRows /> : viewPanels}
						</div>
					</PwaNavigationScreen>
				</div>

				<BottomTabBar
					inert={backgroundInert || Boolean(selectedProject) || closingProject.current}
					activeTab={viewMode}
					onTabChange={handleViewModeChange}
					className="animated-tab-bar animated-tab-bar-bottom"
					animateActiveIndicator={!reduceMotion}
				/>

				<AnimatePresence initial={false}>
					{showFab && !selectedProject && !closingProject.current && !suppressFab && (
						<FloatingActionButton
							onClick={handleAdd}
							inert={backgroundInert}
							className="fab"
							data-action="open-create-modal"
						/>
					)}
				</AnimatePresence>

				<div className="pwa-project-layer" data-project-open={Boolean(selectedProject) || closingProject.current}>
					<AnimatePresence initial={false} custom={navigationMotion} onExitComplete={finishProjectClose}>
						{selectedProject && <PwaNavigationScreen key={selectedProject} motion={navigationMotion} isProjectDetail>
							<div className="reminders-content">
								<ProjectDetailView
									project={selectedProject}
									headerTitleContent={headerTitleContent}
									headerMetaContent={headerMetaContent}
									headerRightContent={headerRightContent?.(true)}
									belowHeaderContent={belowHeaderContent && <div className="pwa-below-header-content">{belowHeaderContent(true)}</div>}
									reminders={reminders}
									onBack={handleBackToProjects}
									animationConfig={{ enabled: !reduceMotion }}
									renderCard={panelCardRenderer}
									hasFab={!suppressFab}
									onReorder={handleReorder}
									onReorderDragActiveChange={onReorderDragActiveChange}
									colorScheme={isDarkMode ? 'dark' : 'light'}
									reorderInteraction="long-press"
								/>
							</div>
							{!suppressFab && <FloatingActionButton onClick={handleAdd} inert={backgroundInert} className="fab pwa-project-fab" data-action="open-create-modal" />}
						</PwaNavigationScreen>}
					</AnimatePresence>
				</div>

				{children}
		  </div>
		</ThemeIconProvider>
		</EmptyStateMessageContext.Provider>
		</ReminderPageSizeContext.Provider>
	);
};
