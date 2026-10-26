import { formatSyncProgress } from './activity/progress-label';
import { describeSyncStatus } from './activity/activity-status';
/**
 * Status bar component for sync status display
 */

import type { Plugin } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBarIndicator } from './StatusBarIndicator';
import type { SyncActivityProgress, SyncState } from '../sync/types';

export class StatusBarManager {
	private plugin: Plugin;
	private statusBarEl: HTMLElement | null = null;
	private enabled = false;
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

	constructor(plugin: Plugin, onClick?: () => void) {
		this.plugin = plugin;
		this.onClick = onClick ?? null;
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
			// destroy() removes these; registerDomEvent would keep each detached item until unload.
			this.statusBarEl.addEventListener('click', this.activate);
			this.statusBarEl.addEventListener('mousedown', this.onMouseDown);
			this.statusBarEl.addEventListener('keydown', this.onKeyDown);
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
	 * Update status display; progress counts show while syncing without a named phase
	 */
	update(state: SyncState, progress: SyncActivityProgress | null = null): void {
		if (!this.statusBarEl) return;

		const { text, tooltip } = this.getDisplayInfo(state, progress);
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
	private getDisplayInfo(state: SyncState, progress: SyncActivityProgress | null): { text: string; tooltip: string | null } {
		if (state.status === 'idle' && state.conflictCount > 0) {
			return {
				text: state.conflictCount === 1 ? '1 conflict' : `${state.conflictCount} conflicts`,
				tooltip: 'Local-only conflict copies need review. Open Sync activity → Conflicts.',
			};
		}

		const status = describeSyncStatus(state, state.pendingChanges);
		switch (status.kind) {
			case 'syncing':
				return {
					// The status bar has no progress panel, so it names the current phase.
					text: state.work?.phase === 'applying' ? status.text : formatSyncProgress(state.work ? null : progress, state.work),
					tooltip: 'Comparing and syncing changes. Unchanged files are skipped. Open sync activity for details.',
				};

			case 'offline':
				return {
					text: status.text,
					tooltip: state.lastError || 'Cannot connect to sync server',
				};

			case 'checking':
				return {
					text: status.text,
					tooltip: 'Loading sync state and checking local files before reporting sync status.',
				};

			case 'pending':
				return {
					text: status.text,
					tooltip: `${state.pendingChanges} local file changes waiting to sync, including deletions. This is not the total number of files in your vault.`,
				};

			case 'never':
				return {
					text: status.text,
					tooltip: 'No sync has been performed yet',
				};

			default:
				return {
					text: status.text,
					tooltip: null,
				};
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
