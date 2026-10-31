import type { SyncIndicatorState } from '@/ui/shared/SyncIndicator';

export type ToastKind = 'success' | 'error' | 'info';
export type StartTab = 'inbox' | 'today' | 'upcoming' | 'browse';
export type DataMode = 'live' | 'cached' | 'error';
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export interface ToastAction { label: string; onSelect: () => void }
export type ShowToast = (kind: ToastKind, message: string, syncState?: SyncIndicatorState, action?: ToastAction) => void;

export interface StoredConfig {
	folderPath: string;
	upcomingDays: number;
	allDayNotificationTime: string | null;
}

export interface ToastState {
	syncState?: SyncIndicatorState;
	kind: ToastKind;
	message: string;
	action?: ToastAction;
}

export interface PullRefreshState {
	distance: number;
	progress: number;
	ready: boolean;
	refreshing: boolean;
}
