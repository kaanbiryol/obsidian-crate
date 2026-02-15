/**
 * Status bar component for sync status display
 */

import { setIcon, type Plugin } from 'obsidian';
import type { SyncState, SyncStatus } from '../types';

export class StatusBarManager {
	private plugin: Plugin;
	private statusBarEl: HTMLElement | null = null;
	private enabled: boolean;
	private syncProgress: { current: number; total: number } | null = null;
	private currentStatus: SyncStatus | null = null;
	private iconEl: HTMLSpanElement | null = null;
	private textEl: HTMLSpanElement | null = null;

	constructor(plugin: Plugin, enabled: boolean) {
		this.plugin = plugin;
		this.enabled = enabled;

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
		this.update({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0 });
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
	 * Set sync progress for initial sync display
	 */
	setSyncProgress(current: number, total: number): void {
		this.syncProgress = { current, total };
		this.update({ status: 'syncing', lastSync: null, lastError: null, pendingChanges: 0 });
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
		if (!this.statusBarEl) return;

		const { icon, text, tooltip } = this.getDisplayInfo(state);
		const statusChanged = this.currentStatus !== state.status;

		if (statusChanged || !this.iconEl || !this.textEl) {
			this.statusBarEl.empty();
			this.statusBarEl.setAttribute('data-status', state.status);
			this.iconEl = this.statusBarEl.createSpan({ cls: 'crate-status-icon' });
			if (icon) {
				this.iconEl.textContent = icon;
			} else {
				setIcon(this.iconEl, 'loader');
			}
			this.textEl = this.statusBarEl.createSpan({ text: ` ${text}`, cls: 'crate-status-text' });
			this.currentStatus = state.status;
		} else {
			this.textEl.textContent = ` ${text}`;
		}

		this.statusBarEl.setAttribute('aria-label', tooltip);
		this.statusBarEl.setAttribute('data-tooltip-position', 'top');
	}

	/**
	 * Get display information for state
	 */
	private getDisplayInfo(state: SyncState): { icon: string | null; text: string; tooltip: string } {
		switch (state.status) {
			case 'syncing':
				return {
					icon: null,
					text: this.syncProgress
					? `Syncing ${this.syncProgress.current}/${this.syncProgress.total}`
					: state.pendingChanges > 0 ? `Syncing (${state.pendingChanges})` : 'Syncing...',
					tooltip: 'Sync in progress',
				};

			case 'error':
				return {
					icon: '⚠',
					text: 'Sync error',
					tooltip: state.lastError || 'An error occurred during sync',
				};

			case 'offline':
				return {
					icon: '○',
					text: 'Offline',
					tooltip: 'Cannot connect to sync server',
				};

			case 'idle':
			default:
				if (state.pendingChanges > 0) {
					return {
						icon: '◐',
						text: `${state.pendingChanges} pending`,
						tooltip: `${state.pendingChanges} changes waiting to sync`,
					};
				}

				if (state.lastSync) {
					const lastSyncDate = new Date(state.lastSync);
					const ago = this.formatTimeAgo(lastSyncDate);
					return {
						icon: '✓',
						text: 'Synced',
						tooltip: `Last sync: ${ago}`,
					};
				}

				return {
					icon: '○',
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
			this.statusBarEl.remove();
			this.statusBarEl = null;
			this.iconEl = null;
			this.textEl = null;
			this.currentStatus = null;
		}
	}
}
