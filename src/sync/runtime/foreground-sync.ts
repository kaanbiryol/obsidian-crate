import { notifyConflicts } from '../conflict/conflict';
import { createLogger } from '../logger';
import type { SyncResult } from '../types';

const logger = createLogger('SyncRuntime');
export const FOREGROUND_SYNC_DEBOUNCE_MS = 1_000;
export const FOREGROUND_SYNC_COOLDOWN_MS = 30_000;

export type ForegroundSyncReason = 'focus' | 'visible' | 'online';

/** Debounces focus, visibility and network events into at most one automatic
 * sync per cooldown. Any completed ordinary sync restarts the cooldown. */
export class ForegroundSyncScheduler {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lastSyncAt: number | null = null;

	constructor(private readonly context: {
		canSync: () => boolean;
		sync: () => Promise<SyncResult>;
	}) {}

	trigger(reason: ForegroundSyncReason): void {
		if (!this.context.canSync() || this.timer || this.onCooldown()) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.run(reason);
		}, FOREGROUND_SYNC_DEBOUNCE_MS);
	}

	recordSync(): void {
		this.lastSyncAt = Date.now();
	}

	cancel(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = null;
	}

	private onCooldown(): boolean {
		return this.lastSyncAt !== null && Date.now() - this.lastSyncAt < FOREGROUND_SYNC_COOLDOWN_MS;
	}

	private async run(reason: ForegroundSyncReason): Promise<void> {
		if (!this.context.canSync() || this.onCooldown()) return;
		this.recordSync();
		logger.info(`Foreground sync triggered: ${reason}`);
		try {
			const result = await this.context.sync();
			if (result.outcome !== 'cancelled') notifyConflicts(result.conflicts);
		} catch (error) {
			logger.warn('Foreground sync failed:', error);
		}
	}
}
