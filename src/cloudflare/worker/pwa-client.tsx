import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
	Button,
} from '@heroui/react';
import {
	ArrowDown,
	ArrowUp,
	Bell,
	Calendar,
	Check,
	ChevronLeft,
	Flag,
	Hash,
	RefreshCw,
	Repeat,
	Settings,
	Trash2,
	X,
} from 'lucide-react';
import { RichTextInput, type RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ProjectAutocompleteDropdown } from '@/reminders/components/ProjectAutocompleteDropdown';
import { useProjectAutocomplete } from '@/reminders/components/useProjectAutocomplete';
import {
	buildInitialReminderContent,
	rebuildReminderContent,
} from '@/reminders/components/addReminderModal/useReminderDraft';
import { ReminderCard as SharedReminderCard } from '@/reminders/components/ReminderCard';
import { RemindersAppShell, type ReminderCardRenderer } from '@/reminders/ui/RemindersAppShell';
import type { Priority, Reminder as SharedReminder, RecurrenceRule } from '@/reminders/types/reminder';
import { formatDueDate } from '@/reminders/utils/dateFormatting';
import { getProjectColor } from '@/reminders/utils/projectColors';
import { buildStoredReminderDates, formatLocalDateKey, parseReminderDateValue, serializeReminderDateValue } from '@/reminders/utils/reminderDate';
import { parseReminderContent } from '@/reminders/utils/reminderParser';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { formatRecurrence } from '@/reminders/utils/rruleConverter';
import { PWA_ASSET_VERSION } from './pwa-version.gen';

type ModalMode = 'create' | 'edit';
type ModalPickerId = 'date' | 'project' | 'recurrence';
type ToastKind = 'success' | 'error' | 'info';

interface ReminderRecord {
	id: string;
	content: string;
	description?: string;
	dueDate?: string;
	dueDatetime?: string;
	priority: 1 | 4;
	completed: boolean;
	project: string;
	recurrence?: RecurrenceRule;
	filePath: string;
	lineNumber?: number;
	createdAt?: string;
	updatedAt?: string;
}

interface StoredConfig {
	folderPath: string;
	upcomingDays: number;
	allDayNotificationTime: string | null;
}

interface ModalDraft {
	content: string;
	description: string;
	project: string;
	defaultProject: string;
	priority: ReminderRecord['priority'];
	dueDate: string;
	dueTime: string;
	recurrence?: RecurrenceRule;
	activePicker: ModalPickerId | null;
	deleteConfirm: boolean;
}

interface ModalState {
	mode: ModalMode;
	reminderId?: string;
	draft: ModalDraft;
}

interface ToastState {
	kind: ToastKind;
	message: string;
}

interface PushState {
	supported: boolean;
	subscribed: boolean;
	status: string | null;
}

interface CachedReminderSnapshot {
	folderPath: string;
	reminders: ReminderRecord[];
	projects: string[];
	savedAt: number;
}

interface ReminderMutationBody {
	folderPath: string;
	allDayNotificationTime: string | null;
	content: string;
	description: string | null;
	project: string;
	priority: ReminderRecord['priority'];
	dueDate: string | null;
	dueDatetime: string | null;
	recurrence?: RecurrenceRule | null;
}

interface PullRefreshState {
	distance: number;
	progress: number;
	ready: boolean;
	refreshing: boolean;
}

type DataMode = 'live' | 'cached' | 'error';
type SafeAreaDebugRow = [label: string, value: string];

const AUTH_TOKEN_KEY = 'crate-reminders-auth-token';
const CONFIG_KEY = 'crate-reminders-config';
const REMINDERS_CACHE_KEY = 'crate-reminders-cache-v1';
const SHEET_SWITCH_DELAY_MS = 220;
const KEYBOARD_SHEET_OVERLAP_MAX = 120;
const KEYBOARD_SHEET_OVERLAP_MIN = 72;
const PULL_REFRESH_THRESHOLD = 70;
const PULL_REFRESH_MAX_DISTANCE = 120;
const PULL_REFRESH_SNAP_DISTANCE = 58;

const defaultConfig: StoredConfig = {
	folderPath: 'Reminders',
	upcomingDays: 7,
	allDayNotificationTime: null,
};
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

