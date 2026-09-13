import { CloudflareApiError, type CloudflareApiClient } from './cloudflare-api';


export class DeploymentRecoveryRequiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeploymentRecoveryRequiredError';
    }
}

export const DEPLOYMENT_FENCE_KEY = 'crate_deployment_fence';
type FenceApi = Pick<CloudflareApiClient, 'queryD1'>;

export interface DeploymentFenceRecord {
	owner: string;
	worker: string;
	kind: 'update' | 'reset' | 'delete';
	version: string;
	fingerprint?: string;
	startedAt: string;
	recoveryProtocol?: 1;
	step?: string;
	stepState?: 'started' | 'confirmed';
}

export class DeploymentFence {
	private uncertain = false;
	private databaseRemoved = false;
	constructor(private api: FenceApi, private account: string, private database: string, private value: string) {}

	async mutate<T>(operation: () => Promise<T>, step = 'server-change'): Promise<T> {
		const rows = (await this.api.queryD1(this.account, this.database,
			'SELECT value FROM maintenance_state WHERE key = ?;', [DEPLOYMENT_FENCE_KEY])).flatMap(result => result.results ?? []);
		if (rows.length !== 1 || rows[0]?.value !== this.value) throw new DeploymentRecoveryRequiredError('Deployment ownership changed. Start again after reviewing the deployment fence.');
		await this.recordStep(step, 'started');
		// Never expire or steal this fence: the provider cannot reject an old,
		// already-dispatched upload using a D1 fencing token.
		this.uncertain = true;
		try {
			const result = await operation();
			await this.recordStep(step, 'confirmed');
			this.uncertain = false;
			return result;
		} catch (error) {
			if (error instanceof CloudflareApiError && error.status >= 400 && error.status < 500 && error.status !== 408) this.uncertain = false;
			throw error;
		}
	}


    private async recordStep(step: string, stepState: 'started' | 'confirmed'): Promise<void> {
        if (this.databaseRemoved) return;
        const record = JSON.parse(this.value) as DeploymentFenceRecord;
        const next = JSON.stringify({ ...record, step, stepState });
        try {
            const rows = (await this.api.queryD1(this.account, this.database,
                "UPDATE maintenance_state SET value = ?, updated_at = datetime('now') WHERE key = ? AND value = ? RETURNING value;",
                [next, DEPLOYMENT_FENCE_KEY, this.value])).flatMap(result => result.results ?? []);
            if (rows.length !== 1 || rows[0]?.value !== next) throw new Error('Deployment ownership changed');
            this.value = next;
        } catch {
            this.uncertain = true;
            throw new DeploymentRecoveryRequiredError('Could not checkpoint the server operation. Keep the deployment fence held and inspect its recorded step before recovery.');
        }
    }

	removedDatabase(): void { this.databaseRemoved = true; }

	async finish(): Promise<void> {
		if (this.databaseRemoved) return;
		if (this.uncertain) throw new DeploymentRecoveryRequiredError('A Cloudflare mutation has an uncertain outcome. The deployment fence remains held. See docs/deployment.md and scripts/crate-deployment-fence.py before retrying.');
		try {
			await this.api.queryD1(this.account, this.database,
				'DELETE FROM maintenance_state WHERE key = ? AND value = ?;', [DEPLOYMENT_FENCE_KEY, this.value]);
		} catch {
			throw new DeploymentRecoveryRequiredError('Could not confirm release of the deployment fence. Inspect it with scripts/crate-deployment-fence.py before retrying; see docs/deployment.md.');
		}
	}
}

export async function withDeploymentFence<T>(input: {
	api: FenceApi; accountId: string; databaseId: string;
	record: Omit<DeploymentFenceRecord, 'owner' | 'startedAt'>;
}, operation: (fence: DeploymentFence) => Promise<T>): Promise<T> {
	const value = JSON.stringify({ ...input.record, recoveryProtocol: 1, owner: crypto.randomUUID(), startedAt: new Date().toISOString() });
	await input.api.queryD1(input.accountId, input.databaseId,
		"CREATE TABLE IF NOT EXISTS maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));");
	let acquired: Array<Record<string, unknown>>;
	try {
		acquired = (await input.api.queryD1(input.accountId, input.databaseId,
			'INSERT INTO maintenance_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING value;', [DEPLOYMENT_FENCE_KEY, value]))
			.flatMap(result => result.results ?? []);
	} catch {
		throw new DeploymentRecoveryRequiredError('Could not confirm deployment ownership. Inspect the deployment fence with scripts/crate-deployment-fence.py before retrying; see docs/deployment.md.');
	}
	if (acquired.length !== 1 || acquired[0]?.value !== value) {
		throw new DeploymentRecoveryRequiredError('Another deployment or server reset is active or needs recovery. Wait for it to finish; for an abandoned operation see docs/deployment.md and scripts/crate-deployment-fence.py.');
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

/** Keep reset's read-only verification separate from its fenced mutations. */
export function fenceResetMutations<T extends object>(api: T, fence: DeploymentFence): T {
	const methods = new Set(['retireCrateWorker', 'deleteR2Object', 'deleteR2Bucket', 'deleteD1Database']);
	return new Proxy(api, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== 'function') return value;
			if (!methods.has(String(property))) return value.bind(target) as unknown;
			return (...args: unknown[]) => fence.mutate(async () => {
				const result: unknown = await value.apply(target, args);
				if (property === 'deleteD1Database') fence.removedDatabase();
				return result;
			}, String(property));
		},
	});
}
