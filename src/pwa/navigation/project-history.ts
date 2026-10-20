import { createDetailHistory } from './detail-history';

const projects = createDetailHistory({
	stackKey: 'reminderProjectStackId', detailKey: 'reminderProject',
	closedKey: 'reminderProjectList', parameter: 'project',
});

export const hasProjectHistory = projects.hasDetail;
export const dismissProjectHistory = projects.dismiss;

export function openProjectHistory(project: string): Promise<string | null> {
	const detail = new URL(location.href);
	detail.searchParams.delete('section');
	detail.searchParams.set('project', project);
	return projects.open(detail, project);
}
