import type { CloudflareApiClient } from '../cloudflare-api';
import { isDefinitiveRejection } from '../cloudflare-api-error';
import { CloudflareReauthorizationRequired } from '../oauth/client';
import { DEPLOYMENT_FENCE_KEY } from '../../protocol/deployment-fence';


export class DeploymentRecoveryRequiredError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'DeploymentRecoveryRequiredError';
	}
}

type FenceApi = Pick<CloudflareApiClient, 'queryD1'>;

/** Steps an update records. Recovery resumes after any of them once it settles. */
export const UPDATE_STEPS = [
	'acquire-deployment', 'freeze-upgrade-data', 'verify-upgrade-checkpoint', 'resume-upgraded-server',
	'prepare-database', 'create-file-bucket', 'initialize-database', 'create-server-address', 'upload-worker',
	'configure-maintenance', 'enable-server-address', 'record-release', 'verify-deployment',
] as const;
/** Deletion steps that only remove resources, so deletion may repeat them while one is in flight. */
export const REPEATABLE_DELETION_STEPS = ['delete-worker', 'deleteR2Objects', 'deleteR2Bucket', 'deleteD1Database', 'enable-deletion-address'] as const;
/** Every step a fence records. Recovery code checks steps against the lists above,
 * so a new step must join one of them. Migration steps are resumable while the
 * release still registers that migration. */
export type FenceStep = typeof UPDATE_STEPS[number] | `migrate-${string}`
	| typeof REPEATABLE_DELETION_STEPS[number];

export interface DeploymentFenceRecord {
	owner: string;
	worker: string;
	kind: 'update' | 'delete';
	version: string;
	fingerprint?: string;
	startedAt: string;
	recoveryProtocol?: 1;
	step?: FenceStep;
	stepState?: 'started' | 'confirmed' | 'rejected' | 'settled';
	verificationPending?: boolean;
	completionOnly?: boolean;
	deletionPending?: true;
	uploadTag?: string;
	resetId?: string;
	cleanupTokenHash?: string;
	batchHash?: string;
}

const FENCE_TABLE_SQL = "CREATE TABLE IF NOT EXISTS maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));";

export async function createFenceTable(api: FenceApi, accountId: string, databaseId: string): Promise<void> {
	await api.queryD1(accountId, databaseId, FENCE_TABLE_SQL);
}

/** A held fence is exactly one string row; anything else needs review. */
export type StoredFence = { state: 'none' } | { state: 'invalid' } | { state: 'held'; value: string };

export async function readStoredFence(api: FenceApi, accountId: string, databaseId: string): Promise<StoredFence> {
	const rows = (await api.queryD1(accountId, databaseId,
		'SELECT value FROM maintenance_state WHERE key = ?;', [DEPLOYMENT_FENCE_KEY])).flatMap(result => result.results ?? []);
	if (!rows.length) return { state: 'none' };
	return rows.length === 1 && typeof rows[0]?.value === 'string' ? { state: 'held', value: rows[0].value } : { state: 'invalid' };
}