function saveConfig(config: StoredConfig): void {
	localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function loadCachedReminderSnapshot(folderPath: string): CachedReminderSnapshot | null {
	try {
		const raw = localStorage.getItem(REMINDERS_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<CachedReminderSnapshot>;
		if (parsed.folderPath !== folderPath) return null;
		if (!Array.isArray(parsed.reminders) || !Array.isArray(parsed.projects) || typeof parsed.savedAt !== 'number') {
			return null;
		}
		return {
			folderPath,
			reminders: parsed.reminders as ReminderRecord[],
			projects: parsed.projects.filter((project): project is string => typeof project === 'string'),
			savedAt: parsed.savedAt,
		};
	} catch {
		return null;
	}
}

function saveCachedReminderSnapshot(folderPath: string, reminders: ReminderRecord[], projects: string[], savedAt = Date.now()): void {
	try {
		const snapshot: CachedReminderSnapshot = { folderPath, reminders, projects, savedAt };
		localStorage.setItem(REMINDERS_CACHE_KEY, JSON.stringify(snapshot));
	} catch {
		// Best-effort cache for offline display; storage can be unavailable in private contexts.
	}
}

function currentQueryParams(): URLSearchParams {
	return new URLSearchParams(window.location.search);
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

function isStandaloneApp(): boolean {
	return window.matchMedia('(display-mode: standalone)').matches
		|| Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function formatDebugNumber(value: number | undefined): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
	return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function getSafeAreaProbe(): HTMLElement {
	const existing = document.getElementById('pwa-safe-area-debug-probe');
	if (existing instanceof HTMLElement) return existing;

	const probe = document.createElement('div');
	probe.id = 'pwa-safe-area-debug-probe';
	probe.style.cssText = [
		'position:fixed',
		'inset:auto auto 0 0',
		'width:0',
		'height:0',
		'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
		'visibility:hidden',
		'pointer-events:none',
		'z-index:-1',
	].join(';');
	document.body.appendChild(probe);
	return probe;
}

function describeElementRect(selector: string): string {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return 'missing';

	const rect = element.getBoundingClientRect();
	const style = window.getComputedStyle(element);
	const bottomGap = window.innerHeight - rect.bottom;
	const transform = style.transform === 'none' ? 'none' : style.transform;
	return [
		`t:${formatDebugNumber(rect.top)}`,
		`b:${formatDebugNumber(bottomGap)}`,
		`h:${formatDebugNumber(rect.height)}`,
		`cssH:${style.height}`,
		`pb:${style.paddingBottom}`,
		`tr:${transform}`,
	].join(' ');
}

function measureSafeAreaDebugRows(): SafeAreaDebugRow[] {
	const viewport = window.visualViewport;
	const probeStyle = window.getComputedStyle(getSafeAreaProbe());
	const tab = document.querySelector<HTMLElement>('.pwa-reminders-view .bottom-tab-bar');
	const tabRect = tab?.getBoundingClientRect();
	const tabBottomGap = tabRect ? window.innerHeight - tabRect.bottom : undefined;
	const viewportBottomGap = viewport ? window.innerHeight - viewport.offsetTop - viewport.height : undefined;

	return [
		['standalone', isStandaloneApp() ? 'yes' : 'no'],
		['dpr', formatDebugNumber(window.devicePixelRatio)],
		['screen', `${formatDebugNumber(window.screen.width)}x${formatDebugNumber(window.screen.height)}`],
		['inner', `${formatDebugNumber(window.innerWidth)}x${formatDebugNumber(window.innerHeight)}`],
		['screenGap', formatDebugNumber(window.screen.height - window.innerHeight)],
		['docEl', `${formatDebugNumber(document.documentElement.clientWidth)}x${formatDebugNumber(document.documentElement.clientHeight)}`],
		['visualViewport', viewport ? `${formatDebugNumber(viewport.width)}x${formatDebugNumber(viewport.height)} top:${formatDebugNumber(viewport.offsetTop)} bottomGap:${formatDebugNumber(viewportBottomGap)}` : 'missing'],
		['safeArea', `t:${probeStyle.paddingTop} r:${probeStyle.paddingRight} b:${probeStyle.paddingBottom} l:${probeStyle.paddingLeft}`],
		['tabBottomGap', formatDebugNumber(tabBottomGap)],
		['#app', describeElementRect('#app')],
		['shadow', describeElementRect('.reminders-shadow-root')],
		['view', describeElementRect('.pwa-reminders-view')],
		['content', describeElementRect('.pwa-reminders-view .reminders-content')],
		['tab', describeElementRect('.pwa-reminders-view .bottom-tab-bar')],
		['tabInner', describeElementRect('.pwa-reminders-view .bottom-tab-bar > div')],
		['tabChrome', describeElementRect('.pwa-reminders-view .bottom-tab-bar [data-action="switch-tab"] > div:last-child')],
		['fab', describeElementRect('.pwa-reminders-view .reminders-fab')],
	];
}

function toSharedReminder(reminder: ReminderRecord): SharedReminder {
	const timestamp = reminder.updatedAt ?? reminder.createdAt ?? new Date(0).toISOString();
	return {
		id: reminder.id,
		content: reminder.content,
		description: reminder.description,
		dueDate: reminder.dueDate,
		dueDatetime: reminder.dueDatetime,
		priority: reminder.priority,
		completed: reminder.completed,
		project: reminder.project || 'Inbox',
		recurrence: reminder.recurrence,
		fileLink: reminder.filePath,
		lineNumber: reminder.lineNumber,
		createdAt: reminder.createdAt ?? timestamp,
		updatedAt: timestamp,
	};
}

function buildOptimisticReminder(body: ReminderMutationBody, id: string): ReminderRecord {
	const now = new Date().toISOString();
	const project = body.project.trim() || 'Inbox';
	return {
		id,
		content: body.content,
		description: body.description?.trim() || undefined,
		dueDate: body.dueDate || undefined,
		dueDatetime: body.dueDatetime || undefined,
		priority: body.priority,
		completed: false,
		project,
		recurrence: normalizeRecurrenceRule(body.recurrence ?? undefined),
		filePath: `${body.folderPath}/${project}.md`,
		createdAt: now,
		updatedAt: now,
	};
}

function applyOptimisticReminderUpdate(reminder: ReminderRecord, body: ReminderMutationBody): ReminderRecord {
	const project = body.project.trim() || reminder.project || 'Inbox';
	return {
		...reminder,
		content: body.content,
		description: body.description?.trim() || undefined,
		dueDate: body.dueDate || undefined,
		dueDatetime: body.dueDatetime || undefined,
		priority: body.priority,
		project,
		recurrence: Object.prototype.hasOwnProperty.call(body, 'recurrence')
			? normalizeRecurrenceRule(body.recurrence ?? undefined)
			: reminder.recurrence,
		filePath: project === reminder.project ? reminder.filePath : `${body.folderPath}/${project}.md`,
		updatedAt: new Date().toISOString(),
	};
}

function reorderProjectReminders(reminders: ReminderRecord[], project: string, orderedIds: string[]): ReminderRecord[] {
	const order = new Map(orderedIds.map((id, index) => [id, index]));
	const activeProjectReminders = reminders
		.filter((reminder) => reminder.project === project && !reminder.completed)
		.sort((a, b) => {
			const aIndex = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
			const bIndex = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
			return aIndex - bIndex;
		});

	let activeIndex = 0;
	return reminders.map((reminder) => {
		if (reminder.project !== project || reminder.completed) return reminder;
		const nextReminder = activeProjectReminders[activeIndex];
		activeIndex += 1;
		return nextReminder ?? reminder;
	});
}

function mergeProject(projects: string[], project: string): string[] {
	const normalized = project.trim() || 'Inbox';
	return projects.includes(normalized) ? projects : [...projects, normalized].sort((a, b) => a.localeCompare(b));
}

function buildModalDraft(reminder: ReminderRecord | null, selectedProject: string | null): ModalDraft {
	const parsedDate = reminder?.dueDatetime
		? new Date(reminder.dueDatetime)
		: reminder?.dueDate
			? parseReminderDateValue(reminder.dueDate, false) ?? null
			: null;
	const defaultProject = selectedProject ?? 'Inbox';
	const sharedReminder = reminder ? toSharedReminder(reminder) : undefined;

	return {
		content: buildInitialReminderContent(sharedReminder, defaultProject),
		description: reminder?.description ?? '',
		project: reminder?.project ?? defaultProject,
		defaultProject,
		priority: reminder?.priority ?? 4,
		dueDate: parsedDate && !reminder?.recurrence ? formatLocalDateKey(parsedDate) : '',
		dueTime: reminder?.dueDatetime && !reminder?.recurrence
			? `${String(parsedDate?.getHours() ?? 0).padStart(2, '0')}:${String(parsedDate?.getMinutes() ?? 0).padStart(2, '0')}`
			: '',
		recurrence: reminder?.recurrence,
		activePicker: null,
		deleteConfirm: false,
	};
}

function formatModalDueSummary(draft: ModalDraft): string {
	if (!draft.dueDate) return 'No date';
	return formatDueDate(draft.dueTime ? `${draft.dueDate}T${draft.dueTime}` : draft.dueDate) ?? 'No date';
}

function getDraftDueValue(draft: ModalDraft): string | null {
	if (!draft.dueDate) return null;
	if (!draft.dueTime) return draft.dueDate;
	const date = new Date(`${draft.dueDate}T${draft.dueTime}`);
	return Number.isNaN(date.getTime()) ? draft.dueDate : date.toISOString();
}

function draftHasTime(draft: Pick<ModalDraft, 'dueDate' | 'dueTime'>): boolean {
	return Boolean(draft.dueDate && draft.dueTime);
}

function splitDraftDateValue(dateValue: string | null | undefined, hasTime: boolean): Pick<ModalDraft, 'dueDate' | 'dueTime'> {
	if (!dateValue) return { dueDate: '', dueTime: '' };
	const parsedDate = parseReminderDateValue(dateValue, hasTime);
	if (!parsedDate || Number.isNaN(parsedDate.getTime())) return { dueDate: '', dueTime: '' };
	return {
		dueDate: formatLocalDateKey(parsedDate),
		dueTime: hasTime
			? `${String(parsedDate.getHours()).padStart(2, '0')}:${String(parsedDate.getMinutes()).padStart(2, '0')}`
			: '',
	};
}

type ReminderTextUpdate = {
	dueDateValue?: string | null;
	hasTime?: boolean;
	recurrence?: RecurrenceRule | null;
	project?: string;
	priority?: Priority;
};

function applyReminderTextUpdate(
	draft: ModalDraft,
	projectOptions: string[],
	update: ReminderTextUpdate,
): Partial<ModalDraft> {
	const parsed = parseReminderContent(draft.content, projectOptions);
	const cleanText = parsed.cleanContent?.trim() ?? draft.content.trim();
	const parsedDateValue = parsed.dueDate
		? serializeReminderDateValue(parsed.dueDate, parsed.hasTime)
		: undefined;
	const hasDueDateUpdate = Object.prototype.hasOwnProperty.call(update, 'dueDateValue');
	const hasRecurrenceUpdate = Object.prototype.hasOwnProperty.call(update, 'recurrence');
	let nextDueDateValue = hasDueDateUpdate
		? update.dueDateValue ?? null
		: parsedDateValue ?? getDraftDueValue(draft);
	let nextHasTime = Object.prototype.hasOwnProperty.call(update, 'hasTime')
		? Boolean(update.hasTime)
		: parsed.dueDate
			? Boolean(parsed.hasTime)
			: draftHasTime(draft);
	let nextRecurrence = hasRecurrenceUpdate
		? normalizeRecurrenceRule(update.recurrence ?? undefined)
		: normalizeRecurrenceRule(parsed.recurrence ?? draft.recurrence);

	if (hasRecurrenceUpdate && nextRecurrence) {
		nextDueDateValue = null;
		nextHasTime = false;
	} else if (hasDueDateUpdate) {
		nextRecurrence = undefined;
		if (!nextDueDateValue) nextHasTime = false;
	}

	const nextProject = update.project ?? parsed.project ?? draft.project ?? draft.defaultProject;
	const nextPriority = update.priority ?? (parsed.priorityPart ? parsed.priority : draft.priority);
	const dateFields = splitDraftDateValue(nextDueDateValue, nextHasTime);

	return {
		content: rebuildReminderContent(
			cleanText,
			nextDueDateValue,
			nextRecurrence,
			nextProject,
			nextPriority,
			draft.defaultProject,
			nextHasTime,
		),
		project: nextProject,
		priority: nextPriority,
		recurrence: nextRecurrence,
		...dateFields,
		deleteConfirm: false,
	};
}

function deriveDraftPatchFromContent(draft: ModalDraft, projectOptions: string[]): Partial<ModalDraft> {
	const parsed = parseReminderContent(draft.content, projectOptions);
	const patch: Partial<ModalDraft> = {};
	const nextProject = parsed.project ?? draft.defaultProject;

	if (nextProject !== draft.project) {
		patch.project = nextProject;
	}

	const nextPriority = parsed.priorityPart ? parsed.priority : 4;
	if (nextPriority !== draft.priority) {
		patch.priority = nextPriority;
	}

	if (parsed.recurrence) {
		const nextRecurrence = normalizeRecurrenceRule(parsed.recurrence);
		if (JSON.stringify(nextRecurrence) !== JSON.stringify(draft.recurrence)) {
			patch.recurrence = nextRecurrence;
		}
		if (draft.dueDate || draft.dueTime) {
			patch.dueDate = '';
			patch.dueTime = '';
		}
		return patch;
	}

	if (draft.recurrence) {
		patch.recurrence = undefined;
	}

	if (parsed.dueDate) {
		const hasTime = Boolean(parsed.hasTime);
		const serialized = serializeReminderDateValue(parsed.dueDate, hasTime);
		const dateFields = splitDraftDateValue(serialized, hasTime);
		if (dateFields.dueDate !== draft.dueDate) patch.dueDate = dateFields.dueDate;
		if (dateFields.dueTime !== draft.dueTime) patch.dueTime = dateFields.dueTime;
		return patch;
	}

	if (draft.dueDate || draft.dueTime) {
		patch.dueDate = '';
		patch.dueTime = '';
	}

	return patch;
}

function applyDateFieldsToDraft(
	draft: ModalDraft,
	projectOptions: string[],
	dueDate: string,
	dueTime: string,
): Partial<ModalDraft> {
	if (!dueDate) {
		return applyReminderTextUpdate(draft, projectOptions, { dueDateValue: null, hasTime: false, recurrence: null });
	}
	const hasTime = Boolean(dueTime);
	const dateValue = hasTime ? new Date(`${dueDate}T${dueTime}`).toISOString() : dueDate;
	return applyReminderTextUpdate(draft, projectOptions, { dueDateValue: dateValue, hasTime, recurrence: null });
}

function applyDatePresetToDraft(
	draft: ModalDraft,
	projectOptions: string[],
	preset: 'today' | 'tomorrow' | 'evening' | 'next-week' | 'clear',
): Partial<ModalDraft> {
	if (preset === 'clear') {
		return applyReminderTextUpdate(draft, projectOptions, { dueDateValue: null, hasTime: false, recurrence: null });
	}

	const next = new Date();
	if (preset === 'tomorrow') {
		next.setDate(next.getDate() + 1);
		next.setHours(0, 0, 0, 0);
	} else if (preset === 'evening') {
		if (next.getHours() >= 18) next.setDate(next.getDate() + 1);
		next.setHours(18, 0, 0, 0);
	} else if (preset === 'next-week') {
		next.setDate(next.getDate() + 7);
		next.setHours(0, 0, 0, 0);
	} else {
		next.setHours(0, 0, 0, 0);
	}

	return applyReminderTextUpdate(draft, projectOptions, {
		dueDateValue: preset === 'evening' ? next.toISOString() : formatLocalDateKey(next),
		hasTime: preset === 'evening',
		recurrence: null,
	});
}

function scrollFocusedEditorFieldIntoView(): void {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement)) return;
	if (!active.matches('input, textarea, [contenteditable="true"]')) return;
	if (!active.closest('.pwa-reminder-editor, .pwa-picker-sheet')) return;

	active.scrollIntoView({
		block: 'center',
		inline: 'nearest',
		behavior: 'smooth',
	});
}

function updateKeyboardInset(): number {
	const viewport = window.visualViewport;
	const viewportHeight = viewport?.height ?? window.innerHeight;
	const viewportOffsetTop = viewport?.offsetTop ?? 0;
	const keyboardOffset = Math.max(0, window.innerHeight - viewportHeight - viewportOffsetTop);
	const usableHeight = Math.max(0, viewportOffsetTop + viewportHeight);
	const roundedKeyboardOffset = Math.round(keyboardOffset);
	const viewportExtension = isStandaloneApp() ? Math.max(0, Math.round(window.screen.height - window.innerHeight)) : 0;
	const sheetOverlap = roundedKeyboardOffset > 24
		? Math.min(KEYBOARD_SHEET_OVERLAP_MAX, Math.max(KEYBOARD_SHEET_OVERLAP_MIN, Math.round(roundedKeyboardOffset * 0.28)))
		: 0;
	const sheetOffset = Math.max(0, roundedKeyboardOffset - sheetOverlap);

	document.documentElement.style.setProperty('--pwa-viewport-extension', `${viewportExtension}px`);
	document.documentElement.style.setProperty('--keyboard-offset', `${roundedKeyboardOffset}px`);
	document.documentElement.style.setProperty('--keyboard-sheet-offset', `${sheetOffset}px`);
	document.documentElement.style.setProperty('--keyboard-sheet-overlap', `${sheetOverlap}px`);
	document.documentElement.style.setProperty('--keyboard-usable-height', `${Math.round(usableHeight)}px`);
	document.documentElement.classList.toggle('pwa-keyboard-open', roundedKeyboardOffset > 24);
	return roundedKeyboardOffset;
}

function useKeyboardInset(): void {
	useEffect(() => {
		const timers = new Set<number>();
		const updateAndScrollFocusedField = () => {
			const keyboardOffset = updateKeyboardInset();
			if (keyboardOffset > 24) scrollFocusedEditorFieldIntoView();
		};
		const scheduleUpdate = () => {
			updateKeyboardInset();
			window.requestAnimationFrame(updateAndScrollFocusedField);
			for (const delay of [80, 220, 420]) {
				const timer = window.setTimeout(() => {
					timers.delete(timer);
					updateAndScrollFocusedField();
				}, delay);
				timers.add(timer);
			}
		};

		scheduleUpdate();
		const viewport = window.visualViewport;
		if (!viewport) {
			window.addEventListener('orientationchange', scheduleUpdate);
			document.addEventListener('focusin', scheduleUpdate);
			document.addEventListener('focusout', scheduleUpdate);
			return () => {
				window.removeEventListener('orientationchange', scheduleUpdate);
				document.removeEventListener('focusin', scheduleUpdate);
				document.removeEventListener('focusout', scheduleUpdate);
				for (const timer of timers) window.clearTimeout(timer);
				timers.clear();
			};
		}

		viewport.addEventListener('resize', scheduleUpdate);
		viewport.addEventListener('scroll', scheduleUpdate);
		window.addEventListener('orientationchange', scheduleUpdate);
		document.addEventListener('focusin', scheduleUpdate);
		document.addEventListener('focusout', scheduleUpdate);
		return () => {
			viewport.removeEventListener('resize', scheduleUpdate);
			viewport.removeEventListener('scroll', scheduleUpdate);
			window.removeEventListener('orientationchange', scheduleUpdate);
			document.removeEventListener('focusin', scheduleUpdate);
			document.removeEventListener('focusout', scheduleUpdate);
			for (const timer of timers) window.clearTimeout(timer);
			timers.clear();
		};
	}, []);
}

function applyConfigFromUrl(config: StoredConfig): { config: StoredConfig; token: string | null; project: string | null } {
	const params = currentQueryParams();
	const nextConfig = { ...config };
	const folderPath = params.get('folder');
	const upcomingDays = params.get('upcomingDays');
	const allDayTime = params.get('allDayTime');

	if (folderPath) nextConfig.folderPath = folderPath;
	if (upcomingDays) {
		const parsedDays = Number.parseInt(upcomingDays, 10);
		if (Number.isInteger(parsedDays) && parsedDays > 0) {
			nextConfig.upcomingDays = parsedDays;
		}
	}
	if (allDayTime) {
		nextConfig.allDayNotificationTime = /^\d{2}:\d{2}$/.test(allDayTime) ? allDayTime : null;
	}

	saveConfig(nextConfig);
	return {
		config: nextConfig,
		token: params.get('token'),
		project: params.get('project'),
	};
}

async function exchangeEnrollmentToken(token: string): Promise<string> {
	const response = await fetch('/notifications/reminders-exchange', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token, deviceName: detectDeviceName() }),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(body || response.statusText);
	}

	const result = await response.json() as { authToken?: string };
	if (!result.authToken) throw new Error('Missing auth token');
	return result.authToken;
}

