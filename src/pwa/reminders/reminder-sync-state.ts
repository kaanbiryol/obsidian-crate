import type { DataMode } from '../types';
import type { ReminderIndexingProgress } from './reminder-api';
import type { ReminderListFailureOutcome } from './reminder-list-response';
import type { ReminderRecord, ReminderSourceIssue } from './types';

export interface ConfirmedReminderSnapshot {
	reminders: ReminderRecord[];
	projects: string[];
}

/** What the reminder screens show. Request bookkeeping stays in refs in `useReminderSync`. */
export interface ReminderSyncViewState {
	snapshot: ConfirmedReminderSnapshot;
	loading: boolean;
	refreshing: boolean;
	indexingProgress: ReminderIndexingProgress | null;
	error: string | null;
	issues: ReminderSourceIssue[];
	dataMode: DataMode;
	lastUpdatedAt: number | null;
	/** A confirmed response shows the server is reachable while the browser still reports
	 * offline, until the browser's next online or offline event. */
	answered: boolean;
	/** The app connection whose startup hydration finished. */
	hydratedAuthority: object | null;
}

export type ReminderSyncEvent =
	/** The same confirmed list, presented again (for example after a rejected reorder). */
	| { type: 'presented'; snapshot: ConfirmedReminderSnapshot }
	/** The server confirmed the list: a new snapshot, or unchanged after a 304. `answered` is
	 * false for a request sent before the browser's latest online or offline event, whose
	 * response says nothing about the connection now. */
	| { type: 'confirmed'; savedAt: number; snapshot?: ConfirmedReminderSnapshot; answered: boolean }
	| { type: 'cache-hydrated'; snapshot: ConfirmedReminderSnapshot; issues: ReminderSourceIssue[]; savedAt: number }
	| { type: 'read-started'; silent: boolean }
	| { type: 'indexing'; progress: ReminderIndexingProgress }
	/** A local write, an invalidation or a new connection left in-flight reads unusable. */
	| { type: 'reads-detached' }
	| { type: 'list-received'; issues: ReminderSourceIssue[] }
	| { type: 'list-rejected'; message: string; showErrorState: boolean }
	/** Runs after `cache-hydrated` for a `hydrate-cache` outcome. */
	| { type: 'read-failed'; outcome: ReminderListFailureOutcome['kind']; message: string }
	/** The latest read finished, whatever its outcome. */
	| { type: 'read-settled' }
	| { type: 'reset'; snapshot: ConfirmedReminderSnapshot }
	| { type: 'error'; message: string | null }
	| { type: 'hydration-finished'; authority: object }
	| { type: 'connectivity-changed' };

export function initialReminderSyncState(): ReminderSyncViewState {
	return {
		snapshot: { reminders: [], projects: [] },
		loading: true,
		refreshing: false,
		indexingProgress: null,
		error: null,
		issues: [],
		dataMode: 'live',
		lastUpdatedAt: null,
		answered: false,
		hydratedAuthority: null,
	};
}

/** Keeps the current state when nothing changes, so React can skip the render. */
function patch(state: ReminderSyncViewState, changes: Partial<ReminderSyncViewState>): ReminderSyncViewState {
	const changed = (Object.keys(changes) as (keyof ReminderSyncViewState)[]).some(key => !Object.is(changes[key], state[key]));
	return changed ? { ...state, ...changes } : state;
}

export function reduceReminderSync(state: ReminderSyncViewState, event: ReminderSyncEvent): ReminderSyncViewState {
	switch (event.type) {
		case 'presented': return patch(state, { snapshot: event.snapshot });
		case 'confirmed': return patch(state, {
			...(event.snapshot && { snapshot: event.snapshot }),
			lastUpdatedAt: event.savedAt, dataMode: 'live', answered: state.answered || event.answered,
		});
		case 'cache-hydrated': return patch(state, {
			loading: false, snapshot: event.snapshot, issues: event.issues, lastUpdatedAt: event.savedAt, dataMode: 'cached',
		});
		case 'read-started': return patch(state, {
			...(event.silent ? { refreshing: true } : { loading: true }), error: null, indexingProgress: null,
		});
		case 'indexing': return patch(state, { indexingProgress: event.progress });
		case 'reads-detached': return patch(state, { indexingProgress: null });
		case 'list-received': return patch(state, { error: null, issues: event.issues });
		case 'list-rejected': return patch(state, { error: event.message, ...(event.showErrorState && { dataMode: 'error' }) });
		case 'read-failed': return patch(state, {
			error: event.message,
			// A hydrated disk copy already set the cached mode.
			...(event.outcome === 'keep-stale' ? { dataMode: 'cached' } : event.outcome === 'error' ? { dataMode: 'error' } : {}),
		});
		case 'read-settled': return patch(state, { indexingProgress: null, refreshing: false, loading: false });
		case 'reset': return patch(state, {
			snapshot: event.snapshot, issues: [], loading: false, refreshing: false, indexingProgress: null, lastUpdatedAt: null,
		});
		case 'error': return patch(state, { error: event.message });
		case 'hydration-finished': return patch(state, { hydratedAuthority: event.authority });
		case 'connectivity-changed': return patch(state, { answered: false });
	}
}
