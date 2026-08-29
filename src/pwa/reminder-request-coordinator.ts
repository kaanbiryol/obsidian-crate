export interface ReminderReadToken {
	requestId: number;
	mutationRevision: number;
}

export interface ReminderRequestCoordinator {
	beginRead(): ReminderReadToken;
	beginMutation(): () => void;
	shouldApplyRead(token: ReminderReadToken): boolean;
	isLatestRead(token: ReminderReadToken): boolean;
	invalidateReads(): void;
}

/**
 * Prevents background reads from replacing optimistic state while a mutation is
 * in flight. A read is safe to apply only when it is the newest request and no
 * mutation started or finished during that request.
 */
export function createReminderRequestCoordinator(): ReminderRequestCoordinator {
	let latestReadId = 0;
	let mutationRevision = 0;
	let activeMutations = 0;

	return {
		beginRead() {
			latestReadId += 1;
			return {
				requestId: latestReadId,
				mutationRevision,
			};
		},

		beginMutation() {
			activeMutations += 1;
			mutationRevision += 1;
			let ended = false;

			return () => {
				if (ended) return;
				ended = true;
				activeMutations = Math.max(0, activeMutations - 1);
				mutationRevision += 1;
			};
		},

		shouldApplyRead(token) {
			return activeMutations === 0
				&& token.requestId === latestReadId
				&& token.mutationRevision === mutationRevision;
		},

		isLatestRead(token) {
			return token.requestId === latestReadId;
		},

		invalidateReads() {
			mutationRevision += 1;
		},
	};
}
