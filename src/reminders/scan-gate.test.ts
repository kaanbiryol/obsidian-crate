import { describe, expect, it, vi } from 'vitest';
import { createReminderScanGate, type ReminderScanGateHost } from './scan-gate';

function harness({ configured = true, api = null as object | null } = {}) {
	const state = { status: 'idle', api, configured, layoutReady: true, pendingMoves: false, pendingFiles: new Set<string>() };
	const host = {
		workspace: { get layoutReady() { return state.layoutReady; } },
		syncRuntime: {
			getState: vi.fn(() => ({ status: state.status })),
			getApiClient: vi.fn(() => state.api),
			isConfigured: vi.fn(() => state.configured),
		},
		journal: {
			hasPending: () => state.pendingMoves,
			isPendingFile: (path: string) => state.pendingFiles.has(path),
		},
	} as unknown as ReminderScanGateHost;
	let gate = createReminderScanGate(host);
	const transition = (...statuses: string[]) => {
		for (const status of statuses) {
			state.status = status;
			gate.onSyncStateChanged();
		}
	};
	// A folder change or re-enable replaces the backend and its gate.
	const rebuild = () => (gate = createReminderScanGate(host));
	return { state, gate, transition, rebuild };
}

describe('reminder scan gate', () => {
	it('defers scans until the vault file list is ready and while sync runs', () => {
		const { state, gate } = harness();
		state.layoutReady = false;
		expect(gate.shouldDeferScan()).toBe(true);
		expect(gate.shouldDeferScan('Reminders/Inbox.md')).toBe(true);
		state.layoutReady = true;
		expect(gate.shouldDeferScan()).toBe(false);
		state.status = 'syncing';
		expect(gate.shouldDeferScan('Reminders/Inbox.md')).toBe(true);
	});

	it('defers only the files of an unresolved move', () => {
		const { state, gate } = harness();
		state.pendingFiles.add('Reminders/Pending.md');
		expect(gate.shouldDeferScan()).toBe(false);
		expect(gate.shouldDeferScan('Reminders/Healthy.md')).toBe(false);
		expect(gate.shouldDeferScan('Reminders/Pending.md')).toBe(true);
	});

	it('allows collision repair without a configured connection unless a move is pending', () => {
		const { state, gate } = harness({ configured: false });
		expect(gate.shouldDeferCollisionRepair()).toBe(false);
		state.pendingMoves = true;
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
	});

	it('verifies a connection only after it finishes a sync', () => {
		const { state, gate, transition } = harness();
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
		state.api = {};
		transition('idle'); // An idle initialization callback has not reconciled file ownership.
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
		transition('syncing', 'error', 'idle');
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
		transition('syncing', 'idle');
		expect(gate.shouldDeferCollisionRepair()).toBe(false);
		state.status = 'offline';
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
		state.status = 'idle';
		state.api = {};
		expect(gate.shouldDeferCollisionRepair()).toBe(true); // A replaced connection needs its own reconciliation.
	});

	it('does not trust an existing connection before it finishes a sync', () => {
		const { gate, transition } = harness({ api: {} });
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
		transition('syncing', 'idle');
		expect(gate.shouldDeferCollisionRepair()).toBe(false);
	});

	it('keeps a completed sync verified when the backend is rebuilt', () => {
		const { state, transition, rebuild } = harness({ api: {} });
		expect(rebuild().shouldDeferCollisionRepair()).toBe(true);
		transition('syncing', 'idle');
		expect(rebuild().shouldDeferCollisionRepair()).toBe(false);
		state.api = {};
		expect(rebuild().shouldDeferCollisionRepair()).toBe(true);
	});

	it('verifies a connection with the sync that was running when the backend was rebuilt', () => {
		const { state, transition, rebuild } = harness({ api: {} });
		state.status = 'syncing';
		const gate = rebuild();
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
		transition('idle');
		expect(gate.shouldDeferCollisionRepair()).toBe(false);
	});

	it('does not verify a connection replaced during sync', () => {
		const { state, gate, transition } = harness({ api: {} });
		transition('syncing');
		state.api = {};
		transition('idle');
		expect(gate.shouldDeferCollisionRepair()).toBe(true);
	});
});
