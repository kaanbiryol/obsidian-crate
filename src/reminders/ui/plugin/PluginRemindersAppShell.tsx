import { DEFAULT_LIST_STYLE, type ListStyle } from '@/ui/shared/list-style';
import { AppDock, DockAddButton } from '@/ui/shared/navigation/AppDock';
import { DOCK_TABS } from '@/ui/shared/navigation/dock-destinations';
import { ScheduleSwitcher } from '@/ui/shared/navigation/ScheduleSwitcher';
import { TabTransition } from '@/ui/shared/navigation/TabTransition';
import { NavigationScreen } from '@/ui/shared/navigation/NavigationScreen';
import { PWA_CONTROL_SPRING } from '@/ui/shared/navigation/motion';
import { BackButton } from '@/ui/shared/BackButton';
import { ProjectDetailView } from '../views';
import type { TabId } from '../shared/layoutConstants';
import React, { useCallback, useMemo } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";

import { ThemeIcon } from "@/ui/shared/ThemeIcon";

import { ShadowDOMButton } from "@/reminders/ui/plugin/ShadowDOMButton";
import { ViewHeader } from "@/ui/shared/ViewHeader";
import type { Reminder } from "@/reminders/types/reminder";
import { RemindersViewPanels } from "@/reminders/ui/shared/RemindersViewPanels";
import { useReducedMotion } from "@/ui/shared/useReducedMotion";
import { useRemindersShellModel, type ReminderCardRenderer } from '../shared/useRemindersShellModel';
import {
	getReminderProjects,
	shouldShowReminderFab,
} from "@/reminders/ui/shared/remindersViewModel";
import { usePluginReminderProjectNavigation } from './usePluginReminderProjectNavigation';

interface PluginRemindersAppShellProps {
	listStyle?: ListStyle;
	reminders: Reminder[];
	projects?: string[];
	isInitialLoadComplete: boolean;
	isDarkMode: boolean;
	isFullScreen?: boolean;
	isModal?: boolean;
	isCompact?: boolean;
	initialTab?: TabId;
	initialProject?: string;
	hideTabBar?: boolean;
	upcomingDays: number;
	loadingContent?: React.ReactNode;
	activeTab?: TabId;
	onTabChange?: (tab: TabId) => void;
	renderNavigation?: (tab: TabId, onChange: (tab: TabId) => void, onAdd: (() => void) | undefined, inert: boolean) => React.ReactNode;
	headerRightContent?: React.ReactNode;
	renderHeader?: (title: string, actions: React.ReactNode) => React.ReactNode;
	belowHeaderContent?: React.ReactNode;
	topOverlay?: React.ReactNode;
	children?: React.ReactNode;
	className?: string;
	suppressFab?: boolean;
	renderCard: ReminderCardRenderer;
	onAdd: (defaultProject: string) => void;
	onReorder: (project: string, orderedIds: string[]) => Promise<void> | void;
	onReorderDragActiveChange?: (active: boolean) => void;
	reorderInteraction?: 'drag' | 'long-press';
}

