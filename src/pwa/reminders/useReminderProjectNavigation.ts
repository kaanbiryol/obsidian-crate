import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewMode } from '@/reminders/ui/shared/remindersViewModel';
import type { NavigationMotion } from '../../ui/shared/navigation/NavigationScreen';
import { dismissProjectHistory, hasProjectHistory, openProjectHistory } from '../navigation/project-history';

/** Own project history, exit completion and focus restoration as one lifetime. */
export function useReminderProjectNavigation({ initialTab, requestedProject, reduceMotion }: {
	initialTab: ViewMode; requestedProject?: string; reduceMotion: boolean;
}) {
	const [initialProject] = useState(requestedProject);
	// Seed the screen from the launch destination. Applying it later via the dock
	// would show the default tab as an outgoing fade.
	const [viewMode, setViewMode] = useState<ViewMode>(() => initialProject ? 'browse' : initialTab);
	const [direction, setDirection] = useState<NavigationMotion['direction']>(0);
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

	// An open detail is replaced in place, so a request can switch projects.
	const showProject = useCallback(async (project: string) => {
		const stack = await openProjectHistory(project);
		if (!stack || new URL(location.href).searchParams.get('project') !== project) return;
		projectStack.current = stack;
		lastProject.current = project;
		setSkipProjectMotion(false);
		setDirection(1);
		setViewMode('browse');
		setSelectedProject(project);
	}, []);

	const handleProjectSelect = useCallback(async (project: string) => {
		if (selectedProject || closingProject.current) return;
		await showProject(project);
	}, [selectedProject, showProject]);

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

	// Follow later app requests (a launch reminder's project, a deleted project)
	// with the same push and pop as a tap, so the root screen stays mounted.
	const appliedProject = useRef(initialProject);
	useEffect(() => {
		const previous = appliedProject.current;
		if (requestedProject === previous) return;
		appliedProject.current = requestedProject;
		if (!requestedProject) {
			if (selectedProject && selectedProject === previous) handleBackToProjects();
		} else if (requestedProject !== selectedProject && !closingProject.current) {
			void showProject(requestedProject);
		}
	}, [requestedProject, selectedProject, handleBackToProjects, showProject]);

	return { viewMode, selectedProject, navigationMotion,
		projectOpen: Boolean(selectedProject) || closingProject.current,
		canGoBack: Boolean(selectedProject) && !closingProject.current,
		handleViewModeChange, handleProjectSelect, handleBackToProjects, finishProjectClose };
}
