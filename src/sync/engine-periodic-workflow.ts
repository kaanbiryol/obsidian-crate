import { notifyConflicts } from './conflict';
import { MAX_CHECK_BACKOFF_MULTIPLIER } from './engine-constants';
import { createLogger, errorMessage } from '../plugin/logger';
import type { SyncResult } from '../plugin/types';
import type { SyncStatus } from './engine-workflow-shared';

const logger = createLogger('SyncEngine');

export interface PeriodicCheckWorkflowContext {
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
	getSyncIntervalSeconds(): number;
	getLastSeq(): number;
	getPendingPathCount(): number;
	getConsecutiveCheckFailures(): number;
	setConsecutiveCheckFailures(value: number): void;
	getLastCheckAttempt(): number;
	setLastCheckAttempt(value: number): void;
	checkForChanges(lastSeq: number): Promise<{ hasChanges: boolean }>;
	sync(): Promise<SyncResult>;
}

export async function runPeriodicCheckWorkflow(
	context: PeriodicCheckWorkflowContext
): Promise<void> {
	if (context.getStatus() === 'syncing') return;
	if (!context.apiConfigured()) return;

	if (context.getConsecutiveCheckFailures() > 0) {
		const multiplier = Math.min(
			2 ** (context.getConsecutiveCheckFailures() - 1),
			MAX_CHECK_BACKOFF_MULTIPLIER,
		);
		const backoffMs = context.getSyncIntervalSeconds() * 1000 * multiplier;
		if (Date.now() - context.getLastCheckAttempt() < backoffMs) {
			return;
		}
	}
	context.setLastCheckAttempt(Date.now());

	try {
		const { hasChanges } = await context.checkForChanges(context.getLastSeq());

		if (!hasChanges && context.getPendingPathCount() === 0) {
			logger.debug('Periodic check: no changes');
			context.setConsecutiveCheckFailures(0);
			return;
		}

		logger.info('Periodic check: changes detected, running sync');
		const result = await context.sync();
		notifyConflicts(result.conflicts);
		context.setConsecutiveCheckFailures(0);
	} catch (error) {
		const failures = context.getConsecutiveCheckFailures() + 1;
		const multiplier = Math.min(2 ** (failures - 1), MAX_CHECK_BACKOFF_MULTIPLIER);
		context.setConsecutiveCheckFailures(failures);
		logger.warn(
			`Periodic check failed (attempt ${failures}, next in ~${multiplier}x interval):`,
			errorMessage(error),
		);
	}
}
