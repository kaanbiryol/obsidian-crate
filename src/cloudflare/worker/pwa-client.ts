import { formatDateHeader, formatDueDate, isReminderOverdue } from '@/reminders/utils/dateFormatting';
import { getProjectColor } from '@/reminders/utils/projectColors';
import {
	getOverdueReminders,
	getTodayReminders,
	getUpcomingReminders,
	groupRemindersByDate,
	sortReminders,
	sortRemindersByFileOrder,
} from '@/reminders/utils/reminderSort';
import { PWA_ASSET_VERSION } from './pwa-version.gen';

type TabId = 'inbox' | 'today' | 'upcoming' | 'projects';

interface ReminderRecord {
	id: string;
	content: string;
	description?: string;
	dueDate?: string;
	dueDatetime?: string;
	priority: 1 | 4;
	completed: boolean;
	project: string;
	recurrence?: unknown;
	filePath: string;
	lineNumber?: number;
}

interface StoredConfig {
	folderPath: string;
	upcomingDays: number;
	allDayNotificationTime: string | null;
}

interface ModalState {
	mode: 'create' | 'edit';
	reminderId?: string;
}

interface ToastState {
	kind: 'success' | 'error' | 'info';
	message: string;
}

interface PushState {
	supported: boolean;
	subscribed: boolean;
	status: string | null;
}

interface AppState {
	authToken: string | null;
	config: StoredConfig;
	reminders: ReminderRecord[];
	projects: string[];
	activeTab: TabId;
	selectedProject: string | null;
	showCompleted: boolean;
	settingsOpen: boolean;
	loading: boolean;
	saving: boolean;
	error: string | null;
	modal: ModalState | null;
	toast: ToastState | null;
	push: PushState;
}

const AUTH_TOKEN_KEY = 'crate-reminders-auth-token';
const CONFIG_KEY = 'crate-reminders-config';

const root = document.getElementById('app');

if (!root) {
	throw new Error('Missing #app root');
}

const defaultConfig: StoredConfig = {
	folderPath: 'Reminders',
	upcomingDays: 7,
	allDayNotificationTime: null,
};

const state: AppState = {
	authToken: localStorage.getItem(AUTH_TOKEN_KEY),
	config: loadStoredConfig(),
	reminders: [],
	projects: [],
	activeTab: 'inbox',
	selectedProject: null,
	showCompleted: false,
	settingsOpen: false,
	loading: true,
	saving: false,
	error: null,
	modal: null,
	toast: null,
	push: {
		supported: false,
		subscribed: false,
		status: null,
	},
};

let toastTimer: number | null = null;

function loadStoredConfig(): StoredConfig {
	try {
		const raw = localStorage.getItem(CONFIG_KEY);
		if (!raw) return { ...defaultConfig };
		const parsed = JSON.parse(raw) as Partial<StoredConfig>;
		return {
			folderPath: typeof parsed.folderPath === 'string' && parsed.folderPath.trim()
				? parsed.folderPath.trim()
				: defaultConfig.folderPath,
			upcomingDays: typeof parsed.upcomingDays === 'number' && Number.isInteger(parsed.upcomingDays) && parsed.upcomingDays > 0
				? parsed.upcomingDays
				: defaultConfig.upcomingDays,
			allDayNotificationTime: typeof parsed.allDayNotificationTime === 'string' && parsed.allDayNotificationTime.length === 5
				? parsed.allDayNotificationTime
				: null,
		};
	} catch {
		return { ...defaultConfig };
	}
}

function saveConfig(): void {
	localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
}