async function validateStoredAuthToken(authToken: string): Promise<boolean> {
	try {
		const response = await fetch('/health', {
			headers: { Authorization: `Bearer ${authToken}` },
		});
		return response.status !== 401 && response.status !== 403;
	} catch {
		return true;
	}
}

function installActivationParams(token: string, config: StoredConfig): URLSearchParams {
	const params = currentQueryParams();
	const project = params.get('project');
	const nextParams = new URLSearchParams();
	nextParams.set('token', token);
	nextParams.set('folder', config.folderPath);
	nextParams.set('upcomingDays', String(config.upcomingDays));
	if (config.allDayNotificationTime) nextParams.set('allDayTime', config.allDayNotificationTime);
	if (project) nextParams.set('project', project);
	return nextParams;
}

function updateManifestWithInstallToken(token: string, config: StoredConfig): void {
	const params = installActivationParams(token, config);
	params.set('v', PWA_ASSET_VERSION);
	const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
	if (manifest) {
		manifest.href = `/notifications/manifest.json?${params.toString()}`;
	}
}

function replaceBrowserUrlWithInstallToken(token: string, config: StoredConfig): void {
	const params = installActivationParams(token, config);

	const query = params.toString();
	history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
	updateManifestWithInstallToken(token, config);
}

function makeApiFetch(authToken: string | null, onUnauthorized: () => void) {
	return async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
		if (!authToken) throw new Error('Not authenticated');
		const headers = new Headers(init.headers ?? {});
		headers.set('Authorization', `Bearer ${authToken}`);
		if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

		const response = await fetch(path, { ...init, headers });
		if (response.status === 401) {
			onUnauthorized();
			throw new Error('Session expired. Open a fresh link from Crate.');
		}
		return response;
	};
}

function formatLastUpdated(timestamp: number | null, now: number): string {
	if (!timestamp) return 'Not updated yet';
	const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (elapsedSeconds < 45) return 'Last updated just now';
	if (elapsedSeconds < 90) return 'Last updated 1m ago';
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `Last updated ${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `Last updated ${elapsedHours}h ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	return `Last updated ${elapsedDays}d ago`;
}

async function fetchPwaAssetVersion(): Promise<string | null> {
	const response = await fetch(`/notifications/version.json?ts=${Date.now()}`, { cache: 'no-store' });
	if (!response.ok) return null;
	const result = await response.json() as { assetVersion?: string };
	return typeof result.assetVersion === 'string' && result.assetVersion.trim() ? result.assetVersion : null;
}

function findPullScrollTarget(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	const targetScroll = target.closest<HTMLElement>('.pwa-reminders-view .ios-scroll');
	if (targetScroll) return targetScroll;
	return document.querySelector<HTMLElement>('.pwa-reminders-view .ios-scroll');
}

function dampenPullDistance(distance: number): number {
	const ratio = Math.min(distance / PULL_REFRESH_MAX_DISTANCE, 1);
	return PULL_REFRESH_MAX_DISTANCE * (1 - Math.pow(1 - ratio, 2));
}

function usePullToRefresh(enabled: boolean, onRefresh: () => Promise<void>): PullRefreshState {
	const [state, setState] = useState<PullRefreshState>({ distance: 0, progress: 0, ready: false, refreshing: false });
	const refreshRef = useRef(onRefresh);

	useEffect(() => {
		refreshRef.current = onRefresh;
	}, [onRefresh]);

	useEffect(() => {
		if (!enabled) {
			setState({ distance: 0, progress: 0, ready: false, refreshing: false });
			return;
		}

		let startY = 0;
		let active = false;
		let pulling = false;
		let currentDistance = 0;
		let animationFrame: number | null = null;

		const reset = () => {
			active = false;
			pulling = false;
			currentDistance = 0;
			if (animationFrame !== null) {
				window.cancelAnimationFrame(animationFrame);
				animationFrame = null;
			}
			setState({ distance: 0, progress: 0, ready: false, refreshing: false });
		};

		const handleTouchStart = (event: TouchEvent) => {
			if (event.touches.length !== 1) return;
			if ((event.target as Element | null)?.closest('.modal-backdrop, .settings-sheet, .settings-backdrop')) return;
			const scrollTarget = findPullScrollTarget(event.target);
			if (!scrollTarget || scrollTarget.scrollTop > 0) return;

			startY = event.touches[0].clientY;
			active = true;
			pulling = false;
			currentDistance = 0;
		};

		const handleTouchMove = (event: TouchEvent) => {
			if (!active || event.touches.length !== 1) return;
			const scrollTarget = findPullScrollTarget(event.target);
			if (!scrollTarget || scrollTarget.scrollTop > 0) {
				reset();
				return;
			}

			const delta = event.touches[0].clientY - startY;
			if (delta <= 0) {
				reset();
				return;
			}

			pulling = true;
			currentDistance = Math.min(PULL_REFRESH_MAX_DISTANCE, Math.round(dampenPullDistance(delta)));
			if (currentDistance > 8) event.preventDefault();

			if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
			animationFrame = window.requestAnimationFrame(() => {
				setState({
					distance: currentDistance,
					progress: Math.min(currentDistance / PULL_REFRESH_THRESHOLD, 1),
					ready: currentDistance >= PULL_REFRESH_THRESHOLD,
					refreshing: false,
				});
				animationFrame = null;
			});
		};

		const handleTouchEnd = () => {
			if (animationFrame !== null) {
				window.cancelAnimationFrame(animationFrame);
				animationFrame = null;
			}

			if (!pulling) {
				reset();
				return;
			}

			if (currentDistance < PULL_REFRESH_THRESHOLD) {
				reset();
				return;
			}

			active = false;
			pulling = false;
			currentDistance = 0;
			setState({ distance: PULL_REFRESH_SNAP_DISTANCE, progress: 1, ready: true, refreshing: true });
			void refreshRef.current().finally(() => {
				window.setTimeout(() => {
					setState({ distance: 0, progress: 0, ready: false, refreshing: false });
				}, 360);
			});
		};

		document.addEventListener('touchstart', handleTouchStart, { passive: true });
		document.addEventListener('touchmove', handleTouchMove, { passive: false });
		document.addEventListener('touchend', handleTouchEnd);
		document.addEventListener('touchcancel', reset);
		return () => {
			document.removeEventListener('touchstart', handleTouchStart);
			document.removeEventListener('touchmove', handleTouchMove);
			document.removeEventListener('touchend', handleTouchEnd);
			document.removeEventListener('touchcancel', reset);
			if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
		};
	}, [enabled]);

	return state;
}

