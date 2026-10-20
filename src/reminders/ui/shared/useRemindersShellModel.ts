import { useCallback, useMemo, type ReactNode } from 'react';
import type { Reminder } from '@/reminders/types/reminder';
import {
	getCurrentHeaderData,
	getReminderCreateProject,
	getRemindersHeaderData,
	getReorderProject,
} from './remindersViewModel';
import { useReminderClock } from './useReminderClock';

type ViewMode = Parameters<typeof getCurrentHeaderData>[0];

/** Header, add, card and reorder behavior shared by the plugin and PWA shells.
 * Host chrome (navigation, buttons, safe areas) stays in each shell. */
export function useRemindersShellModel({ reminders, projects, upcomingDays, viewMode, selectedProject, renderCard, onAdd, onReorder, addDisabled = false }: {
	reminders: Reminder[];
	projects: string[];
	upcomingDays: number;
	viewMode: ViewMode;
	selectedProject: string | null;
	renderCard: (props: { reminder: Reminder; index: number; hideProject: boolean }) => ReactNode;
	onAdd: (defaultProject: string) => void;
	onReorder: (project: string, orderedIds: string[]) => Promise<void> | void;
	addDisabled?: boolean;
}) {
	const clock = useReminderClock(reminders);
	const headerData = useMemo(() => getRemindersHeaderData(reminders, projects, upcomingDays, clock.now), [reminders, projects, upcomingDays, clock]);
	const currentHeader = useMemo(() => getCurrentHeaderData(viewMode, headerData), [headerData, viewMode]);
	const handleAdd = useCallback(() => {
		if (!addDisabled) onAdd(getReminderCreateProject(viewMode, selectedProject));
	}, [addDisabled, onAdd, selectedProject, viewMode]);
	const panelCardRenderer = useCallback((reminder: Reminder, index: number) =>
		renderCard({ reminder, index, hideProject: viewMode === 'browse' && selectedProject !== null }), [renderCard, selectedProject, viewMode]);
	const listCardRenderer = useCallback((reminder: Reminder, index: number) =>
		renderCard({ reminder, index, hideProject: viewMode === 'inbox' }), [renderCard, viewMode]);
	const currentProject = getReorderProject(viewMode, selectedProject);
	const handleReorder = useCallback((orderedIds: string[]) => currentProject ? onReorder(currentProject, orderedIds) : undefined, [currentProject, onReorder]);
	return {
		currentHeader,
		primaryTab: viewMode === 'upcoming' ? 'today' : viewMode,
		handleAdd,
		panelCardRenderer,
		listCardRenderer,
		handleReorder,
	};
}