function scrollToTop(): void {
	window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setToast(kind: ToastState['kind'], message: string): void {
	state.toast = { kind, message };
	render();
	if (toastTimer !== null) {
		window.clearTimeout(toastTimer);
	}
	toastTimer = window.setTimeout(() => {
		state.toast = null;
		render();
	}, 3200);
}

function escapeHtml(value: string | undefined | null): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function detectDeviceName(): string {
	const ua = navigator.userAgent;
	if (/iPhone/i.test(ua)) return 'iPhone';
	if (/iPad/i.test(ua)) return 'iPad';
	if (/Android/i.test(ua)) return 'Android';
	if (/Mac/i.test(ua)) return 'Mac';
	if (/Windows/i.test(ua)) return 'Windows';
	return 'Web';
}

function currentQueryParams(): URLSearchParams {
	return new URLSearchParams(window.location.search);
}

function isStandaloneApp(): boolean {
	return window.matchMedia('(display-mode: standalone)').matches
		|| Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function applyConfigFromUrl(): string | null {
	const params = currentQueryParams();
	const token = params.get('token');
	const folderPath = params.get('folder');
	const upcomingDays = params.get('upcomingDays');
	const allDayTime = params.get('allDayTime');
	const project = params.get('project');

	if (folderPath) {
		state.config.folderPath = folderPath;
	}
	if (upcomingDays) {
		const parsedDays = Number.parseInt(upcomingDays, 10);
		if (Number.isInteger(parsedDays) && parsedDays > 0) {
			state.config.upcomingDays = parsedDays;
		}
	}
	if (allDayTime) {
		state.config.allDayNotificationTime = /^\d{2}:\d{2}$/.test(allDayTime) ? allDayTime : null;
	}
	if (project) {
		state.activeTab = 'projects';
		state.selectedProject = project;
	}

	saveConfig();
	return token;
}

async function exchangeEnrollmentToken(token: string): Promise<void> {
	const response = await fetch('/notifications/reminders-exchange', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			token,
			deviceName: detectDeviceName(),
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(body || response.statusText);
	}

	const result = await response.json() as { authToken?: string };
	if (!result.authToken) {
		throw new Error('Missing auth token');
	}

	state.authToken = result.authToken;
	localStorage.setItem(AUTH_TOKEN_KEY, result.authToken);
}

function replaceBrowserUrlWithInstallToken(token: string): void {
	const params = currentQueryParams();
	params.set('token', token);
	params.set('folder', state.config.folderPath);
	params.set('upcomingDays', String(state.config.upcomingDays));
	if (state.config.allDayNotificationTime) {
		params.set('allDayTime', state.config.allDayNotificationTime);
	} else {
		params.delete('allDayTime');
	}

	const query = params.toString();
	history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const token = state.authToken;
	if (!token) {
		throw new Error('Not authenticated');
	}

	const headers = new Headers(init.headers ?? {});
	headers.set('Authorization', `Bearer ${token}`);
	if (!headers.has('Content-Type') && init.body) {
		headers.set('Content-Type', 'application/json');
	}

	const response = await fetch(path, {
		...init,
		headers,
	});

	if (response.status === 401) {
		logOut(false);
		throw new Error('Session expired. Open a fresh link from Crate.');
	}

	return response;
}

async function refreshInstallActivationUrl(): Promise<void> {
	if (!state.authToken || isStandaloneApp()) {
		return;
	}

	const response = await apiFetch('/notifications/reminders-enrollment-token', {
		method: 'POST',
	});
	if (!response.ok) {
		throw new Error(await response.text());
	}

	const result = await response.json() as { token?: string };
	if (!result.token) {
		throw new Error('Missing install token');
	}

	replaceBrowserUrlWithInstallToken(result.token);
}

async function loadReminders(): Promise<void> {
	state.loading = true;
	state.error = null;
	render();

	try {
		const response = await apiFetch(`/reminders/list?folderPath=${encodeURIComponent(state.config.folderPath)}`);
		if (!response.ok) {
			throw new Error(await response.text());
		}

		const result = await response.json() as {
			reminders?: ReminderRecord[];
			projects?: string[];
		};
		state.reminders = Array.isArray(result.reminders) ? result.reminders : [];
		state.projects = Array.isArray(result.projects) ? result.projects : [];
		if (state.selectedProject && !state.projects.includes(state.selectedProject)) {
			state.selectedProject = null;
		}
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
	} finally {
		state.loading = false;
		render();
	}
}

function reminderDateValue(reminder: ReminderRecord): string | undefined {
	return reminder.dueDatetime || reminder.dueDate;
}

function reminderViewData(): {
	title: string;
	subtitle: string;
	overduePill?: string;
	reminders: ReminderRecord[];
	dateGroups: Array<{ date: Date; reminders: ReminderRecord[] }>;
	reorderProject: string | null;
	showFab: boolean;
	showProjectsList: boolean;
} {
	const reminders = state.reminders;
	const inboxReminders = reminders.filter((reminder) => reminder.project === 'Inbox');
	const overdueCount = getOverdueReminders(reminders).length;

	if (state.activeTab === 'projects' && state.selectedProject) {
		const projectReminders = sortRemindersByFileOrder(
			reminders.filter((reminder) => reminder.project === state.selectedProject),
		);
		return {
			title: state.selectedProject,
			subtitle: `${projectReminders.filter((reminder) => !reminder.completed).length} reminders`,
			reminders: projectReminders,
			dateGroups: [],
			reorderProject: state.selectedProject,
			showFab: true,
			showProjectsList: false,
		};
	}

	switch (state.activeTab) {
		case 'today': {
			const unique = new Map<string, ReminderRecord>();
			for (const reminder of [...getOverdueReminders(reminders), ...getTodayReminders(reminders)]) {
				unique.set(reminder.id, reminder);
			}
			const todayReminders = sortReminders(Array.from(unique.values()));
			return {
				title: 'Today',
				subtitle: `${todayReminders.length} reminders`,
				overduePill: overdueCount > 0 ? `${overdueCount} overdue` : undefined,
				reminders: todayReminders,
				dateGroups: [],
				reorderProject: null,
				showFab: true,
				showProjectsList: false,
			};
		}
		case 'upcoming': {
			const upcomingReminders = sortReminders(getUpcomingReminders(reminders, state.config.upcomingDays));
			return {
				title: 'Upcoming',
				subtitle: `Next ${state.config.upcomingDays} days`,
				overduePill: overdueCount > 0 ? `${overdueCount} overdue` : undefined,
				reminders: upcomingReminders,
				dateGroups: groupRemindersByDate(upcomingReminders),
				reorderProject: null,
				showFab: true,
				showProjectsList: false,
			};
		}
		case 'projects':
			return {
				title: 'Projects',
				subtitle: `${state.projects.length} projects`,
				reminders: [],
				dateGroups: [],
				reorderProject: null,
				showFab: false,
				showProjectsList: true,
			};
		case 'inbox':
		default:
			return {
				title: 'Inbox',
				subtitle: `${inboxReminders.filter((reminder) => !reminder.completed).length} reminders`,
				overduePill: overdueCount > 0 ? `${overdueCount} overdue` : undefined,
				reminders: sortRemindersByFileOrder(inboxReminders),
				dateGroups: [],
				reorderProject: 'Inbox',
				showFab: true,
				showProjectsList: false,
			};
	}
}

function icon(name: 'inbox' | 'today' | 'upcoming' | 'projects' | 'plus' | 'check' | 'clock' | 'hash' | 'drag' | 'back' | 'settings' | 'bell' | 'close'): string {
	const icons: Record<string, string> = {
		inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 13h3l2 3h6l2-3h3"/><path d="M5 5h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l2-8Z"/></svg>',
		today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
		upcoming: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h3M8 18h8"/></svg>',
		projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h5l2 2h11v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
		plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>',
		check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12.5 9.2 17 19 7"/></svg>',
		clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>',
		hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 9h14M5 15h14M9 3 7 21M17 3l-2 18"/></svg>',
		drag: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
		back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>',
		settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.5"/></svg>',
		bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
		close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6 6 18"/></svg>',
	};
	return icons[name];
}

function renderProjectCards(): string {
	const cards = state.projects.map((project) => {
		const projectReminders = state.reminders.filter((reminder) => reminder.project === project);
		const activeCount = projectReminders.filter((reminder) => !reminder.completed).length;
		const overdueCount = getOverdueReminders(projectReminders).length;
		const colors = getProjectColor(project);
		return `
			<button class="project-card" type="button" data-action="open-project" data-project="${escapeHtml(project)}">
				<div class="project-card__row">
					<div>
						<div class="project-card__title">${escapeHtml(project)}</div>
						<div class="project-card__meta">${activeCount} reminders${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}</div>
					</div>
					<span class="tag-pill" style="--pill-rgb:${colors.dark.accentRgb};--pill-color:${colors.dark.accent};">
						${icon('hash')} ${escapeHtml(project)}
					</span>
				</div>
			</button>
		`;
	}).join('');

	return cards || '<div class="empty-state"><h2>No projects yet</h2><p>Add a reminder with a project to get started.</p></div>';
}

function renderReminderCard(reminder: ReminderRecord, reorderable: boolean): string {
	const dueValue = reminderDateValue(reminder);
	const dueText = formatDueDate(dueValue);
	const overdue = isReminderOverdue(reminder);
	const projectColors = getProjectColor(reminder.project);
	const showProject = !(state.activeTab === 'projects' && state.selectedProject);
	const dragHandle = reorderable && !reminder.completed
		? `<button class="card-handle" data-drag-handle type="button" aria-label="Reorder reminder">${icon('drag')}</button>`
		: '';

	return `
		<div class="reminder-card${reminder.completed ? ' is-completed' : ''}" data-reminder-id="${escapeHtml(reminder.id)}">
			<div class="reminder-card__main">
				<button class="checkbox${reminder.completed ? ' is-checked' : ''}" data-action="toggle-complete" data-id="${escapeHtml(reminder.id)}" data-completed="${reminder.completed ? 'true' : 'false'}" type="button" aria-label="${reminder.completed ? 'Mark incomplete' : 'Mark complete'}">
					${reminder.completed ? icon('check') : ''}
				</button>
				<button class="card-body" data-action="edit-reminder" data-id="${escapeHtml(reminder.id)}" type="button">
					<div class="card-title-row">
						<span class="card-title">${escapeHtml(reminder.content)}</span>
						${reminder.priority === 1 && !reminder.completed ? '<span class="priority-pill">important</span>' : ''}
					</div>
					${reminder.description ? `<div class="card-description">${escapeHtml(reminder.description)}</div>` : ''}
					<div class="card-pills">
						${dueText ? `<span class="meta-pill${overdue ? ' is-overdue' : ''}">${icon('clock')} ${escapeHtml(dueText)}</span>` : ''}
						${showProject ? `<span class="tag-pill" style="--pill-rgb:${projectColors.dark.accentRgb};--pill-color:${projectColors.dark.accent};">${icon('hash')} ${escapeHtml(reminder.project)}</span>` : ''}
					</div>
				</button>
				${dragHandle}
			</div>
		</div>
	`;
}

function splitCompleted(reminders: ReminderRecord[]): { active: ReminderRecord[]; completed: ReminderRecord[] } {
	return {
		active: reminders.filter((reminder) => !reminder.completed),
		completed: reminders.filter((reminder) => reminder.completed),
	};
}

function renderReminderList(reminders: ReminderRecord[], reorderProject: string | null): string {
	const { active, completed } = splitCompleted(reminders);
	if (active.length === 0 && completed.length === 0) {
		return '<div class="empty-state"><h2>Nothing here</h2><p>Add a reminder to get started.</p></div>';
	}

	return `
		<div class="reminders-stack">
			<div class="reorder-list" ${reorderProject ? `data-reorder-list="true" data-project="${escapeHtml(reorderProject)}"` : ''}>
				${active.map((reminder) => renderReminderCard(reminder, !!reorderProject)).join('')}
			</div>
			${completed.length > 0 ? `
				<div class="completed-section">
					<button class="completed-toggle" data-action="toggle-completed" type="button">
						<span>Completed (${completed.length})</span>
						<span class="chevron${state.showCompleted ? ' is-open' : ''}">⌄</span>
					</button>
					${state.showCompleted ? `<div class="completed-list">${completed.map((reminder) => renderReminderCard(reminder, false)).join('')}</div>` : ''}
				</div>
			` : ''}
		</div>
	`;
}

function renderUpcomingGroups(dateGroups: Array<{ date: Date; reminders: ReminderRecord[] }>): string {
	if (dateGroups.length === 0) {
		return '<div class="empty-state"><h2>No upcoming reminders</h2><p>Schedule something for the future.</p></div>';
	}

	return dateGroups.map((group) => `
		<section class="date-group">
			<h2 class="date-group__title">${escapeHtml(formatDateHeader(group.date))}</h2>
			${renderReminderList(group.reminders, null)}
		</section>
	`).join('');
}

function renderModal(): string {
	if (!state.modal) return '';
	const reminder = state.modal.reminderId
		? state.reminders.find((item) => item.id === state.modal?.reminderId)
		: null;
	const title = state.modal.mode === 'create' ? 'Add reminder' : 'Edit reminder';
	const date = reminder?.dueDatetime
		? new Date(reminder.dueDatetime)
		: reminder?.dueDate
			? new Date(`${reminder.dueDate}T00:00:00`)
			: null;
	const dateValue = date
		? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
		: '';
	const timeValue = reminder?.dueDatetime
		? `${String(date?.getHours() ?? 0).padStart(2, '0')}:${String(date?.getMinutes() ?? 0).padStart(2, '0')}`
		: '';

	return `
		<div class="modal-backdrop" data-action="close-modal">
			<div class="modal-card" role="dialog" aria-modal="true">
				<form class="modal-form" data-action="save-reminder" data-mode="${state.modal.mode}" ${reminder ? `data-id="${escapeHtml(reminder.id)}"` : ''}>
						<div class="modal-header">
							<h2>${title}</h2>
							<button class="icon-button" type="button" data-action="close-modal" aria-label="Close modal">${icon('close')}</button>
						</div>
					<label class="field">
						<span>Title</span>
						<input name="content" type="text" maxlength="1024" required value="${escapeHtml(reminder?.content ?? '')}" placeholder="What do you need to remember?" />
					</label>
					<label class="field">
						<span>Description</span>
						<textarea name="description" rows="3" maxlength="4096" placeholder="Optional details">${escapeHtml(reminder?.description ?? '')}</textarea>
					</label>
					<div class="field-row">
						<label class="field">
							<span>Project</span>
							<input name="project" type="text" maxlength="256" value="${escapeHtml(reminder?.project ?? (state.selectedProject ?? 'Inbox'))}" />
						</label>
						<label class="field">
							<span>Priority</span>
							<select name="priority">
								<option value="4" ${reminder?.priority === 4 || !reminder ? 'selected' : ''}>Normal</option>
								<option value="1" ${reminder?.priority === 1 ? 'selected' : ''}>Important</option>
							</select>
						</label>
					</div>
					<div class="field-row">
						<label class="field">
							<span>Date</span>
							<input name="dueDate" type="date" value="${escapeHtml(dateValue)}" />
						</label>
						<label class="field">
							<span>Time</span>
							<input name="dueTime" type="time" value="${escapeHtml(timeValue)}" />
						</label>
					</div>
					<div class="modal-actions">
						${state.modal.mode === 'edit' ? '<button class="secondary-button is-danger" type="button" data-action="delete-reminder">Delete</button>' : '<span></span>'}
						<div class="modal-actions__primary">
							<button class="secondary-button" type="button" data-action="close-modal">Cancel</button>
								<button class="primary-button" type="submit" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving...' : 'Save'}</button>
						</div>
					</div>
				</form>
			</div>
		</div>
	`;
}

function renderHeader(title: string, subtitle: string, overduePill?: string): string {
	const showBack = state.activeTab === 'projects' && state.selectedProject;
	return `
		<header class="app-header">
			<div class="app-header__top">
				${showBack
					? `<button class="icon-button" type="button" data-action="back-to-projects">${icon('back')}</button>`
					: '<span class="header-spacer" aria-hidden="true"></span>'}
				<div class="header-actions">
					<button class="icon-button${state.settingsOpen ? ' is-active' : ''}" type="button" data-action="toggle-settings" aria-label="Open settings">
						${icon('settings')}
					</button>
				</div>
			</div>
			<div class="app-header__body">
				<h1>${escapeHtml(title)}</h1>
				<div class="header-meta">
					<span>${escapeHtml(subtitle)}</span>
					${overduePill ? `<span class="overdue-pill">${escapeHtml(overduePill)}</span>` : ''}
				</div>
			</div>
		</header>
	`;
}

function renderSettingsPanel(): string {
	if (!state.settingsOpen) {
		return '';
	}

	const isStandalone = isStandaloneApp();
	const installHint = /iPad|iPhone|iPod/.test(navigator.userAgent) && !isStandalone
		? 'Add this app to your Home Screen from Safari to enable the best mobile experience and notifications on iPhone.'
		: isStandalone
			? 'This device is using the installed app experience.'
			: 'You can also install this app from your browser for faster access.';

	return `
		<div class="settings-backdrop" data-action="close-settings"></div>
		<aside class="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
			<div class="settings-sheet__header">
				<div>
					<h2>Settings</h2>
					<p>Reminders, notifications, and install status for this device.</p>
				</div>
				<button class="icon-button" type="button" data-action="close-settings" aria-label="Close settings">${icon('close')}</button>
			</div>
			<div class="settings-panel">
				<div class="settings-panel__section">
					<div class="settings-panel__title">Notifications</div>
					<div class="settings-panel__row">
						<span>${state.push.subscribed ? 'Enabled' : 'Disabled'}</span>
						<button class="secondary-button" type="button" data-action="enable-push" ${!state.push.supported || state.push.subscribed ? 'disabled' : ''}>
							${state.push.subscribed ? 'Enabled' : 'Enable'}
						</button>
					</div>
					${state.push.status ? `<p class="settings-panel__hint">${escapeHtml(state.push.status)}</p>` : ''}
				</div>
				<div class="settings-panel__section">
					<div class="settings-panel__title">Install</div>
					<p class="settings-panel__hint">${escapeHtml(installHint)}</p>
				</div>
				<div class="settings-panel__section">
					<div class="settings-panel__title">Web app</div>
					<div class="settings-panel__row">
						<span>Folder</span>
						<code>${escapeHtml(state.config.folderPath)}</code>
					</div>
					<div class="settings-panel__row">
						<span>Upcoming days</span>
						<code>${state.config.upcomingDays}</code>
					</div>
					<div class="settings-panel__row">
						<span>All-day time</span>
						<code>${escapeHtml(state.config.allDayNotificationTime ?? 'none')}</code>
					</div>
					<div class="settings-panel__actions">
						<button class="secondary-button" type="button" data-action="refresh">Refresh</button>
						<button class="secondary-button is-danger" type="button" data-action="logout">Log out</button>
					</div>
				</div>
			</div>
		</aside>
	`;
}

function renderTabs(): string {
	const tabs: Array<{ id: TabId; label: string; iconName: Parameters<typeof icon>[0] }> = [
		{ id: 'inbox', label: 'Inbox', iconName: 'inbox' },
		{ id: 'today', label: 'Today', iconName: 'today' },
		{ id: 'upcoming', label: 'Upcoming', iconName: 'upcoming' },
		{ id: 'projects', label: 'Projects', iconName: 'projects' },
	];

	return `
		<nav class="bottom-tabs">
			${tabs.map((tab) => `
				<button class="tab-button${state.activeTab === tab.id ? ' is-active' : ''}" type="button" data-action="switch-tab" data-tab="${tab.id}">
					<span class="tab-button__icon">${icon(tab.iconName)}</span>
					<span>${tab.label}</span>
				</button>
			`).join('')}
		</nav>
	`;
}

function renderAuthenticatedApp(): string {
	const view = reminderViewData();
	const body = view.showProjectsList
		? renderProjectCards()
		: state.activeTab === 'upcoming'
			? renderUpcomingGroups(view.dateGroups)
			: renderReminderList(view.reminders, view.reorderProject);

	return `
		<div class="app-shell">
			${renderHeader(view.title, view.subtitle, view.overduePill)}
			<main class="app-content">
				${state.loading ? '<div class="loading-card">Loading reminders…</div>' : body}
			</main>
			${renderSettingsPanel()}
			${renderTabs()}
			${view.showFab ? `<button class="fab" type="button" data-action="open-create-modal" aria-label="Add reminder">${icon('plus')}</button>` : ''}
			${renderModal()}
			${state.toast ? `<div class="toast is-${state.toast.kind}">${escapeHtml(state.toast.message)}</div>` : ''}
		</div>
	`;
}

function renderEmptyAuthState(): string {
	return `
		<div class="auth-card">
			<h1>Crate Reminders</h1>
			<p>Open a fresh link from Crate to activate this web app on your device.</p>
		</div>
	`;
}

function renderErrorState(): string {
	return `
		<div class="auth-card">
			<h1>Crate Reminders</h1>
			<p>${escapeHtml(state.error ?? 'Something went wrong.')}</p>
			<button class="primary-button" type="button" data-action="refresh">Retry</button>
		</div>
	`;
}

function render(): void {
	if (!state.authToken) {
		root.innerHTML = state.error ? renderErrorState() : renderEmptyAuthState();
		return;
	}

	root.innerHTML = renderAuthenticatedApp();
	attachReorderController();
}

function openModal(mode: ModalState['mode'], reminderId?: string): void {
	state.modal = { mode, reminderId };
	state.settingsOpen = false;
	state.saving = false;
	render();
}

function closeModal(): void {
	state.modal = null;
	state.saving = false;
	render();
}

function buildMutationBody(form: HTMLFormElement): Record<string, unknown> {
	const formData = new FormData(form);
	const rawDate = String(formData.get('dueDate') || '').trim();
	const rawTime = String(formData.get('dueTime') || '').trim();
	const project = String(formData.get('project') || '').trim() || 'Inbox';
	const priority = Number.parseInt(String(formData.get('priority') || '4'), 10) === 1 ? 1 : 4;

	let dueDate: string | null = null;
	let dueDatetime: string | null = null;
	if (rawDate && rawTime) {
		dueDatetime = new Date(`${rawDate}T${rawTime}`).toISOString();
	} else if (rawDate) {
		dueDate = rawDate;
	}

	return {
		folderPath: state.config.folderPath,
		allDayNotificationTime: state.config.allDayNotificationTime,
		content: String(formData.get('content') || '').trim(),
		description: String(formData.get('description') || '').trim() || null,
		project,
		priority,
		dueDate,
		dueDatetime,
	};
}

async function saveReminder(form: HTMLFormElement): Promise<void> {
	state.saving = true;
	render();

	try {
		const body = buildMutationBody(form);
		const reminderId = form.dataset.id;
		const path = form.dataset.mode === 'edit' && reminderId
			? '/reminders/update'
			: '/reminders/create';

		if (reminderId) {
			body.id = reminderId;
		}

		const response = await apiFetch(path, {
			method: 'POST',
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(await response.text());
		}

		const result = await response.json() as { notificationWarning?: string };
		closeModal();
		await loadReminders();
		if (result.notificationWarning) {
			setToast('info', `Saved. Notification sync failed: ${result.notificationWarning}`);
		} else {
			setToast('success', 'Reminder saved');
		}
	} catch (error) {
		state.saving = false;
		render();
		setToast('error', error instanceof Error ? error.message : String(error));
	}
}

async function toggleReminderCompleted(reminderId: string, completed: boolean): Promise<void> {
	try {
		const response = await apiFetch('/reminders/set-completed', {
			method: 'POST',
			body: JSON.stringify({
				folderPath: state.config.folderPath,
				allDayNotificationTime: state.config.allDayNotificationTime,
				id: reminderId,
				completed: !completed,
			}),
		});
		if (!response.ok) {
			throw new Error(await response.text());
		}

		const result = await response.json() as { notificationWarning?: string };
		await loadReminders();
		if (result.notificationWarning) {
			setToast('info', `Updated. Notification sync failed: ${result.notificationWarning}`);
		}
	} catch (error) {
		setToast('error', error instanceof Error ? error.message : String(error));
	}
}

async function deleteReminder(reminderId: string): Promise<void> {
	try {
		const response = await apiFetch('/reminders/delete', {
			method: 'DELETE',
			body: JSON.stringify({
				folderPath: state.config.folderPath,
				id: reminderId,
			}),
		});
		if (!response.ok) {
			throw new Error(await response.text());
		}

		closeModal();
		await loadReminders();
		setToast('success', 'Reminder deleted');
	} catch (error) {
		setToast('error', error instanceof Error ? error.message : String(error));
	}
}

async function persistReorder(project: string, orderedIds: string[]): Promise<void> {
	try {
		const response = await apiFetch('/reminders/reorder', {
			method: 'POST',
			body: JSON.stringify({
				folderPath: state.config.folderPath,
				project,
				orderedIds,
			}),
		});
		if (!response.ok) {
			throw new Error(await response.text());
		}
		await loadReminders();
	} catch (error) {
		setToast('error', error instanceof Error ? error.message : String(error));
	}
}

function logOut(showToast: boolean): void {
	localStorage.removeItem(AUTH_TOKEN_KEY);
	state.authToken = null;
	state.reminders = [];
	state.projects = [];
	state.selectedProject = null;
	state.settingsOpen = false;
	state.modal = null;
	state.error = showToast ? null : state.error;
	render();
	if (showToast) {
		setToast('info', 'Logged out');
	}
}

async function refreshPushState(): Promise<void> {
	const isStandalone = isStandaloneApp();
	const supported = 'serviceWorker' in navigator && 'PushManager' in window;
	state.push.supported = supported;
	if (!supported) {
		state.push.status = 'Push notifications are not supported in this browser.';
		render();
		return;
	}

	if (!isStandalone && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
		state.push.status = 'Install this app on your home screen to enable push notifications on iOS.';
		render();
		return;
	}

	const registration = await navigator.serviceWorker.register(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`);
	const subscription = await registration.pushManager.getSubscription();
	state.push.subscribed = !!subscription;
	state.push.status = subscription ? 'Notifications enabled on this device.' : null;
	render();
}

async function enablePushNotifications(): Promise<void> {
	try {
		if (!state.push.supported) {
			throw new Error('Push is not supported on this device.');
		}

		const registration = await navigator.serviceWorker.register(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`);
		const keyResponse = await fetch('/notifications/vapid-public-key');
		const { publicKey } = await keyResponse.json() as { publicKey?: string };
		if (!publicKey) {
			throw new Error('Missing VAPID public key');
		}

		const subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey),
		});
		const body = subscription.toJSON();
		const response = await apiFetch('/notifications/subscribe', {
			method: 'POST',
			body: JSON.stringify({
				endpoint: body.endpoint,
				keys: body.keys,
				deviceName: detectDeviceName(),
			}),
		});
		if (!response.ok) {
			throw new Error(await response.text());
		}

		state.push.subscribed = true;
		state.push.status = 'Notifications enabled on this device.';
		render();
		setToast('success', 'Notifications enabled');
	} catch (error) {
		state.push.status = error instanceof Error ? error.message : String(error);
		render();
		setToast('error', state.push.status);
	}
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
	return outputArray;
}

