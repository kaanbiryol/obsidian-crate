import { PWA_CONTROL_SPRING, PWA_FADE } from '../motion';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PwaDock, PwaDockAddButton } from './PwaDock';
import { PwaTabTransition } from './PwaTabTransition';
import { PwaScheduleSwitcher } from './PwaScheduleSwitcher';
import { TABS } from '@/reminders/ui/layoutConstants';
import { ShadowDOMNativeButton } from '@/reminders/components/ShadowDOMNativeButton';
import { ViewHeader } from '@/reminders/components/ViewHeader';
import { ThemeIconProvider } from '@/ui/shared/ThemeIcon';
import type { Reminder } from '@/reminders/types/reminder';
import type { TabId } from '@/reminders/ui/layoutConstants';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { PwaNavigationScreen, type PwaNavigationMotion } from './PwaNavigationScreen';
import { LoadingIndicator } from '@/ui/shared/LoadingIndicator';
import { RemindersViewPanels } from '@/reminders/ui/RemindersViewPanels';
import { ProjectDetailView } from '@/reminders/ui/views';
import { BackButton } from '@/ui/shared/BackButton';
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
	headerMetaContent?: React.ReactNode;
	belowHeaderContent?: (isProjectDetail: boolean) => React.ReactNode;
	children?: React.ReactNode;
	className?: string;
	suppressFab?: boolean;
	backgroundInert?: boolean;
	incomplete?: boolean;
	checkingReminders?: boolean;
	showLoadingIndicator?: boolean;
	initializing?: boolean;
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
	headerMetaContent,
	belowHeaderContent,
	children,
	className = '',
	suppressFab = false,
	backgroundInert = false,
	incomplete = false,
	checkingReminders = false,
	showLoadingIndicator = false,
	initializing = false,
	renderCard,
	onAdd,
	onReorder,
	onReorderDragActiveChange,
}) => {
	const [viewMode, setViewMode] = useState<ViewMode>(initialProject ? 'browse' : initialTab);
	const [direction, setDirection] = useState<PwaNavigationMotion['direction']>(0);
	const reduceMotion = useReducedMotion();
	const shell = useRef<HTMLDivElement>(null);
	const contentRevealed = useRef(false);

	useLayoutEffect(() => {
		if (showLoadingIndicator || contentRevealed.current) return;
		contentRevealed.current = true;
		if (reduceMotion) return;
		// Reveal the snapshot as one stationary change. Keep the title, actions,
		// and dock painted, and never replay this entrance for background refreshes.
		const regions = shell.current?.querySelectorAll<HTMLElement>(
			'.pwa-navigation-viewport .view-header-meta, .pwa-navigation-viewport .pwa-schedule-switcher, .pwa-navigation-viewport .reminders-content',
		);
		const animations = Array.from(regions ?? [], region => region.animate(
			[{ opacity: 0 }, { opacity: 1 }],
			{ duration: PWA_FADE.duration * 1000, easing: 'ease-out' },
		));
		return () => animations.forEach(animation => animation.cancel());
	}, [showLoadingIndicator, reduceMotion]);
	const [skipProjectMotion, setSkipProjectMotion] = useState(Boolean(initialProject));
	const navigationMotion = { direction, reduceMotion: reduceMotion || skipProjectMotion };
	const [selectedProject, setSelectedProject] = useState<string | null>(initialProject ?? null);
	const projectStack = useRef<string | null>(null);
	const closingProject = useRef(false);
	const lastProject = useRef(initialProject ?? null);
	const historyFrame = useRef(0);

	useLayoutEffect(() => {
		if (initialProject) void openProjectHistory(initialProject).then(stack => { projectStack.current = stack; });
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

	const handleProjectSelect = useCallback(async (project: string) => {
		if (selectedProject || closingProject.current) return;
		const stack = await openProjectHistory(project);
		if (!stack || new URL(location.href).searchParams.get('project') !== project) return;
		projectStack.current = stack;
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
	const primaryTab = viewMode === 'upcoming' ? 'today' : viewMode;

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
					transition={reduceMotion ? { duration: 0 } : PWA_CONTROL_SPRING}
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
				ref={shell}
				data-pwa-opening={initializing || undefined}
				data-pwa-loading={showLoadingIndicator || undefined}
				aria-busy={initializing}
				className={[
					'pwa-screen',
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
					<PwaTabTransition viewKey={primaryTab}>
						<div className="overflow-hidden" inert={initializing}>
							<ViewHeader
								{...currentHeader}
								title={primaryTab === 'today' ? 'Reminders' : currentHeader.title}
								countUnit={viewMode === 'browse' ? 'project' : 'reminder'}
								large
								showMeta={!showLoadingIndicator}
								reserveMetaSpace={showLoadingIndicator}
								metaContent={headerMetaContent}
								rightContent={headerRightContent?.(false)}
							/>
						</div>

						{(viewMode === 'today' || viewMode === 'upcoming') && (
							<PwaScheduleSwitcher value={viewMode} onChange={handleViewModeChange} inert={initializing || showLoadingIndicator} />
						)}

						{belowHeaderContent && (
							<div className="pwa-below-header-content">
								{belowHeaderContent(false)}
							</div>
						)}

						<div className="reminders-content">
							{showLoadingIndicator ? <LoadingIndicator label="Loading reminders" /> : primaryTab === 'today' ? (
								<PwaTabTransition viewKey={viewMode}>{viewPanels}</PwaTabTransition>
							) : viewPanels}
						</div>
					</PwaTabTransition>
				</div>

				<PwaDock section="reminders" items={TABS} activeTab={viewMode} onTabChange={handleViewModeChange}
					inert={initializing || backgroundInert || Boolean(selectedProject) || closingProject.current}
					onAdd={initializing || !suppressFab ? handleAdd : undefined} />

				<div className="pwa-project-layer" data-project-open={Boolean(selectedProject) || closingProject.current} data-pwa-back={Boolean(selectedProject) && !closingProject.current} inert={initializing}>
					<AnimatePresence initial={false} custom={navigationMotion} onExitComplete={finishProjectClose}>
						{selectedProject && <PwaNavigationScreen key={selectedProject} motion={navigationMotion} isProjectDetail>
							<div className="reminders-content">
								<ProjectDetailView
									project={selectedProject}
									headerMetaContent={headerMetaContent}
									backControl={<BackButton label="Back to projects" onClick={handleBackToProjects} />}
									navigationRightContent={headerRightContent?.(true)}
									belowHeaderContent={belowHeaderContent && <div className="pwa-below-header-content">{belowHeaderContent(true)}</div>}
									reminders={reminders}
									loadingContent={showLoadingIndicator ? <LoadingIndicator label="Loading reminders" /> : undefined}
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
							{(initializing || !suppressFab) && <div className="pwa-dock pwa-project-dock" inert={initializing || backgroundInert}><PwaDockAddButton section="reminders" onClick={handleAdd} className="pwa-project-fab" /></div>}
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