function App() {
	const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
	const [bootstrapped, setBootstrapped] = useState(false);
	const [config, setConfig] = useState<StoredConfig>(() => loadStoredConfig());
	const [reminders, setReminders] = useState<ReminderRecord[]>([]);
	const [projects, setProjects] = useState<string[]>([]);
	const [selectedProject, setSelectedProject] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dataMode, setDataMode] = useState<DataMode>('live');
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
	const [statusNow, setStatusNow] = useState(() => Date.now());
	const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' ? !navigator.onLine : false);
	const [updateAvailable, setUpdateAvailable] = useState(false);
	const [modal, setModal] = useState<ModalState | null>(null);
	const [toast, setToastState] = useState<ToastState | null>(null);
	const [push, setPush] = useState<PushState>({ supported: false, subscribed: false, status: null });
	const toastTimerRef = useRef<number | null>(null);
	const remindersRef = useRef(reminders);
	const projectsRef = useRef(projects);
	const hydratedCacheRef = useRef(false);

	useKeyboardInset();

	useEffect(() => {
		remindersRef.current = reminders;
	}, [reminders]);

	useEffect(() => {
		projectsRef.current = projects;
	}, [projects]);

	useEffect(() => {
		const timer = window.setInterval(() => setStatusNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);

	const showToast = useCallback((kind: ToastKind, message: string) => {
		setToastState({ kind, message });
		if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
		toastTimerRef.current = window.setTimeout(() => setToastState(null), 3200);
	}, []);

	const logOut = useCallback((showMessage: boolean) => {
		localStorage.removeItem(AUTH_TOKEN_KEY);
		localStorage.removeItem(REMINDERS_CACHE_KEY);
		setAuthToken(null);
		setReminders([]);
		setProjects([]);
		setSelectedProject(null);
		setSettingsOpen(false);
		setModal(null);
		if (showMessage) {
			setError(null);
			showToast('info', 'Logged out');
		}
	}, [showToast]);

	const apiFetch = useMemo(() => makeApiFetch(authToken, () => logOut(false)), [authToken, logOut]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		setReminders(snapshot.reminders);
		setProjects(snapshot.projects);
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
		setSelectedProject((current) => current && !snapshot.projects.includes(current) ? null : current);
	}, []);

	const loadReminders = useCallback(async (options: { silent?: boolean } = {}) => {
		if (!authToken) return;
		if (options.silent) setRefreshing(true);
		else setLoading(true);
		setError(null);
		try {
			if (!navigator.onLine) {
				const cached = loadCachedReminderSnapshot(config.folderPath);
				if (cached) {
					hydrateCachedSnapshot(cached);
					return;
				}
				throw new Error('Offline');
			}

			const response = await apiFetch(`/reminders/list?folderPath=${encodeURIComponent(config.folderPath)}`);
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { reminders?: ReminderRecord[]; projects?: string[] };
			const nextReminders = Array.isArray(result.reminders) ? result.reminders : [];
			const nextProjects = Array.isArray(result.projects) ? result.projects : [];
			const savedAt = Date.now();
			setReminders(nextReminders);
			setProjects(nextProjects);
			setSelectedProject((current) => current && !nextProjects.includes(current) ? null : current);
			setLastUpdatedAt(savedAt);
			setDataMode('live');
			setIsOffline(false);
			saveCachedReminderSnapshot(config.folderPath, nextReminders, nextProjects, savedAt);
		} catch (loadError) {
			const message = loadError instanceof Error ? loadError.message : String(loadError);
			const cached = loadCachedReminderSnapshot(config.folderPath);
			if (cached) {
				hydrateCachedSnapshot(cached);
				setError(message);
			} else {
				setDataMode('error');
				setError(message);
			}
		} finally {
			setRefreshing(false);
			setLoading(false);
		}
	}, [apiFetch, authToken, config.folderPath, hydrateCachedSnapshot]);

	const refreshInstallActivationUrl = useCallback(async () => {
		if (!authToken || isStandaloneApp()) return;
		const response = await apiFetch('/notifications/reminders-enrollment-token', { method: 'POST' });
		if (!response.ok) throw new Error(await response.text());
		const result = await response.json() as { token?: string };
		if (!result.token) throw new Error('Missing install token');
		replaceBrowserUrlWithInstallToken(result.token, config);
	}, [apiFetch, authToken, config]);

	const refreshPushState = useCallback(async () => {
		const standalone = isStandaloneApp();
		const supported = 'serviceWorker' in navigator && 'PushManager' in window;
		if (!supported) {
			setPush({ supported: false, subscribed: false, status: 'Push notifications are not supported in this browser.' });
			return;
		}

		if (!standalone && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
			setPush({ supported: true, subscribed: false, status: 'Install this app on your home screen to enable push notifications on iOS.' });
			return;
		}

		const registration = await navigator.serviceWorker.register(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`);
		const subscription = await registration.pushManager.getSubscription();
		setPush({
			supported: true,
			subscribed: !!subscription,
			status: subscription ? 'Notifications enabled on this device.' : null,
		});
	}, []);

	useEffect(() => {
		let cancelled = false;

		async function bootstrap() {
			try {
				const applied = applyConfigFromUrl(loadStoredConfig());
				if (cancelled) return;
				setConfig(applied.config);
				if (applied.project) {
					setSelectedProject(applied.project);
				}

				let nextToken = authToken;
				if (nextToken && applied.token) {
					const storedTokenValid = await validateStoredAuthToken(nextToken);
					if (cancelled) return;
					if (!storedTokenValid) {
						localStorage.removeItem(AUTH_TOKEN_KEY);
						nextToken = null;
					}
				}

				if (!nextToken && applied.token) {
					nextToken = await exchangeEnrollmentToken(applied.token);
					localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
					if (cancelled) return;
					setAuthToken(nextToken);
				}

				if (!nextToken) {
					setLoading(false);
					return;
				}

				const cached = loadCachedReminderSnapshot(applied.config.folderPath);
				hydratedCacheRef.current = Boolean(cached);
				if (cached) {
					hydrateCachedSnapshot(cached);
					setLoading(false);
				}
			} catch (bootstrapError) {
				if (!cancelled) {
					localStorage.removeItem(AUTH_TOKEN_KEY);
					setAuthToken(null);
					setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
					setLoading(false);
				}
			} finally {
				if (!cancelled) {
					setBootstrapped(true);
				}
			}
		}

		void bootstrap();
		return () => {
			cancelled = true;
		};
		// Bootstrap is intentionally one-shot; subsequent auth changes are handled below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (!bootstrapped || !authToken) return;
		void refreshInstallActivationUrl().catch(() => undefined);
		void Promise.all([
			loadReminders({ silent: hydratedCacheRef.current }),
			refreshPushState().catch(() => undefined),
		]);
	}, [authToken, bootstrapped, loadReminders, refreshInstallActivationUrl, refreshPushState]);

	const checkForUpdate = useCallback(async () => {
		try {
			const assetVersion = await fetchPwaAssetVersion();
			if (assetVersion && assetVersion !== PWA_ASSET_VERSION) {
				setUpdateAvailable(true);
			}
		} catch {
			// Version checks are opportunistic and should not disrupt reminder use.
		}
	}, []);

	useEffect(() => {
		void checkForUpdate();
	}, [checkForUpdate]);

	useEffect(() => {
		const resume = () => {
			void checkForUpdate();
			if (!bootstrapped || !authToken) return;
			void loadReminders({ silent: true });
			void refreshPushState().catch(() => undefined);
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') resume();
		};

		window.addEventListener('pageshow', resume);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			window.removeEventListener('pageshow', resume);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [authToken, bootstrapped, checkForUpdate, loadReminders, refreshPushState]);

	useEffect(() => {
		const handleOnline = () => {
			setIsOffline(false);
			if (bootstrapped && authToken) void loadReminders({ silent: true });
		};
		const handleOffline = () => setIsOffline(true);

		window.addEventListener('online', handleOnline);
		window.addEventListener('offline', handleOffline);
		return () => {
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('offline', handleOffline);
		};
	}, [authToken, bootstrapped, loadReminders]);

	const readOnlyMessage = useMemo(() => {
		if (isOffline) return 'Offline data is read-only';
		if (dataMode === 'cached') return 'Showing last saved reminders. Refresh before editing.';
		if (dataMode === 'error') return 'Refresh reminders before editing.';
		return null;
	}, [dataMode, isOffline]);
	const readOnly = Boolean(readOnlyMessage);
	const canShowNotificationPrompt = Boolean(authToken && bootstrapped && push.supported && !push.subscribed && isStandaloneApp());
	const statusText = useMemo(() => {
		const lastUpdated = formatLastUpdated(lastUpdatedAt, statusNow);
		if (isOffline) return lastUpdatedAt ? `Offline - ${lastUpdated}` : 'Offline';
		if (dataMode === 'cached') return `${lastUpdated} - stale`;
		if (dataMode === 'error') return error ? `Refresh failed - ${error}` : 'Refresh failed';
		if (refreshing) return lastUpdatedAt ? `Refreshing - ${lastUpdated}` : 'Refreshing';
		return lastUpdatedAt ? lastUpdated : null;
	}, [dataMode, error, isOffline, lastUpdatedAt, refreshing, statusNow]);
	const statusKind = isOffline ? 'offline' : dataMode === 'live' ? 'live' : dataMode;

	const ensureCanMutate = useCallback(() => {
		if (!readOnlyMessage) return true;
		showToast('info', readOnlyMessage);
		return false;
	}, [readOnlyMessage, showToast]);

	const pullRefresh = usePullToRefresh(
		Boolean(authToken && bootstrapped && !loading && !modal && !settingsOpen),
		useCallback(() => loadReminders({ silent: true }), [loadReminders]),
	);

	const openModal = useCallback((mode: ModalMode, reminderId?: string, defaultProject?: string) => {
		if (!ensureCanMutate()) return;
		const reminder = reminderId ? reminders.find((item) => item.id === reminderId) ?? null : null;
		setSettingsOpen(false);
		setSaving(false);
		setModal({ mode, reminderId, draft: buildModalDraft(reminder, defaultProject ?? selectedProject) });
	}, [ensureCanMutate, reminders, selectedProject]);

	const closeModal = useCallback(() => {
		setModal(null);
		setSaving(false);
	}, []);

	const buildMutationBody = useCallback((draft: ModalDraft, mode: ModalMode): ReminderMutationBody => {
		const createDefaultProject = selectedProject ?? 'Inbox';
		const projectOptions = ['Inbox', ...projects.filter((project) => project !== 'Inbox')];
		const rawContent = draft.content.replace(/\s+/g, ' ').trim();
		const parsed = parseReminderContent(rawContent, projectOptions);
		const project = parsed.project || draft.project.trim() || createDefaultProject;
		const priority: 1 | 4 = parsed.priorityPart ? parsed.priority : draft.priority === 1 ? 1 : 4;
		const content = (parsed.cleanContent || rawContent).replace(/\s+/g, ' ').trim();
		const recurrence = normalizeRecurrenceRule(parsed.recurrence || draft.recurrence);
		let dueDate: string | null = null;
		let dueDatetime: string | null = null;

		if (parsed.dueDate) {
			const parsedDates = buildStoredReminderDates(parsed.dueDate, parsed.hasTime);
			dueDate = parsedDates.dueDate ?? null;
			dueDatetime = parsedDates.dueDatetime ?? null;
		} else if (!recurrence) {
			const rawDate = draft.dueDate.trim();
			const rawTime = draft.dueTime.trim();
			if (rawDate && rawTime) dueDatetime = new Date(`${rawDate}T${rawTime}`).toISOString();
			else if (rawDate) dueDate = rawDate;
		}

		return {
			folderPath: config.folderPath,
			allDayNotificationTime: config.allDayNotificationTime,
			content,
			description: draft.description.trim() || null,
			project,
			priority,
			dueDate,
			dueDatetime,
			recurrence: recurrence ?? (mode === 'edit' ? null : undefined),
		};
	}, [config.allDayNotificationTime, config.folderPath, projects, selectedProject]);

	const saveReminder = useCallback(async (currentModal: ModalState) => {
		if (!ensureCanMutate()) return;
		const body = buildMutationBody(currentModal.draft, currentModal.mode);
		if (!String(body.content || '').trim()) {
			showToast('error', 'Reminder title required');
			return;
		}

		setSaving(true);
		const previousReminders = remindersRef.current;
		const previousProjects = projectsRef.current;
		const isEdit = currentModal.mode === 'edit' && Boolean(currentModal.reminderId);
		const optimisticId = currentModal.reminderId ?? crypto.randomUUID();
		const optimisticReminder = buildOptimisticReminder(body, optimisticId);
		const nextProjects = mergeProject(previousProjects, optimisticReminder.project);
		setProjects(nextProjects);
		setReminders((current) => isEdit
			? current.map((reminder) => reminder.id === optimisticId ? applyOptimisticReminderUpdate(reminder, body) : reminder)
			: [...current, optimisticReminder]);
		closeModal();
		try {
			const path = isEdit ? '/reminders/update' : '/reminders/create';
			const requestBody: Record<string, unknown> = { ...body };
			requestBody.id = optimisticId;

			const response = await apiFetch(path, {
				method: 'POST',
				body: JSON.stringify(requestBody),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { notificationWarning?: string };
			await loadReminders({ silent: true });
			showToast(result.notificationWarning ? 'info' : 'success', result.notificationWarning
				? `Saved. Notification sync failed: ${result.notificationWarning}`
				: 'Reminder saved');
		} catch (saveError) {
			setReminders(previousReminders);
			setProjects(previousProjects);
			showToast('error', saveError instanceof Error ? saveError.message : String(saveError));
		}
	}, [apiFetch, buildMutationBody, closeModal, ensureCanMutate, loadReminders, showToast]);

	const toggleReminderCompleted = useCallback(async (reminderId: string, completed: boolean) => {
		if (!ensureCanMutate()) return;
		const previousReminders = remindersRef.current;
		const nextCompleted = !completed;
		setReminders((current) => current.map((reminder) => reminder.id === reminderId
			? { ...reminder, completed: nextCompleted, updatedAt: new Date().toISOString() }
			: reminder));
		try {
			const response = await apiFetch('/reminders/set-completed', {
				method: 'POST',
				body: JSON.stringify({
					folderPath: config.folderPath,
					allDayNotificationTime: config.allDayNotificationTime,
					id: reminderId,
					completed: nextCompleted,
				}),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { notificationWarning?: string };
			await loadReminders({ silent: true });
			if (result.notificationWarning) showToast('info', `Updated. Notification sync failed: ${result.notificationWarning}`);
		} catch (toggleError) {
			setReminders(previousReminders);
			showToast('error', toggleError instanceof Error ? toggleError.message : String(toggleError));
		}
	}, [apiFetch, config.allDayNotificationTime, config.folderPath, ensureCanMutate, loadReminders, showToast]);

	const deleteReminder = useCallback(async (reminderId: string) => {
		if (!ensureCanMutate()) return;
		const previousReminders = remindersRef.current;
		setReminders((current) => current.filter((reminder) => reminder.id !== reminderId));
		closeModal();
		try {
			const response = await apiFetch('/reminders/delete', {
				method: 'DELETE',
				body: JSON.stringify({ folderPath: config.folderPath, id: reminderId }),
			});
			if (!response.ok) throw new Error(await response.text());
			await loadReminders({ silent: true });
			showToast('success', 'Reminder deleted');
		} catch (deleteError) {
			setReminders(previousReminders);
			showToast('error', deleteError instanceof Error ? deleteError.message : String(deleteError));
		}
	}, [apiFetch, closeModal, config.folderPath, ensureCanMutate, loadReminders, showToast]);

	const persistReorder = useCallback(async (project: string, orderedIds: string[]) => {
		if (!ensureCanMutate()) {
			setReminders((current) => [...current]);
			return;
		}
		const previousReminders = remindersRef.current;
		setReminders((current) => reorderProjectReminders(current, project, orderedIds));
		try {
			const response = await apiFetch('/reminders/reorder', {
				method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath, project, orderedIds }),
			});
			if (!response.ok) throw new Error(await response.text());
			await loadReminders({ silent: true });
		} catch (reorderError) {
			setReminders(previousReminders);
			showToast('error', reorderError instanceof Error ? reorderError.message : String(reorderError));
		}
	}, [apiFetch, config.folderPath, ensureCanMutate, loadReminders, showToast]);

	const enablePushNotifications = useCallback(async () => {
		try {
			if (!push.supported) throw new Error('Push is not supported on this device.');
			const registration = await navigator.serviceWorker.register(`/notifications/sw.js?v=${PWA_ASSET_VERSION}`);
			const keyResponse = await fetch('/notifications/vapid-public-key');
			const { publicKey } = await keyResponse.json() as { publicKey?: string };
			if (!publicKey) throw new Error('Missing VAPID public key');
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
			if (!response.ok) throw new Error(await response.text());
			setPush({ supported: true, subscribed: true, status: 'Notifications enabled on this device.' });
			showToast('success', 'Notifications enabled');
		} catch (pushError) {
			const message = pushError instanceof Error ? pushError.message : String(pushError);
			setPush((current) => ({ ...current, status: message }));
			showToast('error', message);
		}
	}, [apiFetch, push.supported, showToast]);

	const sharedReminders = useMemo(() => reminders.map(toSharedReminder), [reminders]);
	const renderSharedCard = useCallback<ReminderCardRenderer>(({ reminder, index, hideProject }) => (
		<WebReminderCard
			key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
			reminder={reminder}
			index={index}
			hideProject={hideProject}
			onEdit={(id) => openModal('edit', id)}
			onToggleComplete={(id, completed) => toggleReminderCompleted(id, completed)}
		/>
	), [openModal, toggleReminderCompleted]);

	if (!bootstrapped) {
		return <LoadingAuthState />;
	}

	if (!authToken) {
		return error
			? <ErrorState error={error} config={config} onRetry={() => window.location.reload()} />
			: <EmptyAuthState config={config} />;
	}

	return (
		<div className="reminders-shadow-root pwa-shadow-root">
			<RemindersAppShell
				key={`pwa-shell-${selectedProject ?? 'root'}`}
				reminders={sharedReminders}
				projects={projects}
				isInitialLoadComplete={!loading}
				isDarkMode
				isFullScreen
				isModal
				initialTab={selectedProject ? 'browse' : 'inbox'}
				initialProject={selectedProject ?? undefined}
				upcomingDays={config.upcomingDays}
				className="app-shell pwa-reminders-view"
				headerRightContent={
					<PwaHeaderActions
						settingsOpen={settingsOpen}
						statusText={statusText}
						statusKind={statusKind}
						refreshing={refreshing}
						onRefresh={() => void loadReminders({ silent: true })}
						onToggleSettings={() => setSettingsOpen((open) => !open)}
					/>
				}
				belowHeaderContent={
					<>
						<PwaPullRefreshIndicator pullRefresh={pullRefresh} />
						<PwaTopNotices
							statusText={statusText}
							statusKind={statusKind}
							updateAvailable={updateAvailable}
							showNotificationPrompt={canShowNotificationPrompt}
							onReload={() => window.location.reload()}
							onEnableNotifications={enablePushNotifications}
						/>
					</>
				}
				loadingContent={loading ? <PwaLoadingSkeleton /> : undefined}
				suppressFab={Boolean(modal) || settingsOpen || readOnly}
				renderCard={renderSharedCard}
				onAdd={(defaultProject) => openModal('create', undefined, defaultProject)}
				onReorder={persistReorder}
			>
				{settingsOpen && (
					<SettingsSheet
						config={config}
						push={push}
						onClose={() => setSettingsOpen(false)}
						onEnablePush={enablePushNotifications}
						onRefresh={() => void loadReminders()}
						onLogout={() => logOut(true)}
					/>
				)}
				{modal && (
					<ReminderSheet
						modal={modal}
						projects={projects}
						saving={saving}
						onChange={setModal}
						onClose={closeModal}
						onSave={saveReminder}
						onDelete={deleteReminder}
					/>
				)}
				{toast && <div className={`toast is-${toast.kind}`}>{toast.message}</div>}
				<SafeAreaDebugOverlay />
			</RemindersAppShell>
		</div>
	);
}

function SafeAreaDebugOverlay() {
	const [rows, setRows] = useState<SafeAreaDebugRow[]>([]);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		const update = () => setRows(measureSafeAreaDebugRows());
		update();
		const interval = window.setInterval(update, 500);
		window.addEventListener('resize', update);
		window.visualViewport?.addEventListener('resize', update);
		window.visualViewport?.addEventListener('scroll', update);
		return () => {
			window.clearInterval(interval);
			window.removeEventListener('resize', update);
			window.visualViewport?.removeEventListener('resize', update);
			window.visualViewport?.removeEventListener('scroll', update);
		};
	}, []);

	const copyRows = useCallback(() => {
		const payload = rows.map(([label, value]) => `${label}: ${value}`).join('\n');
		void navigator.clipboard?.writeText(payload).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		});
	}, [rows]);

	return (
		<div className="pwa-safe-area-debug" data-testid="safe-area-debug">
			<div className="pwa-safe-area-debug__header">
				<strong>safe area</strong>
				<button type="button" onClick={copyRows}>{copied ? 'copied' : 'copy'}</button>
			</div>
			{rows.map(([label, value]) => (
				<div className="pwa-safe-area-debug__row" key={label}>
					<span>{label}</span>
					<code>{value}</code>
				</div>
			))}
		</div>
	);
}

function PwaSettingsButton({
	settingsOpen,
	onToggleSettings,
}: {
	settingsOpen: boolean;
	onToggleSettings: () => void;
}) {
	return (
		<button
			className={`pwa-header-settings-button${settingsOpen ? ' is-active' : ''}`}
			type="button"
			data-action="toggle-settings"
			aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
			aria-pressed={settingsOpen}
			onClick={onToggleSettings}
		>
			<Settings size={22} strokeWidth={2.1} />
		</button>
	);
}

function PwaHeaderActions({
	settingsOpen,
	statusText,
	statusKind,
	refreshing,
	onRefresh,
	onToggleSettings,
}: {
	settingsOpen: boolean;
	statusText: string | null;
	statusKind: DataMode | 'offline';
	refreshing: boolean;
	onRefresh: () => void;
	onToggleSettings: () => void;
}) {
	return (
		<div className="pwa-header-actions">
			<button
				className={`pwa-header-sync-button is-${statusKind}${refreshing ? ' is-refreshing' : ''}`}
				type="button"
				data-action="refresh-header"
				aria-label={statusText ? `Refresh reminders. ${statusText}` : 'Refresh reminders'}
				onClick={onRefresh}
			>
				<RefreshCw size={22} strokeWidth={2.1} />
				<span className="pwa-header-sync-button__dot" aria-hidden="true" />
			</button>
			<PwaSettingsButton settingsOpen={settingsOpen} onToggleSettings={onToggleSettings} />
		</div>
	);
}

function PwaTopNotices({
	statusText,
	statusKind,
	updateAvailable,
	showNotificationPrompt,
	onReload,
	onEnableNotifications,
}: {
	statusText: string | null;
	statusKind: DataMode | 'offline';
	updateAvailable: boolean;
	showNotificationPrompt: boolean;
	onReload: () => void;
	onEnableNotifications: () => void;
}) {
	const showStatusLine = Boolean(statusText && statusKind !== 'live');
	if (!showStatusLine && !updateAvailable && !showNotificationPrompt) return null;

	return (
		<div className="pwa-top-notices">
			{updateAvailable && (
				<div className="pwa-update-banner">
					<div className="pwa-update-banner__label">
						<span className="pwa-update-banner__dot" aria-hidden="true" />
						<span className="pwa-update-banner__text">Update available</span>
					</div>
					<button className="pwa-update-button" type="button" onClick={onReload} aria-label="Update to the latest version">
						Update
					</button>
				</div>
			)}
			{showStatusLine && <div className={`pwa-status-line is-${statusKind}`}>{statusText}</div>}
			{showNotificationPrompt && (
				<div className="pwa-notification-prompt">
					<div className="pwa-notification-prompt__icon">
						<Bell size={16} />
					</div>
					<div className="pwa-notification-prompt__copy">
						<strong>Enable notifications</strong>
						<span>Get reminder alerts from this Home Screen app.</span>
					</div>
					<Button className="pwa-inline-button" type="button" onClick={onEnableNotifications}>
						Enable
					</Button>
				</div>
			)}
		</div>
	);
}

function PwaPullRefreshIndicator({ pullRefresh }: { pullRefresh: PullRefreshState }) {
	const visible = pullRefresh.distance > 0 || pullRefresh.refreshing;
	const height = visible ? Math.min(82, Math.max(0, pullRefresh.distance)) : 0;
	const label = pullRefresh.refreshing ? 'Refreshing' : pullRefresh.ready ? 'Release to refresh' : null;
	const iconStyle: React.CSSProperties = pullRefresh.refreshing
		? {}
		: {
			transform: `rotate(${Math.round(pullRefresh.progress * 360)}deg) scale(${pullRefresh.ready ? 1.08 : 1})`,
		};

	return (
		<div
			className={`pwa-pull-refresh${visible ? ' is-visible' : ''}${pullRefresh.ready ? ' is-ready' : ''}${pullRefresh.refreshing ? ' is-refreshing' : ''}`}
			style={{ height: `${height}px` }}
			aria-hidden={!visible}
		>
			<div className="pwa-pull-refresh__inner">
				<div className="pwa-pull-refresh__glyph" style={iconStyle}>
					{pullRefresh.refreshing ? <RefreshCw size={19} /> : <ArrowDown size={19} />}
				</div>
				{label && <div className="pwa-pull-refresh__label">{label}</div>}
			</div>
		</div>
	);
}

function PwaLoadingSkeleton() {
	return (
		<div className="pwa-loading-state" aria-label="Loading reminders">
			<div className="pwa-skeleton-header">
				<div className="pwa-skeleton-line is-title" />
				<div className="pwa-skeleton-line is-meta" />
			</div>
			<div className="pwa-skeleton-list">
				{[0, 1, 2, 3, 4].map((item) => (
					<div className="pwa-skeleton-row" key={item}>
						<div className="pwa-skeleton-check" />
						<div className="pwa-skeleton-body">
							<div className="pwa-skeleton-line" />
							<div className="pwa-skeleton-line is-short" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function openObsidianRecoveryLink() {
	window.location.href = '/notifications/open-obsidian';
}

function EmptyAuthState({ config }: { config: StoredConfig }) {
	const standalone = isStandaloneApp();
	return (
		<div className="auth-card">
			<h1>Crate Reminders</h1>
			<p>{standalone
				? 'Open Crate in Obsidian and send a new app link to reconnect this Home Screen app.'
				: 'Open a fresh link from Crate to activate this web app on your device.'}</p>
			<p>Your reminders folder setting is preserved: {config.folderPath}</p>
			<Button className="primary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian</Button>
		</div>
	);
}

function LoadingAuthState() {
	return (
		<div className="auth-card">
			<h1>Crate Reminders</h1>
			<p>Loading reminders...</p>
		</div>
	);
}

function ErrorState({ error, config, onRetry }: { error: string; config: StoredConfig; onRetry: () => void }) {
	const standalone = isStandaloneApp();
	return (
		<div className="auth-card">
			<h1>Crate Reminders</h1>
			<p>{error || 'Something went wrong.'}</p>
			<p>{standalone
				? 'Open Crate in Obsidian and send a new app link if this app can no longer authenticate.'
				: 'Retry, or open a fresh link from Crate if this browser is no longer authenticated.'}</p>
			<p>Your reminders folder setting is preserved: {config.folderPath}</p>
			<Button className="secondary-button" type="button" onClick={openObsidianRecoveryLink}>Open Obsidian</Button>
			<Button className="primary-button" type="button" onClick={onRetry}>Retry</Button>
		</div>
	);
}

function WebReminderCard({
	reminder,
	index,
	hideProject,
	onEdit,
	onToggleComplete,
}: {
	reminder: SharedReminder;
	index: number;
	hideProject: boolean;
	onEdit: (id: string) => void;
	onToggleComplete: (id: string, completed: boolean) => void;
}) {
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;

		const handleClick = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('.reorder-drag-handle')) {
				event.stopPropagation();
				return;
			}

			if (target.closest('.premium-checkbox') || target.closest('[role="checkbox"]')) {
				event.stopPropagation();
				onToggleComplete(reminder.id, reminder.completed);
				return;
			}

			if (target.closest('a[data-markdown-link]')) {
				event.stopPropagation();
				return;
			}

			onEdit(reminder.id);
		};

		wrapper.addEventListener('click', handleClick, true);
		return () => wrapper.removeEventListener('click', handleClick, true);
	}, [onEdit, onToggleComplete, reminder.completed, reminder.id]);

	return (
		<div ref={wrapperRef} className="sidebar-reminder-card-wrapper" style={{ cursor: 'pointer' }}>
			<SharedReminderCard
				reminder={reminder}
				animationConfig={{ enabled: false }}
				index={index}
				hideProject={hideProject}
			/>
		</div>
	);
}

function ReminderSheet({
	modal,
	projects,
	saving,
	onChange,
	onClose,
	onSave,
	onDelete,
}: {
	modal: ModalState;
	projects: string[];
	saving: boolean;
	onChange: React.Dispatch<React.SetStateAction<ModalState | null>>;
	onClose: () => void;
	onSave: (modal: ModalState) => void;
	onDelete: (id: string) => void;
}) {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const richTextInputRef = useRef<RichTextInputHandle | null>(null);
	const editorCardRef = useRef<HTMLDivElement | null>(null);
	const switchTimerRef = useRef<number | null>(null);
	const [pendingPicker, setPendingPicker] = useState<ModalPickerId | null>(null);
	const [returningToEditor, setReturningToEditor] = useState(false);
	const draft = modal.draft;
	const projectOptions = ['Inbox', ...projects.filter((project) => project !== 'Inbox')];
	const isEditing = modal.mode === 'edit';
	const title = isEditing ? 'Edit Reminder' : 'New Reminder';
	const canSubmit = !saving && Boolean(draft.content.trim());

	useLayoutEffect(() => {
		const initialContent = draft.content.trim();
		const shouldSelect = draft.content.trim().length > 0;
		const focusTitle = () => {
			const element = richTextInputRef.current?.getElement();
			const currentContent = element?.textContent?.trim() ?? '';
			if (element && currentContent !== initialContent) {
				if (currentContent === '') richTextInputRef.current?.focus();
				return;
			}
			richTextInputRef.current?.focus({ select: shouldSelect });
		};

		focusTitle();
		const frame = window.requestAnimationFrame(focusTitle);
		const timers = [60, 180, 320].map((delay) => window.setTimeout(focusTitle, delay));
		return () => {
			window.cancelAnimationFrame(frame);
			for (const timer of timers) window.clearTimeout(timer);
		};
		// Intentionally only run when opening a different editor sheet.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [modal.mode, modal.reminderId]);

	useEffect(() => () => {
		if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
	}, []);

	useEffect(() => {
		setPendingPicker(null);
		setReturningToEditor(false);
		if (switchTimerRef.current !== null) {
			window.clearTimeout(switchTimerRef.current);
			switchTimerRef.current = null;
		}
	}, [modal.mode, modal.reminderId]);

	const patchDraft = (patch: Partial<ModalDraft>) => {
		onChange((current) => current ? ({ ...current, draft: { ...current.draft, ...patch } }) : current);
	};

	const autocomplete = useProjectAutocomplete({
		content: draft.content,
		projects: projectOptions,
		onContentChange: (content) => patchDraft({ content }),
		richTextInputRef,
	});

	useEffect(() => {
		if (draft.activePicker || pendingPicker || returningToEditor) return;
		const patch = deriveDraftPatchFromContent(draft, projectOptions);
		if (Object.keys(patch).length > 0) {
			patchDraft(patch);
		}
		// This mirrors the plugin's live text parsing; patchDraft is intentionally local to the render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft.content, draft.activePicker, pendingPicker, returningToEditor, projectOptions.join('\u0000')]);

	const draftFromForm = (form: HTMLFormElement): ModalDraft => {
		const readField = (field: string) => {
			const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-draft-field="${field}"]`);
			return input?.value ?? '';
		};

		return {
			...draft,
			content: draft.content,
			description: readField('description') || draft.description,
			project: readField('project') || draft.project,
			dueDate: readField('dueDate') || draft.dueDate,
			dueTime: readField('dueTime') || draft.dueTime,
		};
	};

	const togglePicker = (picker: ModalPickerId) => {
		if (switchTimerRef.current !== null) return;
		if (draft.activePicker === picker) {
			returnToEditor();
			return;
		}

		setPendingPicker(picker);
		switchTimerRef.current = window.setTimeout(() => {
			switchTimerRef.current = null;
			setPendingPicker(null);
			patchDraft({ activePicker: picker, deleteConfirm: false });
		}, SHEET_SWITCH_DELAY_MS);
	};

	const returnToEditor = (patch: Partial<ModalDraft> = {}) => {
		if (switchTimerRef.current !== null) return;
		setPendingPicker(null);
		setReturningToEditor(true);
		if (Object.keys(patch).length) patchDraft({ ...patch, deleteConfirm: false });
		switchTimerRef.current = window.setTimeout(() => {
			switchTimerRef.current = null;
			setReturningToEditor(false);
			patchDraft({ activePicker: null, deleteConfirm: false });
		}, SHEET_SWITCH_DELAY_MS);
	};

	return (
		<div className="modal-backdrop pwa-reminder-editor-backdrop" onClick={(event) => {
			if (event.target !== event.currentTarget) return;
			if (draft.activePicker) returnToEditor();
			else onClose();
		}}>
			{draft.activePicker ? (
				<PickerSheet
					draft={draft}
					projectOptions={projectOptions}
					isSwitchingOut={returningToEditor}
					onPatch={patchDraft}
					onSelect={returnToEditor}
					onClose={() => returnToEditor()}
				/>
			) : (
				<div className={`modal-card pwa-reminder-editor${pendingPicker ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
					<form className="modal-form" onSubmit={(event) => {
						event.preventDefault();
						onSave({ ...modal, draft: draftFromForm(event.currentTarget) });
					}}>
						<div className="pwa-editor-header">
							<div className="pwa-editor-header__side">
								{isEditing ? (
									<Button
										isIconOnly
										className={`pwa-editor-icon-button pwa-editor-icon-button--danger${draft.deleteConfirm ? ' is-active' : ''}`}
										type="button"
										data-action="toggle-delete-confirm"
										aria-label="Delete reminder"
										onClick={() => patchDraft({ deleteConfirm: !draft.deleteConfirm, activePicker: null })}
									>
										<Trash2 size={20} />
									</Button>
								) : (
									<Button
										isIconOnly
										className="pwa-editor-icon-button pwa-editor-icon-button--muted"
										type="button"
										aria-label="Close modal"
										onClick={onClose}
									>
										<X size={20} />
									</Button>
								)}
							</div>
							<h2 className="pwa-editor-title">{title}</h2>
							<div className="pwa-editor-header__side pwa-editor-header__side--right">
								<Button
									isIconOnly
									className="pwa-editor-icon-button pwa-editor-icon-button--save"
									type="submit"
									data-action="save-reminder"
									aria-label={isEditing ? 'Save reminder' : 'Add reminder'}
									isDisabled={!canSubmit}
									isLoading={saving}
								>
									{isEditing ? <Check size={22} /> : <ArrowUp size={22} />}
								</Button>
							</div>
						</div>

						<div ref={editorCardRef} className="pwa-editor-card">
							<RichTextInput
								ref={richTextInputRef}
								value={draft.content}
								onChange={(content) => patchDraft({ content })}
								placeholder={isEditing ? 'Edit your reminder...' : 'What do you need to remember?'}
								inputRef={contentRef}
								preserveSelection={!pendingPicker && !returningToEditor}
								knownProjects={projectOptions}
								onAutocompleteQuery={autocomplete.updateAutocomplete}
								onAutocompleteKeyDown={autocomplete.handleKeyDown}
								className="pwa-editor-title-input pwa-editor-title-rich-input ios-scroll"
							/>
							{autocomplete.isOpen && (
								<ProjectAutocompleteDropdown
									filteredProjects={autocomplete.filteredProjects}
									highlightedIndex={autocomplete.highlightedIndex}
									anchorRect={autocomplete.rect}
									containerRef={editorCardRef}
									isDark
									onSelect={autocomplete.selectProject}
								/>
							)}
							<div className="pwa-editor-divider" />
							<textarea
								data-draft-field="description"
								className="pwa-editor-description-input ios-scroll"
								rows={3}
								maxLength={4096}
								placeholder="Add description..."
								value={draft.description}
								onChange={(event) => patchDraft({ description: event.currentTarget.value })}
							/>
						</div>

						<div className="pwa-editor-chip-row">
							<Button
								className={`pwa-editor-chip${draft.dueDate ? ' is-active' : ''}`}
								type="button"
								data-action="toggle-picker"
								data-picker="date"
								isDisabled={Boolean(pendingPicker)}
								onClick={() => togglePicker('date')}
							>
								<Calendar size={16} />
								<span>{draft.dueDate ? formatModalDueSummary(draft) : 'Date'}</span>
							</Button>
							<Button
								className="pwa-editor-chip"
								type="button"
								data-action="toggle-picker"
								data-picker="project"
								isDisabled={Boolean(pendingPicker)}
								onClick={() => togglePicker('project')}
							>
								<Hash size={16} />
								<span>{draft.project || 'Inbox'}</span>
							</Button>
							<Button
								isIconOnly
								className={`pwa-editor-chip pwa-editor-chip--icon${draft.priority === 1 ? ' is-important' : ''}`}
								type="button"
								data-action="toggle-priority"
								aria-label="Toggle priority"
								onClick={() => patchDraft({
									...applyReminderTextUpdate(draft, projectOptions, { priority: draft.priority === 1 ? 4 : 1 }),
									activePicker: null,
								})}
							>
								<Flag size={16} fill={draft.priority === 1 ? 'currentColor' : 'none'} />
							</Button>
							<Button
								isIconOnly
								className={`pwa-editor-chip pwa-editor-chip--icon${draft.recurrence ? ' is-active' : ''}`}
								type="button"
								data-action="toggle-picker"
								data-picker="recurrence"
								isDisabled={Boolean(pendingPicker)}
								aria-label={draft.recurrence ? formatRecurrence(draft.recurrence) : 'Recurrence'}
								onClick={() => togglePicker('recurrence')}
							>
								<Repeat size={16} />
							</Button>
						</div>

						{isEditing && draft.deleteConfirm && (
							<div className="delete-confirm">
								<div>
									<strong>Delete this reminder?</strong>
									<p>This removes it from the original markdown file and cancels its scheduled notification.</p>
								</div>
								<div className="delete-confirm__actions">
									<Button className="secondary-button" type="button" onClick={() => patchDraft({ deleteConfirm: false })}>Keep it</Button>
									<Button className="secondary-button is-danger" type="button" data-action="delete-reminder" onClick={() => modal.reminderId && onDelete(modal.reminderId)}>Delete</Button>
								</div>
							</div>
						)}
					</form>
				</div>
			)}
		</div>
	);
}

const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
const RECURRENCE_DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

interface RecurrencePickerDraft {
	frequency: RecurrenceRule['frequency'];
	interval: number;
	daysOfWeek: number[];
	dayOfMonth: number;
	time: string;
}

function buildRecurrencePickerDraft(rule: RecurrenceRule | undefined): RecurrencePickerDraft {
	return {
		frequency: rule?.frequency ?? 'daily',
		interval: rule?.interval ?? 1,
		daysOfWeek: rule?.daysOfWeek ?? [],
		dayOfMonth: rule?.dayOfMonth ?? new Date().getDate(),
		time: `${String(rule?.hour ?? 9).padStart(2, '0')}:${String(rule?.minute ?? 0).padStart(2, '0')}`,
	};
}

function getOrdinalSuffix(value: number): string {
	const endings = ['th', 'st', 'nd', 'rd'];
	const mod = value % 100;
	return `${value}${endings[(mod - 20) % 10] || endings[mod] || endings[0]}`;
}

function recurrenceRuleFromPicker(draft: RecurrencePickerDraft): RecurrenceRule {
	const [rawHour, rawMinute] = draft.time.split(':').map(Number);
	const hour = Number.isInteger(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 9;
	const minute = Number.isInteger(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0;
	const rule: RecurrenceRule = {
		frequency: draft.frequency,
		hour,
		minute,
	};

	if (draft.interval > 1) rule.interval = draft.interval;
	if (draft.frequency === 'weekly' && draft.daysOfWeek.length > 0) rule.daysOfWeek = draft.daysOfWeek;
	if (draft.frequency === 'monthly') rule.dayOfMonth = Math.min(31, Math.max(1, draft.dayOfMonth));

	return normalizeRecurrenceRule(rule) ?? rule;
}

function PickerSheet({
	draft,
	projectOptions,
	isSwitchingOut,
	onPatch,
	onSelect,
	onClose,
}: {
	draft: ModalDraft;
	projectOptions: string[];
	isSwitchingOut: boolean;
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}) {
	const [recurrenceDraft, setRecurrenceDraft] = useState(() => buildRecurrencePickerDraft(draft.recurrence));

	useEffect(() => {
		if (draft.activePicker !== 'recurrence') return;
		setRecurrenceDraft(buildRecurrencePickerDraft(draft.recurrence));
	}, [draft.activePicker, draft.recurrence]);

	if (!draft.activePicker) return null;

	if (draft.activePicker === 'date') {
		return (
			<section className={`pwa-picker-sheet${isSwitchingOut ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label="Schedule reminder">
				<div className="pwa-picker-header">
					<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label="Close schedule" onClick={onClose}>
						<X size={20} />
					</Button>
					<h3>Schedule</h3>
					<Button isIconOnly className="pwa-picker-icon-button pwa-picker-icon-button--done" type="button" aria-label="Done" onClick={onClose}>
						<Check size={20} />
					</Button>
				</div>
				<div className="pwa-picker-content">
					<div className="pwa-picker-presets">
						{([
							['today', 'Today'],
							['tomorrow', 'Tomorrow'],
							['evening', 'This evening'],
							['next-week', 'Next week'],
							['clear', 'No date'],
						] as const).map(([preset, label]) => (
							<Button
								key={preset}
								className={`pwa-picker-option${preset === 'clear' ? ' is-danger' : ''}`}
								type="button"
								data-action="apply-date-preset"
								data-preset={preset}
								onClick={() => onSelect(applyDatePresetToDraft(draft, projectOptions, preset))}
							>
								<span>{label}</span>
								{preset === 'clear' ? <X size={16} /> : <Calendar size={16} />}
							</Button>
						))}
					</div>
					<div className="pwa-picker-fields">
						<label className="pwa-picker-field">
							<span>Date</span>
							<input
								data-draft-field="dueDate"
								type="date"
								value={draft.dueDate}
								onChange={(event) => onPatch(applyDateFieldsToDraft(draft, projectOptions, event.currentTarget.value, draft.dueTime))}
							/>
						</label>
						<label className="pwa-picker-field">
							<span>Time</span>
							<input
								data-draft-field="dueTime"
								type="time"
								value={draft.dueTime}
								onChange={(event) => onPatch(applyDateFieldsToDraft(draft, projectOptions, draft.dueDate || formatLocalDateKey(new Date()), event.currentTarget.value))}
							/>
						</label>
					</div>
				</div>
			</section>
		);
	}

	if (draft.activePicker === 'project') {
		return (
		<section className={`pwa-picker-sheet pwa-project-picker-sheet${isSwitchingOut ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label="Select Project">
			<div className="pwa-picker-header pwa-project-picker-header">
				<Button isIconOnly className="pwa-picker-icon-button pwa-project-picker-back" type="button" aria-label="Back to reminder" onClick={onClose}>
					<ChevronLeft size={22} />
				</Button>
				<h3>Select Project</h3>
				<span aria-hidden="true" />
			</div>
			<div className="pwa-picker-content">
				<div className="pwa-project-list ios-scroll" role="listbox" aria-label="Project selection">
					{projectOptions.map((project) => {
						const colors = getProjectColor(project);
						const selected = draft.project === project;
						return (
							<Button
								key={project}
								className={`pwa-project-option${selected ? ' is-active' : ''}`}
								type="button"
								role="option"
								aria-selected={selected}
								data-action="select-project"
								data-project={project}
								onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, { project }))}
							>
								<span className="pwa-project-option__label">
									<span
										className="pwa-project-dot"
										style={{ '--project-color': colors.dark.accent } as React.CSSProperties}
										aria-hidden="true"
									/>
									<span className="pwa-project-option__name">{project}</span>
								</span>
								{selected ? <Check size={18} /> : null}
							</Button>
						);
					})}
				</div>
			</div>
		</section>
		);
	}

	return (
		<section className={`pwa-picker-sheet pwa-recurrence-picker-sheet${isSwitchingOut ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label="Repeat reminder">
			<div className="pwa-picker-header">
				<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label="Back to reminder" onClick={onClose}>
					<ChevronLeft size={20} />
				</Button>
				<h3>{draft.recurrence ? formatRecurrence(draft.recurrence) : 'Repeat'}</h3>
				<Button
					isIconOnly
					className="pwa-picker-icon-button pwa-picker-icon-button--done"
					type="button"
					aria-label="Apply repeat"
					onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, {
						recurrence: recurrenceRuleFromPicker(recurrenceDraft),
						dueDateValue: null,
						hasTime: false,
					}))}
				>
					<Check size={20} />
				</Button>
			</div>
			<div className="pwa-picker-content">
				<div className="pwa-recurrence-segmented" role="tablist" aria-label="Repeat frequency">
					{RECURRENCE_FREQUENCIES.map((frequency) => (
						<Button
							key={frequency}
							className={`pwa-recurrence-segment${recurrenceDraft.frequency === frequency ? ' is-active' : ''}`}
							type="button"
							role="tab"
							aria-selected={recurrenceDraft.frequency === frequency}
							onClick={() => setRecurrenceDraft((current) => ({ ...current, frequency }))}
						>
							{frequency[0].toUpperCase() + frequency.slice(1)}
						</Button>
					))}
				</div>

				{recurrenceDraft.frequency === 'daily' && (
					<div className="pwa-recurrence-stepper">
						<span>Every</span>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, interval: Math.max(1, current.interval - 1) }))}>-</Button>
						<strong>{recurrenceDraft.interval}</strong>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, interval: Math.min(30, current.interval + 1) }))}>+</Button>
						<span>{recurrenceDraft.interval === 1 ? 'day' : 'days'}</span>
					</div>
				)}

				{recurrenceDraft.frequency === 'weekly' && (
					<div className="pwa-recurrence-days" aria-label="Repeat days">
						{RECURRENCE_DAY_LABELS.map((label, index) => {
							const selected = recurrenceDraft.daysOfWeek.includes(index);
							return (
								<Button
									isIconOnly
									key={`${label}-${index}`}
									className={`pwa-recurrence-day${selected ? ' is-active' : ''}`}
									type="button"
									aria-pressed={selected}
									onClick={() => setRecurrenceDraft((current) => ({
										...current,
										daysOfWeek: selected
											? current.daysOfWeek.filter((day) => day !== index)
											: [...current.daysOfWeek, index].sort((a, b) => a - b),
									}))}
								>
									{label}
								</Button>
							);
						})}
					</div>
				)}

				{recurrenceDraft.frequency === 'monthly' && (
					<div className="pwa-recurrence-stepper">
						<span>Day</span>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, dayOfMonth: Math.max(1, current.dayOfMonth - 1) }))}>-</Button>
						<strong>{getOrdinalSuffix(recurrenceDraft.dayOfMonth)}</strong>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, dayOfMonth: Math.min(31, current.dayOfMonth + 1) }))}>+</Button>
						<span>of month</span>
					</div>
				)}

				<label className="pwa-picker-field pwa-recurrence-time-field">
					<span>Time</span>
					<input type="time" value={recurrenceDraft.time} onChange={(event) => setRecurrenceDraft((current) => ({ ...current, time: event.currentTarget.value }))} />
				</label>

				{draft.recurrence && (
					<Button className="pwa-picker-option is-danger" type="button" onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, { recurrence: null, dueDateValue: null, hasTime: false }))}>
						<span>Remove repeat</span>
						<X size={16} />
					</Button>
				)}
			</div>
		</section>
	);
}

