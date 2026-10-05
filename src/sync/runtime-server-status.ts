import type { CrateServerInfo } from '../protocol';
import type { CrateSettings } from '../plugin/settings-types';
import { createLogger, errorMessage } from '../plugin/logger';
import type { SyncApiClient } from './api';
import { checkServerReachability, SERVER_CHECK_TIMEOUT_MS } from './server-reachability';

const logger = createLogger('RuntimeServerStatus');
const SERVER_CHECK_DELAY_MS = 2_000;
const SERVER_CHECK_COOLDOWN_MS = 60_000;

/** Connection observations only: the runtime retains engine and lifecycle authority. */
export class RuntimeServerStatus {
	private versionInfo?: { client: SyncApiClient; connection: string; expires: number; info: CrateServerInfo };
	private versionRequest?: { client: SyncApiClient; connection: string; promise: Promise<CrateServerInfo> };
	private timer: ReturnType<typeof setTimeout> | null = null;
	private controller: AbortController | null = null;
	private lastCheckAt: number | null = null;
	private connectionIssue: string | null = null;

	constructor(private readonly options: {
		settings: Pick<CrateSettings, 'workerUrl' | 'cloudflareDeployment'>;
		getClient: () => SyncApiClient | null;
		/** Capture the idle engine generation; reject observations after sync or replacement. */
		captureIdleState: () => (() => boolean) | null;
		onIssueChange: () => void;
	}) {}

	get issue(): string | null { return this.connectionIssue; }
	clearIssue(): void { this.connectionIssue = null; }

	private versionConnection(): string {
		const { workerUrl, cloudflareDeployment: deployment } = this.options.settings;
		return JSON.stringify([workerUrl, deployment?.accountId, deployment?.workerName, deployment?.d1DatabaseId]);
	}

	getCachedVersionInfo(): CrateServerInfo | undefined {
		const cached = this.versionInfo;
		return cached?.client === this.options.getClient() && cached?.connection === this.versionConnection()
			&& cached.expires > Date.now() ? cached.info : undefined;
	}

	getDiagnosticVersionInfo(): CrateServerInfo | undefined {
		// Diagnostics retain the last observation even after its display cache expires.
		return this.versionInfo?.client === this.options.getClient() ? this.versionInfo?.info : undefined;
	}

	async getVersionInfo(): Promise<CrateServerInfo> {
		const client = this.options.getClient();
		if (!client) throw new Error('Not connected');
		const connection = this.versionConnection();
		if (this.versionRequest?.client === client && this.versionRequest.connection === connection) return this.versionRequest.promise;
		this.versionInfo = undefined;
		const promise = client.getServerInfo().then(info => {
			if (this.options.getClient() !== client || connection !== this.versionConnection()) throw new Error('Server changed');
			this.versionInfo = { client, connection, info, expires: Date.now() + 30_000 };
			return info;
		});
		this.versionRequest = { client, connection, promise };
		try { return await promise; }
		finally { if (this.versionRequest?.promise === promise) this.versionRequest = undefined; }
	}

	reset(): void {
		this.cancelCheck();
		this.clearIssue();
		this.lastCheckAt = null;
	}

	cancelCheck(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.controller?.abort();
		this.controller = null;
	}

	scheduleCheck(): void {
		if (this.timer || this.controller) return;
		if (this.lastCheckAt !== null && Date.now() - this.lastCheckAt < SERVER_CHECK_COOLDOWN_MS) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.check();
		}, SERVER_CHECK_DELAY_MS);
	}

	private async check(): Promise<void> {
		const isCurrent = this.options.captureIdleState();
		if (!isCurrent) return;
		const controller = new AbortController();
		this.controller = controller;
		this.lastCheckAt = Date.now();
		let timedOut = false;
		const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, SERVER_CHECK_TIMEOUT_MS);
		try {
			const result = await checkServerReachability(this.options.settings.workerUrl, controller.signal);
			if ((controller.signal.aborted && !timedOut) || this.controller !== controller || !isCurrent()) return;
			const issue = timedOut ? 'The sync server took too long to respond. Check that it is running.' : result;
			if (this.connectionIssue !== issue) {
				this.connectionIssue = issue;
				this.options.onIssueChange();
			}
		} catch (error) {
			if (!controller.signal.aborted) logger.warn('Server check failed:', errorMessage(error));
		} finally {
			clearTimeout(timeout);
			if (this.controller === controller) this.controller = null;
		}
	}
}