/** The stored record as a plain object, or undefined when it is unreadable. */
export function parseFenceRecord(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

/** No request dispatched under this step can still be in flight. */
export function isSettledStep(record: { stepState?: unknown }): boolean {
	return ['confirmed', 'rejected', 'settled'].includes(String(record.stepState));
}

/** Only verification of the published build remains after these confirmed steps. */
const FINAL_UPDATE_STEPS = ['resume-upgraded-server', 'enable-server-address', 'record-release', 'verify-deployment'];
/** Steps a verification-only retry can have reached. */
const COMPLETION_ONLY_STEPS = ['acquire-deployment', 'record-release', 'verify-deployment'];

/** The update needs only its published Worker and address verified. Callers
 * still check the live build and storage before taking ownership. */
export function awaitsPublicationVerification(record: Record<string, unknown>): boolean {
	return isPendingAddressActivation(record)
		|| record.stepState === 'confirmed' && FINAL_UPDATE_STEPS.includes(String(record.step))
		|| record.completionOnly === true && isSettledStep(record) && COMPLETION_ONLY_STEPS.includes(String(record.step));
}

/** Protocol 1 always writes { enabled: true, previews_enabled: false } here.
 * A late repeat only applies those same route flags; it cannot publish code or
 * alter data. Recovery must read both flags and verify the published build.
 * This exception must never be used for uploads, schema writes or deletion. */
export function isPendingAddressActivation(record: {
	kind?: unknown; recoveryProtocol?: unknown; step?: unknown; stepState?: unknown; verificationPending?: unknown;
}): boolean {
	return record.kind === 'update' && record.recoveryProtocol === 1 && record.verificationPending === true
		&& record.step === 'enable-server-address' && record.stepState === 'started';
}

/** A definitive provider rejection cannot later publish the rejected artifact.
 * A replacement still takes ownership by CAS and revalidates storage and schema. */
export function isRejectedWorkerUpload(record: Record<string, unknown>): boolean {
	return record.kind === 'update' && record.recoveryProtocol === 1
		&& record.verificationPending === true && record.step === 'upload-worker'
		&& record.stepState === 'rejected';
}

export class DeploymentFence {
	private uncertain = false;
	private verificationPending = false;
	private databaseRemoved = false;
	private readonly deletionPending: boolean;
	constructor(private api: FenceApi, private account: string, private database: string, private value: string) {
		const record = JSON.parse(value) as DeploymentFenceRecord;
		this.verificationPending = record.verificationPending === true;
		this.deletionPending = record.kind === 'delete' && record.deletionPending === true;
	}

	async mutate<T>(operation: () => Promise<T>, step: FenceStep, batchHash?: string, uploadTag?: string): Promise<T> {
		const stored = await readStoredFence(this.api, this.account, this.database);
		if (stored.state !== 'held' || stored.value !== this.value) throw new DeploymentRecoveryRequiredError('Deployment ownership changed. Start again after reviewing the deployment fence.');
		await this.recordStep(step, 'started', batchHash, uploadTag);
		// Never expire or steal this fence: the provider cannot reject an old,
		// already-dispatched upload using a D1 fencing token.
		this.uncertain = true;
		try {
			const result = await operation();
			await this.recordStep(step, 'confirmed');
			this.uncertain = false;
			return result;
		} catch (error) {
			// A saved login surfaces Cloudflare's 401/403 refusal as reauthorization.
			if (error instanceof CloudflareReauthorizationRequired || isDefinitiveRejection(error)) {
				await this.recordStep(step, 'rejected');
				this.uncertain = false;
			}
			throw error;
		}
	}


	private async recordStep(step: FenceStep, stepState: 'started' | 'confirmed' | 'rejected' | 'settled', batchHash?: string, uploadTag?: string): Promise<void> {
		if (this.databaseRemoved) return;
		const record = JSON.parse(this.value) as DeploymentFenceRecord;
		const next = JSON.stringify({ ...record, step, stepState, batchHash, ...(uploadTag ? { uploadTag } : {}), ...(this.verificationPending || record.verificationPending ? { verificationPending: this.verificationPending } : {}) });
		try {
			const rows = (await this.api.queryD1(this.account, this.database,
				`UPDATE maintenance_state SET value = ?${record.kind === 'delete' ? '' : ", updated_at = datetime('now')"} WHERE key = ? AND value = ? RETURNING value;`,
				[next, DEPLOYMENT_FENCE_KEY, this.value])).flatMap(result => result.results ?? []);
			if (rows.length !== 1 || rows[0]?.value !== next) throw new Error('Deployment ownership changed');
			this.value = next;
		} catch (error) {
			this.uncertain = true;
			throw new DeploymentRecoveryRequiredError('Could not checkpoint the server operation. Keep the deployment fence held and inspect its recorded step before recovery.', { cause: error });
		}
	}

	/** Each dispatch has a fresh provider-visible receipt; never retry this request. */
	async uploadWorker(operation: (tag: string) => Promise<void>): Promise<void> {
		const tag = `crate-${crypto.randomUUID()}`;
		await this.mutate(() => operation(tag), 'upload-worker', undefined, tag);
	}

	// Once storage or code changes, keep the lock until both have been verified.
	async checkpoint(step: FenceStep): Promise<void> { await this.recordStep(step, 'confirmed'); }
	requireVerification(): void { this.verificationPending = true; }
	async completeVerification(): Promise<void> {
		this.verificationPending = false;
		try { await this.recordStep('verify-deployment', 'confirmed'); }
		catch (error) { this.verificationPending = true; throw error; }
	}

	removedDatabase(): void { this.databaseRemoved = true; }

	async finish(): Promise<void> {
		if (this.databaseRemoved) return;
		if (this.verificationPending) throw new DeploymentRecoveryRequiredError('The update needs its matching Worker and database verified. The deployment fence remains held until recovery completes.');
		if (this.uncertain) throw new DeploymentRecoveryRequiredError('A Cloudflare mutation has an uncertain outcome. The deployment fence remains held. See docs/deployment.md and scripts/crate-deployment-fence.py before retrying.');
		if (this.deletionPending) throw new DeploymentRecoveryRequiredError('Server deletion is incomplete. The deployment fence remains held until the original server storage is removed. Retry server deletion.');
		try {
			await this.api.queryD1(this.account, this.database,
				'DELETE FROM maintenance_state WHERE key = ? AND value = ?;', [DEPLOYMENT_FENCE_KEY, this.value]);
		} catch (error) {
			throw new DeploymentRecoveryRequiredError('Could not confirm release of the deployment fence. Inspect it with scripts/crate-deployment-fence.py before retrying; see docs/deployment.md.', { cause: error });
		}
	}
}

export async function withDeploymentFence<T>(input: {
	api: FenceApi; accountId: string; databaseId: string;
	record: Omit<DeploymentFenceRecord, 'owner' | 'startedAt'>;
	/** Exact inspected predecessor of a deletion; replacing it prevents the old client advancing. */
	recoverDeletionValue?: string;
	resumeUpdateValue?: string;
}, operation: (fence: DeploymentFence) => Promise<T>): Promise<T> {
	const recoveredValue = input.resumeUpdateValue ?? input.recoverDeletionValue;
	// Acquisition itself dispatches no provider mutation. Persist its checkpoint
	// atomically with ownership so a lost response or crash is always recoverable.
	// Any following mutation must CAS this exact record to "started" first.
	const value = JSON.stringify({ ...input.record, recoveryProtocol: 1, owner: crypto.randomUUID(), startedAt: new Date().toISOString(),
		step: 'acquire-deployment', stepState: 'confirmed' });
	await createFenceTable(input.api, input.accountId, input.databaseId);
	let acquired: Array<Record<string, unknown>>;
	try {
		acquired = (await input.api.queryD1(input.accountId, input.databaseId,
			recoveredValue === undefined
				? 'INSERT INTO maintenance_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING value;'
				: `UPDATE maintenance_state SET value = ?${input.record.kind === 'delete' ? '' : ", updated_at = datetime('now')"} WHERE key = ? AND value = ? RETURNING value;`,
			recoveredValue === undefined ? [DEPLOYMENT_FENCE_KEY, value] : [value, DEPLOYMENT_FENCE_KEY, recoveredValue]))
			.flatMap(result => result.results ?? []);
	} catch (error) {
		// A definite rejection (quota, permissions, or invalid SQL) did not
		// acquire ownership. Preserve the provider's actionable error instead
		// of sending users to recovery for a lock that was never created.
		if (isDefinitiveRejection(error)) throw error;
		throw new DeploymentRecoveryRequiredError('Could not confirm deployment ownership. Inspect the deployment fence with scripts/crate-deployment-fence.py before retrying; see docs/deployment.md.');
	}
	if (acquired.length !== 1 || acquired[0]?.value !== value) {
		throw new DeploymentRecoveryRequiredError('Another deployment or server deletion is active or needs recovery. Wait for it to finish; for an abandoned operation see docs/deployment.md and scripts/crate-deployment-fence.py.');
	}
	const fence = new DeploymentFence(input.api, input.accountId, input.databaseId, value);
	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, value: await operation(fence) };
	} catch (error) {
		outcome = { ok: false, error };
	}
	try { await fence.finish(); }
	catch (error) {
		const failure = outcome.ok ? undefined : outcome.error;
		const combined = new DeploymentRecoveryRequiredError(`${failure instanceof Error ? `${failure.message}. ` : ''}${error instanceof Error ? error.message : 'Could not release the deployment fence.'}`);
		if (failure instanceof Error) combined.name = failure.name;
		throw combined;
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