function attachReorderController(): void {
	const list = root.querySelector<HTMLElement>('[data-reorder-list="true"]');
	if (!list) return;
	const project = list.dataset.project;
	if (!project) return;

	let draggedItem: HTMLElement | null = null;
	let placeholder: HTMLElement | null = null;
	let pointerStartY = 0;
	let itemStartTop = 0;
	let listRect: DOMRect | null = null;

	const startDrag = (event: PointerEvent): void => {
		const handle = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-drag-handle]') : null;
		if (!handle) return;
		const item = handle.closest<HTMLElement>('[data-reminder-id]');
		if (!item) return;

		event.preventDefault();
		draggedItem = item;
		const itemRect = item.getBoundingClientRect();
		listRect = list.getBoundingClientRect();
		pointerStartY = event.clientY;
		itemStartTop = itemRect.top;

		placeholder = document.createElement('div');
		placeholder.className = 'reminder-card placeholder-card';
		placeholder.style.height = `${itemRect.height}px`;
		item.parentElement?.insertBefore(placeholder, item.nextSibling);

		item.classList.add('is-dragging');
		item.style.width = `${itemRect.width}px`;
		item.style.position = 'fixed';
		item.style.left = `${itemRect.left}px`;
		item.style.top = `${itemRect.top}px`;
		item.style.zIndex = '60';
		item.style.pointerEvents = 'none';
		item.setPointerCapture(event.pointerId);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp, { once: true });
	};

	const onPointerMove = (event: PointerEvent): void => {
		if (!draggedItem || !placeholder || !listRect) return;
		const deltaY = event.clientY - pointerStartY;
		draggedItem.style.top = `${itemStartTop + deltaY}px`;
		const siblings = Array.from(list.querySelectorAll<HTMLElement>('[data-reminder-id]')).filter((item) => item !== draggedItem);

		for (const sibling of siblings) {
			const siblingRect = sibling.getBoundingClientRect();
			const midpoint = siblingRect.top + siblingRect.height / 2;
			if (event.clientY < midpoint) {
				if (placeholder !== sibling.previousElementSibling) {
					list.insertBefore(placeholder, sibling);
				}
				return;
			}
		}

		list.appendChild(placeholder);
	};

	const onPointerUp = (): void => {
		window.removeEventListener('pointermove', onPointerMove);
		if (!draggedItem || !placeholder) {
			return;
		}

		list.insertBefore(draggedItem, placeholder);
		draggedItem.classList.remove('is-dragging');
		draggedItem.style.position = '';
		draggedItem.style.left = '';
		draggedItem.style.top = '';
		draggedItem.style.width = '';
		draggedItem.style.zIndex = '';
		draggedItem.style.pointerEvents = '';
		placeholder.remove();

		const orderedIds = Array.from(list.querySelectorAll<HTMLElement>('[data-reminder-id]'))
			.map((item) => item.dataset.reminderId || '')
			.filter((id) => id.length > 0);

		draggedItem = null;
		placeholder = null;
		listRect = null;
		void persistReorder(project, orderedIds);
	};

	list.addEventListener('pointerdown', startDrag, { passive: false });
}

