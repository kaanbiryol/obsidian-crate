import type { SyncIndicatorState } from '@/ui/shared/SyncIndicator';

export type ToastKind = 'success' | 'error' | 'info';
export type StartTab = 'inbox' | 'today' | 'upcoming' | 'browse';
export type DataMode = 'live' | 'cached' | 'error';
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type ShowToast = (kind: ToastKind, message: string, syncState?: SyncIndicatorState) => void;

export interface StoredConfig {
	folderPath: string;
	upcomingDays: number;
	allDayNotificationTime: string | null;
}

export interface ToastState {
	syncState?: SyncIndicatorState;
	kind: ToastKind;
	message: string;
}

export interface PullRefreshState {
	distance: number;
	progress: number;
	ready: boolean;
	refreshing: boolean;
}
