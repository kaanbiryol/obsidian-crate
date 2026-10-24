/**
 * Roles are named instances of the `ReminderAlarm` Durable Object class, whose
 * class name deployment discovery pins. The coordinator serializes sync writes,
 * imports, checkpoints, Reading publication and maintenance. Each reminder's
 * delivery state lives in an instance named by its reminder ID. Renaming a role
 * orphans the state stored under its old name.
 */
const COORDINATOR_NAME = '__crate__/projection';
const NOTIFICATION_DISPATCHER_NAME = '__crate__/notification-dispatch';
const MAINTENANCE_NAME = '__crate__/maintenance';
const READING_NAME = '__crate__/reading';
/** Transfers spread over a fixed pool; reads use a separate pool of the same size. */
const TRANSFER_SHARDS = 8;

/** Internal endpoints; `coordinator-requests.ts` dispatches on the same paths. */
export const COORDINATOR_PATHS = {
	ensure: '/ensure',
	project: '/project',
	maintain: '/maintain',
	readingWake: '/reading-wake',
	readingPublish: '/reading-publish',
	readingSealed: '/reading-sealed',
	dispatchJobs: '/dispatch-jobs',
	commitUpload: '/commit-upload',
	commitNewFiles: '/commit-new-files',
} as const;
type CoordinatorPath = typeof COORDINATOR_PATHS[keyof typeof COORDINATOR_PATHS];

/** Transfer pool endpoints; `coordinator-requests.ts` dispatches these paths too. */
export const TRANSFER_PATHS = {
	syncUpload: '/sync-upload',
	syncBatchUpload: '/sync-batch-upload',
	importUpload: '/import-upload',
	batchDownload: '/batch-download',
	historyCheckpoint: '/history-checkpoint',
	historyCheckpointFile: '/history-checkpoint-file',
} as const;
export type TransferPath = typeof TRANSFER_PATHS[keyof typeof TRANSFER_PATHS];

/** Set by a coordinator pass that has just loaded the feature policy. */
export const REMINDERS_ENABLED_HEADER = 'X-Crate-Reminders-Enabled';
/** Marks a public request that the Worker forwarded to run under the coordinator lock. */
export const INTERNAL_MUTATION_HEADER = 'X-Crate-Internal-Mutation';

type AlarmBinding = { REMINDER_ALARMS: DurableObjectNamespace };

function roleStub(env: AlarmBinding, name: string): DurableObjectStub {
	return env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(name));
}

function post(stub: DurableObjectStub, path: CoordinatorPath, init: Omit<RequestInit, 'method'> = {}): Promise<Response> {
	return stub.fetch(`https://do${path}`, { method: 'POST', ...init });
}

function coordinatorStub(env: AlarmBinding): DurableObjectStub {
	return roleStub(env, COORDINATOR_NAME);
}

/** Runs a public request under the coordinator lock, after the Worker's own checks. */
export function forwardToCoordinator(env: AlarmBinding, request: Request): Promise<Response> {
	const forwarded = new Request(request);
	forwarded.headers.set(INTERNAL_MUTATION_HEADER, '1');
	return coordinatorStub(env).fetch(forwarded);
}

/** A random instance of the upload or read transfer pool. These hold no storage. */
export function transferStub(env: AlarmBinding, pool: 'transfer' | 'transfer-read'): DurableObjectStub {
	const shard = crypto.getRandomValues(new Uint8Array(1))[0]! % TRANSFER_SHARDS;
	return roleStub(env, `__crate__/${pool}/${shard}`);
}

/** Arms projection for the current parser version. Returns whether the coordinator accepted. */
export async function ensureProjection(env: AlarmBinding): Promise<boolean> {
	return (await post(coordinatorStub(env), COORDINATOR_PATHS.ensure)).ok;
}

/** Wakes notification and Reading projection. Returns whether the coordinator accepted. */
export async function wakeProjection(env: AlarmBinding): Promise<boolean> {
	return (await post(coordinatorStub(env), COORDINATOR_PATHS.project)).ok;
}

/** Arms the maintenance role's cleanup alarm. Returns whether it accepted. */
export async function requestMaintenance(env: AlarmBinding): Promise<boolean> {
	return (await post(roleStub(env, MAINTENANCE_NAME), COORDINATOR_PATHS.maintain)).ok;
}

/** Arms the Reading role's capture and extraction alarm. Returns whether it accepted. */
export async function wakeReading(env: AlarmBinding): Promise<boolean> {
	return (await post(roleStub(env, READING_NAME), COORDINATOR_PATHS.readingWake)).ok;
}

/** Publishes a fetched Reading capture or extraction under the coordinator lock. */
export async function publishReading(env: AlarmBinding, publication: object): Promise<boolean> {
	return (await post(coordinatorStub(env), COORDINATOR_PATHS.readingPublish, { body: JSON.stringify(publication) })).ok;
}

/** Seals and commits a Save to Crate note for an encrypted vault under the coordinator lock. */
export async function commitSealedReading(env: AlarmBinding, note: object): Promise<boolean> {
	return (await post(coordinatorStub(env), COORDINATOR_PATHS.readingSealed, { body: JSON.stringify(note) })).status === 204;
}

/** Drains due notification jobs on the dispatcher role, with its own request budget. */
export async function dispatchNotifications(env: AlarmBinding, remindersEnabled?: boolean): Promise<boolean> {
	return (await post(roleStub(env, NOTIFICATION_DISPATCHER_NAME), COORDINATOR_PATHS.dispatchJobs, {
		headers: remindersEnabled ? { [REMINDERS_ENABLED_HEADER]: '1' } : undefined,
	})).ok;
}

/** Commits a staged upload under the coordinator lock. */
export function commitCoordinatorUpload(env: AlarmBinding, init: Omit<RequestInit, 'method'>): Promise<Response> {
	return post(coordinatorStub(env), COORDINATOR_PATHS.commitUpload, init);
}

/** Schedules one reminder's delivery on its own instance; the method selects the command. */
export function scheduleReminderDelivery(env: AlarmBinding, reminderId: string, schedule: object): Promise<Response> {
	return roleStub(env, reminderId).fetch('https://do/schedule', { method: 'PUT', body: JSON.stringify(schedule) });
}

export function cancelReminderDelivery(env: AlarmBinding, reminderId: string, jobToken: string): Promise<Response> {
	return roleStub(env, reminderId).fetch(`https://do/cancel?reminderId=${encodeURIComponent(reminderId)}&jobToken=${encodeURIComponent(jobToken)}`, { method: 'DELETE' });
}

/** Commits staged new files under the coordinator lock. */
export function commitCoordinatorNewFiles(env: AlarmBinding, init: Omit<RequestInit, 'method'>): Promise<Response> {
	return post(coordinatorStub(env), COORDINATOR_PATHS.commitNewFiles, init);
}
