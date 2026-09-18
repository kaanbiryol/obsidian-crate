import { formatSyncProgress } from './activity/progress-label';
/**
 * Status bar component for sync status display
 */

import type { Plugin } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBarIndicator } from './StatusBarIndicator';
import type { SyncState } from '../sync/types';

export class StatusBarManager {
	private plugin: Plugin;
	private statusBarEl: HTMLElement | null = null;
	private enabled: boolean;
	private syncProgress: { current: number; total: number } | null = null;
	private work: SyncState['work'];
	private indicatorRoot: Root | null = null;
	private iconEl: HTMLSpanElement | null = null;
	private onClick: (() => void) | null;
	private readonly activate = () => this.onClick?.();
	private readonly onMouseDown = (event: MouseEvent) => {
		// Keep the editor as the return-focus target when activity opens by mouse.
		// Keyboard activation still focuses this control and restores focus here.
		if (event.button === 0) event.preventDefault();
	};
	private readonly onKeyDown = (event: KeyboardEvent) => {
		if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
			event.preventDefault();
			this.activate();
		}
	};

	constructor(plugin: Plugin, enabled: boolean, onClick?: () => void) {
		this.plugin = plugin;
		this.enabled = enabled;
		this.onClick = onClick ?? null;

		if (enabled) {
			this.create();
		}
	}

	/**
	 * Create status bar element
	 */
	private create(): void {
		this.statusBarEl = this.plugin.addStatusBarItem();
		this.statusBarEl.addClass('crate-status-bar');
		if (this.onClick) {
			this.statusBarEl.setAttribute('role', 'button');
			this.statusBarEl.tabIndex = 0;
			this.plugin.registerDomEvent(this.statusBarEl, 'click', this.activate);
			this.plugin.registerDomEvent(this.statusBarEl, 'mousedown', this.onMouseDown);
			this.plugin.registerDomEvent(this.statusBarEl, 'keydown', this.onKeyDown);
		}
		this.update({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 });
	}

	/**
	 * Enable/disable status bar
	 */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;

		this.enabled = enabled;

		if (enabled) {
			this.create();
		} else {
			this.destroy();
		}
	}

	/**
	 * Set progress for the active sync
	 */
	setSyncProgress(current: number, total: number): void {
		this.syncProgress = { current, total };
		this.update({ work: this.work, status: 'syncing', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 });
	}

	/**
	 * Clear sync progress
	 */
	clearSyncProgress(): void {
		this.syncProgress = null;
	}

	/**
	 * Update status display
	 */
	update(state: SyncState): void {
		if (state.status !== 'syncing') this.syncProgress = null;
		this.work = state.status === 'syncing' ? state.work : undefined;
		if (!this.statusBarEl) return;

		const { text, tooltip } = this.getDisplayInfo(state);
		if (!this.iconEl) {
			this.statusBarEl.empty();
			this.iconEl = this.statusBarEl.createSpan({ cls: 'crate-status-indicator-host' });
			this.indicatorRoot = createRoot(this.iconEl);
		}
		this.statusBarEl.setAttribute('data-status', state.status);
		this.indicatorRoot?.render(createElement(StatusBarIndicator, { state }));
		if (tooltip) {
			this.statusBarEl.setAttribute('aria-label', this.onClick ? `Open sync activity. ${text}. ${tooltip}` : tooltip);
			this.statusBarEl.setAttribute('data-tooltip-position', 'top');
		} else {
			this.statusBarEl.setAttribute('aria-label', this.onClick ? `Open sync activity. ${text}.` : text);
			this.statusBarEl.removeAttribute('data-tooltip-position');
		}
	}

	/**
	 * Get display information for state
	 */
	private getDisplayInfo(state: SyncState): { text: string; tooltip: string | null } {
		switch (state.status) {
			case 'syncing':
				return {
					text: this.work?.phase === 'applying' ? 'Syncing…' : formatSyncProgress(!this.work && this.syncProgress ? { type: 'sync', ...this.syncProgress } : null, this.work),
					tooltip: 'Comparing and syncing changes. Unchanged files are skipped. Open sync activity for details.',
				};

			case 'error':
				return {
					text: 'Sync error',
					tooltip: null,
				};

			case 'offline':
				return {
					text: 'Offline',
					tooltip: 'Cannot connect to sync server',
				};

			case 'idle':
			default:
				if (state.conflictCount > 0) {
					return {
						text: state.conflictCount === 1 ? '1 conflict' : `${state.conflictCount} conflicts`,
						tooltip: 'Local-only conflict copies need review. Open Sync activity → Conflicts.',
					};
				}

				if (state.pendingChanges > 0) {
					return {
						text: `${state.pendingChanges} change${state.pendingChanges === 1 ? '' : 's'} queued`,
						tooltip: `${state.pendingChanges} local file changes waiting to sync, including deletions. This is not the total number of files in your vault.`,
					};
				}

				if (state.lastSync) {
					const lastSyncDate = new Date(state.lastSync);
					const ago = this.formatTimeAgo(lastSyncDate);
					return {
						text: 'Synced',
						tooltip: `Last sync: ${ago}`,
					};
				}

				return {
					text: 'Not synced',
					tooltip: 'No sync has been performed yet',
				};
		}
	}

	/**
	 * Format relative time
	 */
	private formatTimeAgo(date: Date): string {
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffSeconds = Math.floor(diffMs / 1000);
		const diffMinutes = Math.floor(diffSeconds / 60);
		const diffHours = Math.floor(diffMinutes / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffSeconds < 60) {
			return 'just now';
		} else if (diffMinutes < 60) {
			return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
		} else if (diffHours < 24) {
			return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
		} else {
			return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
		}
	}

	/**
	 * Destroy status bar element
	 */
	destroy(): void {
		if (this.statusBarEl) {
			this.statusBarEl.removeEventListener('click', this.activate);
			this.statusBarEl.removeEventListener('mousedown', this.onMouseDown);
			this.statusBarEl.removeEventListener('keydown', this.onKeyDown);
			this.indicatorRoot?.unmount();
			this.indicatorRoot = null;
			this.statusBarEl.remove();
			this.statusBarEl = null;
			this.iconEl = null;
		}
	}
}