root.addEventListener('click', (event) => {
	const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-action]') : null;
	if (!target) return;
	const action = target.dataset.action;

	switch (action) {
		case 'switch-tab': {
			const nextTab = target.dataset.tab as TabId | undefined;
			if (!nextTab) return;
			state.activeTab = nextTab;
			state.settingsOpen = false;
			state.showCompleted = false;
			if (nextTab !== 'projects') {
				state.selectedProject = null;
			}
			render();
			scrollToTop();
			return;
		}
		case 'open-project': {
			const project = target.dataset.project;
			if (!project) return;
			state.activeTab = 'projects';
			state.selectedProject = project;
			state.showCompleted = false;
			state.settingsOpen = false;
			render();
			scrollToTop();
			return;
		}
		case 'back-to-projects':
			state.selectedProject = null;
			state.showCompleted = false;
			state.settingsOpen = false;
			render();
			scrollToTop();
			return;
		case 'toggle-completed':
			state.showCompleted = !state.showCompleted;
			render();
			return;
		case 'open-create-modal':
			openModal('create');
			return;
		case 'edit-reminder': {
			const id = target.dataset.id;
			if (!id) return;
			openModal('edit', id);
			return;
		}
		case 'close-modal':
			if (target.classList.contains('modal-backdrop') || target.dataset.action === 'close-modal') {
				closeModal();
			}
			return;
		case 'close-settings':
			state.settingsOpen = false;
			render();
			return;
		case 'delete-reminder': {
			const id = state.modal?.reminderId;
			if (!id) return;
			const confirmed = window.confirm('Delete this reminder?');
			if (confirmed) {
				void deleteReminder(id);
			}
			return;
		}
		case 'toggle-complete': {
			const id = target.dataset.id;
			const completed = target.dataset.completed === 'true';
			if (!id) return;
			void toggleReminderCompleted(id, completed);
			return;
		}
		case 'logout':
			logOut(true);
			return;
		case 'refresh':
			if (state.authToken) {
				void loadReminders();
			} else {
				void bootstrap();
			}
			return;
		case 'toggle-settings': {
			state.settingsOpen = !state.settingsOpen;
			render();
			return;
		}
		case 'enable-push':
			void enablePushNotifications();
			return;
	}
});

root.addEventListener('submit', (event) => {
	const form = event.target instanceof HTMLFormElement ? event.target : null;
	if (!form || form.dataset.action !== 'save-reminder') return;
	event.preventDefault();
	void saveReminder(form);
});

async function bootstrap(): Promise<void> {
	try {
		const token = applyConfigFromUrl();
		if (!state.authToken && token) {
			await exchangeEnrollmentToken(token);
		}

		if (!state.authToken) {
			state.loading = false;
			render();
			return;
		}

		await refreshInstallActivationUrl().catch(() => undefined);
		render();
		await Promise.all([
			loadReminders(),
			refreshPushState().catch(() => undefined),
		]);
	} catch (error) {
		state.error = error instanceof Error ? error.message : String(error);
		state.loading = false;
		render();
	}
}

void bootstrap();
