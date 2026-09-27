import type { StartTab } from './types';

/** No account data: safe to use before enrollment or the cached shell loads. */
export function resolvePwaOpeningDestination(search: string, defaultScreen: unknown = 'today') {
	const tabs = ['inbox', 'today', 'upcoming', 'browse'];
	const params = new URLSearchParams(search);
	let tab: StartTab = tabs.includes(String(defaultScreen)) ? defaultScreen as StartTab : 'today';
	if (tabs.includes(params.get('tab') ?? '')) tab = params.get('tab') as StartTab;
	const project = params.get('project')?.trim() || null;
	if (project) tab = 'browse';
	const explicitReminder = params.get('section') === 'reminders' || tabs.includes(params.get('tab') ?? '')
		|| Boolean(project || params.get('reminderId') || params.get('token') || params.get('browserToken'));
	const readingDefault = defaultScreen === 'reading' || defaultScreen === 'favorites' || defaultScreen === 'archive';
	if (params.get('section') === 'reading' || (!explicitReminder && readingDefault)) {
		const readingTab = params.get('section') === 'reading' ? 'inbox' : defaultScreen === 'favorites' ? 'favorites' : defaultScreen === 'archive' ? 'archived' : 'inbox';
		return { tab: 'reading' as const, readingTab, project: null,
			title: readingTab === 'favorites' ? 'Favorites' : readingTab === 'archived' ? 'Archive' : 'Reading' } as const;
	}
	return { tab, project, title: project ?? { inbox: 'Inbox', today: 'Reminders', upcoming: 'Reminders', browse: 'Projects' }[tab] };
}
