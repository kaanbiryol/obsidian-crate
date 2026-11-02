import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Plugin, View } from 'obsidian';
import { StatusBarIndicator } from './StatusBarIndicator';
import { describeSyncStatus } from '../activity/activity-status';
import type { SyncActivityProgress, SyncState } from '../../sync/types';

type ActionView = View & { addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement };

interface HeaderAction {
	el: HTMLElement;
	root: Root;
}

/**
 * Obsidian mobile hides plugin status bar items, so each main-area view header
 * carries the sync indicator instead. Selecting it opens sync activity.
 */
export class HeaderSyncIndicator {
	private enabled = false;
	private state: SyncState | null = null;
	private readonly actions = new Map<View, HeaderAction>();

	constructor(private readonly plugin: Plugin, private readonly onClick: () => void) {
		plugin.registerEvent(plugin.app.workspace.on('layout-change', () => this.attach()));
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		if (enabled) this.attach();
		else this.destroy();
	}

	update(state: SyncState, _progress: SyncActivityProgress | null = null): void {
		this.state = state;
		for (const action of this.actions.values()) this.render(action);
	}

	destroy(): void {
		for (const { el, root } of this.actions.values()) {
			root.unmount();
			el.remove();
		}
		this.actions.clear();
	}

	private attach(): void {
		if (!this.enabled) return;
		for (const [view, action] of this.actions) {
			if (action.el.isConnected) continue;
			action.root.unmount();
			this.actions.delete(view);
		}
		this.plugin.app.workspace.iterateRootLeaves(leaf => {
			const view = leaf.view;
			if (this.actions.has(view) || !('addAction' in view)) return;
			const el = (view as ActionView).addAction('refresh-cw', 'Crate sync', () => this.onClick());
			el.empty();
			el.addClass('crate-header-sync');
			const action = { el, root: createRoot(el) };
			this.actions.set(view, action);
			this.render(action);
		});
	}

	private render({ el, root }: HeaderAction): void {
		if (!this.state) return;
		const { text } = describeSyncStatus(this.state, this.state.pendingChanges);
		const conflicts = this.state.conflictCount;
		const label = conflicts > 0 ? `${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}` : text;
		el.setAttribute('aria-label', `Crate sync: ${label}. Open sync activity.`);
		root.render(createElement(StatusBarIndicator, { state: this.state }));
	}
}