function SettingsSheet({
	config,
	push,
	onClose,
	onEnablePush,
	onRefresh,
	onLogout,
}: {
	config: StoredConfig;
	push: PushState;
	onClose: () => void;
	onEnablePush: () => void;
	onRefresh: () => void;
	onLogout: () => void;
}) {
	const installHint = /iPad|iPhone|iPod/.test(navigator.userAgent) && !isStandaloneApp()
		? 'Add this app to your Home Screen from Safari to enable the best mobile experience and notifications on iPhone.'
		: isStandaloneApp()
			? 'This device is using the installed app experience.'
			: 'You can also install this app from your browser for faster access.';

	return (
		<div className="settings-backdrop" onClick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}>
			<aside className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
				<div className="settings-handle" aria-hidden="true" />
				<div className="settings-sheet__header">
					<div>
						<h2>Settings</h2>
						<p>Notifications, install status, and the current reminder sync target for this device.</p>
					</div>
					<Button isIconOnly className="icon-button" type="button" data-action="close-settings" aria-label="Close settings" onClick={onClose}>
						<X size={20} />
					</Button>
				</div>
				<div className="settings-panel">
					<div className="settings-panel__section">
						<div className="settings-panel__title">Notifications</div>
						<div className="settings-panel__row">
							<span>{push.subscribed ? 'Enabled' : 'Disabled'}</span>
							<Button className="secondary-button" type="button" data-action="enable-push" isDisabled={!push.supported || push.subscribed} onClick={onEnablePush}>
								{push.subscribed ? 'Enabled' : 'Enable'}
							</Button>
						</div>
						{push.status && <p className="settings-panel__hint">{push.status}</p>}
					</div>
					<div className="settings-panel__section">
						<div className="settings-panel__title">Install</div>
						<p className="settings-panel__hint">{installHint}</p>
					</div>
					<div className="settings-panel__section">
						<div className="settings-panel__title">Web app</div>
						<div className="settings-panel__row"><span>Folder</span><code>{config.folderPath}</code></div>
						<div className="settings-panel__row"><span>Upcoming days</span><code>{config.upcomingDays}</code></div>
						<div className="settings-panel__row"><span>All-day time</span><code>{config.allDayNotificationTime ?? 'none'}</code></div>
						<div className="settings-panel__actions">
							<Button className="secondary-button" type="button" data-action="refresh" onClick={onRefresh}><RefreshCw size={15} /> Refresh</Button>
							<Button className="secondary-button is-danger" type="button" data-action="logout" onClick={onLogout}>Log out</Button>
						</div>
					</div>
				</div>
			</aside>
		</div>
	);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
	return outputArray;
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<App />);
