import { pruneChangelog } from './db';
import { drainObjectCleanupQueue } from './storage/index';
import type { Env } from './types';

export async function runScheduledMaintenance(env: Env): Promise<void> {
	await drainObjectCleanupQueue(env.BUCKET, env.DB);
	await pruneChangelog(env.DB);
}