/** Local navigation state with the same dock, date switcher and transitions as the PWA. */
export const PluginRemindersAppShell: React.FC<PluginRemindersAppShellProps> = ({
	listStyle = DEFAULT_LIST_STYLE,
	reminders,
	projects: providedProjects,
	isInitialLoadComplete,
	isDarkMode,
	isFullScreen = false,
	isModal = false,
	isCompact = false,
	initialTab,
	initialProject,
	hideTabBar = false,
	upcomingDays,
	loadingContent,
	activeTab,
	onTabChange,
	renderNavigation,
	headerRightContent,
	renderHeader,
	belowHeaderContent,
	topOverlay,
	children,
	className = "",
	suppressFab = false,
	renderCard,
	onAdd,
	onReorder,
	onReorderDragActiveChange,
	reorderInteraction = 'drag',
}) => {
	const { shell, viewMode, selectedProject, closingProject, direction,
		handleViewModeChange, handleProjectSelect, handleBackToProjects, finishProjectClose } = usePluginReminderProjectNavigation({
		initialTab, initialProject, activeTab, onTabChange,
	});
	const prefersReducedMotion = useReducedMotion();
	const projects = useMemo(() => providedProjects ?? getReminderProjects(reminders), [providedProjects, reminders]);

	const { currentHeader, primaryTab, handleAdd, panelCardRenderer, listCardRenderer, handleReorder } = useRemindersShellModel({
		reminders, projects, upcomingDays, viewMode, selectedProject, renderCard, onAdd, onReorder,
	});

	const showFab = shouldShowReminderFab(viewMode, selectedProject);
	const rootCovered = Boolean(selectedProject) || closingProject;


	const renderToggleButton = useCallback(({ onPress, showCompleted, count }: {
		onPress: () => void;
		showCompleted: boolean;
		count: number;
	}) => (
		<ShadowDOMButton
			variant="light"
			onPress={onPress}
			className="completed-section-toggle w-full justify-between h-10 px-0"
			endContent={
				<motion.span
					animate={{ rotate: showCompleted ? 180 : 0 }}
					transition={prefersReducedMotion ? { duration: 0 } : PWA_CONTROL_SPRING}
					className="inline-flex"
				>
					<ThemeIcon size="m" id="chevron-down" />
				</motion.span>
			}
		>
			<span className="reminders-muted-label">
				Completed ({count})
			</span>
		</ShadowDOMButton>
	), [prefersReducedMotion]);


	const viewPanels = (
		<RemindersViewPanels
			viewMode={viewMode}
			selectedProject={null}
			isInitialLoadComplete={isInitialLoadComplete}
			reminders={reminders}
			projects={projects}
			showFab={!suppressFab}
			upcomingDays={upcomingDays}
			renderCard={listCardRenderer}
			renderToggleButton={renderToggleButton}
			onProjectSelect={handleProjectSelect}
			onBackToProjects={handleBackToProjects}
			onReorder={handleReorder}
			onReorderDragActiveChange={onReorderDragActiveChange}
			colorScheme={isDarkMode ? 'dark' : 'light'}
			reorderInteraction={reorderInteraction}
			pageTransitionsEnabled={false}
			animationsEnabled={!prefersReducedMotion}
		/>
	);
	const initializing = !isInitialLoadComplete || Boolean(loadingContent);
	const add = initializing || !suppressFab ? handleAdd : undefined;
	return <MotionConfig reducedMotion={prefersReducedMotion ? 'always' : 'user'}>
		<div ref={shell} data-list-style={listStyle} className={[
			'reminders-view is-primary plugin-reminders-navigation',
			isDarkMode ? 'dark' : 'light', isFullScreen ? 'is-fullscreen' : '',
			isModal ? 'is-modal' : '', isCompact || hideTabBar ? 'is-compact' : '',
			prefersReducedMotion ? 'is-reduced-motion' : '',
			selectedProject ? 'is-project-detail' : `is-${viewMode}`, className,
		].filter(Boolean).join(' ')}>
			{renderHeader?.(selectedProject ?? currentHeader.title, headerRightContent)}
			{topOverlay}
			<div className="plugin-reminders-body">
			<div className="pwa-navigation-viewport" inert={rootCovered} aria-hidden={rootCovered || undefined}>
				<TabTransition viewKey={primaryTab}>
					{!renderHeader && <ViewHeader {...currentHeader} title={primaryTab === 'today' ? 'Reminders' : currentHeader.title}
						countUnit={viewMode === 'browse' ? 'project' : 'reminder'} large={isFullScreen}
						showMeta={isInitialLoadComplete && !loadingContent} reserveMetaSpace rightContent={headerRightContent} />}
					{(viewMode === 'today' || viewMode === 'upcoming') && <ScheduleSwitcher value={viewMode} onChange={handleViewModeChange} />}
					{belowHeaderContent}
					<div className="reminders-content">
						{loadingContent ?? (primaryTab === 'today' ? <TabTransition viewKey={viewMode}>{viewPanels}</TabTransition> : viewPanels)}
					</div>
				</TabTransition>
			</div>
			{!hideTabBar && (renderNavigation?.(viewMode, handleViewModeChange, add, initializing || rootCovered)
				?? <AppDock section="reminders" tabs={['inbox', 'today', 'browse']} destinations={DOCK_TABS.filter(item => ['inbox', 'today', 'browse'].includes(item.id))}
					activeTab={primaryTab} onSelect={tab => handleViewModeChange(tab as TabId)} onPin={tab => handleViewModeChange(tab as TabId)} onAdd={add} inert={initializing || rootCovered} />)}
			<div className="pwa-project-layer" data-project-open={rootCovered}>
				<AnimatePresence initial={false} custom={{ direction, reduceMotion: prefersReducedMotion }} onExitComplete={finishProjectClose}>
					{selectedProject && <NavigationScreen key={selectedProject} motion={{ direction, reduceMotion: prefersReducedMotion }} isProjectDetail>
						<div className="reminders-content">
							<ProjectDetailView project={selectedProject} hideTitle={Boolean(renderHeader)}
								backControl={<BackButton label="Back to projects" onClick={handleBackToProjects} />}
								navigationRightContent={renderHeader ? undefined : headerRightContent} belowHeaderContent={belowHeaderContent}
								reminders={reminders} loadingContent={loadingContent} onBack={handleBackToProjects}
								animationConfig={{ enabled: !prefersReducedMotion }} renderCard={panelCardRenderer}
								hasFab={showFab && !suppressFab} onReorder={handleReorder} onReorderDragActiveChange={onReorderDragActiveChange}
								colorScheme={isDarkMode ? 'dark' : 'light'} reorderInteraction={reorderInteraction} />
						</div>
						{add && <div className="pwa-dock pwa-project-dock" inert={initializing}><DockAddButton section="reminders" onClick={add} /></div>}
					</NavigationScreen>}
				</AnimatePresence>
			</div>
			</div>
			{children}
		</div>
	</MotionConfig>;
};
