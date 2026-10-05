/** Feature policy stays separate from the final durable storage checks in apply-update. */
export function reminderUpdateReadiness(state: {
	bootstrapped: boolean; enabled: boolean; connected: boolean; mutationsReady: boolean;
	initialContentReady: boolean; interacting: boolean; preparingMutation: boolean;
	launchPending: boolean; loading: boolean; refreshing: boolean; isOffline: boolean;
	unsettled: boolean;
}) {
	return {
		updateContentReady: !state.enabled || state.initialContentReady,
		updateReady: state.bootstrapped && !state.interacting && !state.preparingMutation
			&& (!state.connected || (state.mutationsReady && !state.unsettled
				&& (!state.enabled || (state.initialContentReady && !state.launchPending
					&& !state.loading && !state.refreshing && !state.isOffline)))),
	};
}

export function readingUpdateReadiness(state: {
	ready: boolean; connecting: boolean; enabled: boolean; connected: boolean;
	hasCache: boolean; hasError: boolean; adding: boolean; saving: boolean;
	preparingChange: boolean; syncing: boolean; isOffline: boolean;
}) {
	return {
		updateContentReady: state.ready && !state.connecting
			&& (!state.enabled || !state.connected || state.hasCache || state.hasError),
		updateReady: state.ready && !state.connecting && !state.adding && !state.saving
			&& !state.preparingChange && !state.syncing && !state.isOffline,
	};
}
