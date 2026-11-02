import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { TabId } from '../shared/layoutConstants';
import type { ViewMode } from '@/reminders/ui/shared/remindersViewModel';

/** Local tab and project navigation for the plugin shell. A controlled
 * `activeTab` wins over the local tab; closing a project restores focus to its
 * button inside `shell` once the detail screen has exited. */
export function usePluginReminderProjectNavigation({ initialTab, initialProject, activeTab, onTabChange }: {
	initialTab?: TabId;
	initialProject?: string;
	activeTab?: TabId;
	onTabChange?: (tab: TabId) => void;
}) {
	const [localViewMode, setLocalViewMode] = useState<ViewMode>(initialProject ? "browse" : (initialTab ?? "inbox"));
	const [selectedProject, setSelectedProject] = useState<string | null>(initialProject ?? null);
	const [closingProject, setClosingProject] = useState(false);
	const [direction, setDirection] = useState<-1 | 0 | 1>(0);
	const shell = useRef<HTMLDivElement>(null);
	const lastProject = useRef(initialProject);
	const restoreProjectFocus = useRef(false);
	const viewMode = activeTab ?? localViewMode;
	const setViewMode = useCallback((tab: TabId) => {
		setLocalViewMode(tab);
		onTabChange?.(tab);
	}, [onTabChange]);
	const handleViewModeChange = useCallback((mode: ViewMode) => {
		setViewMode(mode);
		setSelectedProject(null);
	}, [setViewMode]);
	const handleProjectSelect = useCallback((project: string) => {
		lastProject.current = project;
		setDirection(1);
		setSelectedProject(project);
	}, []);
	const handleBackToProjects = useCallback(() => {
		restoreProjectFocus.current = true;
		setDirection(-1);
		setClosingProject(true);
		setSelectedProject(null);
	}, []);
	const finishProjectClose = () => setClosingProject(false);
	useLayoutEffect(() => {
		if (selectedProject || closingProject || !restoreProjectFocus.current) return;
		restoreProjectFocus.current = false;
		const button = Array.from(shell.current?.querySelectorAll<HTMLElement>('[data-action="open-project"]') ?? [])
			.find(candidate => candidate.dataset.project === lastProject.current);
		button?.focus({ preventScroll: true });
	}, [selectedProject, closingProject]);

	return {
		shell, viewMode, selectedProject, closingProject, direction,
		handleViewModeChange, handleProjectSelect, handleBackToProjects, finishProjectClose,
	};
}
