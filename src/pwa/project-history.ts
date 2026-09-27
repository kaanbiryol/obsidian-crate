import { createDetailStack, isCurrentDetailStack } from './detail-history';

interface ProjectHistoryEntry {
	reminderProject?: string;
	reminderProjectList?: boolean;
	reminderProjectStackId?: string;
}

export function hasProjectHistory(): boolean {
	return typeof (history.state as ProjectHistoryEntry | null)?.reminderProject === 'string';
}

export function openProjectHistory(project: string): string {
	const entry = history.state as ProjectHistoryEntry | null;
	const detail = new URL(location.href);
	detail.searchParams.delete('section');
	detail.searchParams.set('project', project);
	if (entry?.reminderProjectStackId && isCurrentDetailStack(entry.reminderProjectStackId)
		&& (entry.reminderProject || entry.reminderProjectList)) {
		history.replaceState({ reminderProject: project, reminderProjectStackId: entry.reminderProjectStackId }, '', detail);
		return entry.reminderProjectStackId;
	}
	const stackId = createDetailStack();
	const list = new URL(detail);
	list.searchParams.delete('project');
	history.replaceState({ reminderProjectStackId: stackId }, '', list);
	history.pushState({ reminderProject: project, reminderProjectStackId: stackId }, '', detail);
	return stackId;
}

/** Replace the forward detail slot after Back, so it cannot reopen a closed project. */
export function dismissProjectHistory(stackId: string | null): void {
	const entry = history.state as ProjectHistoryEntry | null;
	if (!stackId || entry?.reminderProjectStackId !== stackId || entry.reminderProject || entry.reminderProjectList
		|| new URL(location.href).searchParams.has('project')) return;
	history.pushState({ reminderProjectList: true, reminderProjectStackId: stackId }, '', location.href);
}
