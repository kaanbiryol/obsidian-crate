import type { CrateServerInfo } from '../../protocol/server-info';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';
import type { SyncApiClient } from '../worker-api/client';
import { checkServerReachability, SERVER_CHECK_TIMEOUT_MS } from '../connection/server-reachability';
import type { SyncRuntimeSettings } from '../settings';

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
	private remoteChangesFound = false;

	constructor(private readonly options: {
		settings: Pick<SyncRuntimeSettings,'workerUrl' | 'cloudflareDeployment'>;
		getClient: () => SyncApiClient | null;
		/** Capture the idle engine generation; reject observations after sync or replacement. */
		captureIdleState: () => (() => boolean) | null;
		/** Whether a sync would bring server changes to this device. */
		checkRemoteChanges: () => Promise<boolean>;
		onChange: () => void;
	}) {}

	get issue(): string | null { return this.connectionIssue; }
	/** The server has changes this device has not applied, kept until a sync clears it. */
	get remoteChanges(): boolean { return this.remoteChangesFound; }
	/** A sync is starting: it reports reachability and applies the remote changes itself. */
	clearObservations(): void {
		this.connectionIssue = null;
		this.remoteChangesFound = false;
	}

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
		this.clearObservations();
		this.lastCheckAt = null;
	}

	cancelCheck(): void {
		// A check that never ran does not hold back the next one.
		if (this.timer) { clearTimeout(this.timer); this.lastCheckAt = null; }
		this.timer = null;
		this.controller?.abort();
		this.controller = null;
	}

	scheduleCheck(): void {
		if (this.timer || this.controller) return;
		if (this.lastCheckAt !== null && Date.now() - this.lastCheckAt < SERVER_CHECK_COOLDOWN_MS) return;
		// Measured from scheduling, so a one-minute check interval is not skipped every other time.
		this.lastCheckAt = Date.now();
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.check();
		}, SERVER_CHECK_DELAY_MS);
	}

	private async check(): Promise<void> {
		const isCurrent = this.options.captureIdleState();
		// Nothing was asked of the server, so the next trigger may check right away.
		if (!isCurrent) { this.lastCheckAt = null; return; }
		const controller = new AbortController();
		this.controller = controller;
		let timedOut = false;
		const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, SERVER_CHECK_TIMEOUT_MS);
		const stale = () => (controller.signal.aborted && !timedOut) || this.controller !== controller || !isCurrent();
		try {
			const result = await checkServerReachability(this.options.settings.workerUrl, controller.signal);
			clearTimeout(timeout);
			if (stale()) return;
			const issue = timedOut ? 'The sync server took too long to respond. Check that it is running.' : result;
			if (this.connectionIssue !== issue) {
				this.connectionIssue = issue;
				this.options.onChange();
			}
			// Found changes stay until a sync clears them, so later checks skip the request.
			if (issue || this.remoteChangesFound) return;
			const found = await this.options.checkRemoteChanges();
			if (stale() || !found) return;
			this.remoteChangesFound = true;
			this.options.onChange();
		} catch (error) {
			if (!controller.signal.aborted) logger.warn('Server check failed:', errorMessage(error));
		} finally {
			clearTimeout(timeout);
			if (this.controller === controller) this.controller = null;
		}
	}
}
