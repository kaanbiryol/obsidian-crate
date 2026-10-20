import type { BackupChoice } from '../restore/archive';
import { runRestoreWorkflow } from '../restore/workflow';
import { normalizeVaultName } from '../vault-name';
import type { DeploymentRecoveryResult } from './recovery';
import { resumeInterruptedUpdate } from './resume-update';
import { deleteCrateServer } from '../server-reset/delete';
import { resetCrateServer } from '../server-reset/reset';
import type { CrateSettings } from '../../plugin/settings';
import type { CloudflareDeploymentMetadata, CloudflareDeploymentResult, DeploymentIntent, DeploymentRequest, SavedDeploymentIntent } from './types';
import { CloudflareApiClient } from '../cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './artifacts';
import type { HttpTransport } from '../http';
import { CLOUDFLARE_OAUTH_SCOPES } from '../oauth/config';
import { CloudflareOAuthClient, CloudflareReauthorizationRequired, type CloudflareOAuthTokens } from '../oauth/client';
import { CloudflareOAuthSession } from './oauth-session';
import { provisionCloudflareDeployment } from './provisioner';
import { stableJson } from '../../platform/stable-json';
import { createCloudflareDeploymentMetadata, resolveDeploymentTarget, type SelectDeployment } from './target';
import {
	registerCloudflareAuthorizedDevice,
	type CloudflareAuthorizedDevice,
} from './device-registration';

interface DeploymentSettingsOwner {
	settings: CrateSettings;
	writeSettings(update: Partial<CrateSettings>): Promise<void>;
}

/** Runs an operation with saved Cloudflare authorization, renewing it when needed. */
export type WithCloudflareAuthorization = <T>(operation: (tokens: CloudflareOAuthTokens) => Promise<T>) => Promise<T>;

type DeploymentAccount = Awaited<ReturnType<typeof resolveDeploymentTarget>>['account'];

export interface CloudflareDeploymentServiceOptions {
	clientId: string;
	getVaultName?: () => string;
	settingsOwner: DeploymentSettingsOwner;
	transport: HttpTransport;
	loadArtifacts: () => Promise<CloudflareDeploymentArtifacts>;
	openExternal: (url: string) => void;
	selectDeployment: SelectDeployment;
	onAuthorized?: (accountId: string, tokens: CloudflareOAuthTokens) => void;
	beforeServerReset?: () => Promise<void>;
	beforeServerSwitch?: () => Promise<void>;
	now?: () => number;
}

export class CloudflareDeploymentService {
	private readonly oauthClient: CloudflareOAuthClient;
	private readonly oauthSession: CloudflareOAuthSession;
	private readonly now: () => number;
	private readonly lifetime = new AbortController();
	private handlingCallback = false;

	constructor(private readonly options: CloudflareDeploymentServiceOptions) {
		this.oauthClient = new CloudflareOAuthClient(options.clientId, options.transport);
		this.now = options.now ?? Date.now;
		this.oauthSession = new CloudflareOAuthSession(options.clientId, this.now, options.openExternal);
	}

	get isBusy(): boolean { return this.handlingCallback; }

	get pendingIntent(): DeploymentIntent | null {
		return this.oauthSession.intent;
	}

	async startDeployment(intent: DeploymentIntent = 'connect'): Promise<void> {
		this.assertIdle();
		const existingMetadata = this.options.settingsOwner.settings.cloudflareDeployment;
		if ((existingMetadata?.deletion || existingMetadata?.reset?.deleteOnly) && intent !== 'delete') throw new Error('Resume server deletion before connecting or updating.');
		if (existingMetadata?.reset && intent !== 'reset' && intent !== 'delete') throw new Error('Resume the server reset before connecting or updating.');
		if ((intent === 'reset' || intent === 'delete') && (!existingMetadata?.accountId || !existingMetadata.d1DatabaseId)) {
			throw new Error('Connect to a Crate server before resetting its remote data.');
		}
		if (intent === 'reconnect' && (!existingMetadata?.accountId || !existingMetadata.d1DatabaseId)) throw new Error('Connect a Cloudflare server first.');
		const metadata = existingMetadata && intent !== 'switch' && intent !== 'create'
			? { ...existingMetadata }
			: createCloudflareDeploymentMetadata(this.options.getVaultName?.());

		this.cancelPendingDeployment();
		await this.oauthSession.start({
			metadata,
			originalMetadata: stableJson(existingMetadata),
			discoverExisting: intent === 'switch' || (intent === 'connect' && (!existingMetadata || Boolean(existingMetadata.lastDeployedVersion))),
			intent,
		}, this.lifetime.signal);
	}

	async handleCallback(params: Record<string, string>, device?: CloudflareAuthorizedDevice, onProgress?: (message: string) => void, selectDeployment = this.options.selectDeployment): Promise<CloudflareDeploymentResult> {
		this.assertIdle('A Cloudflare operation is already in progress.');
		// The callback consumes the pending browser session, so it does not cancel it.
		this.handlingCallback = true;
		try {
			return await this.whileActive(() => this.handleAuthorizedCallback(params, device, message => {
				this.lifetime.signal.throwIfAborted();
				onProgress?.(message);
			}, selectDeployment));
		} finally {
			this.handlingCallback = false;
		}
	}

	private async handleAuthorizedCallback(
		params: Record<string, string>,
		device?: CloudflareAuthorizedDevice,
		onProgress?: (message: string) => void,
		selectDeployment = this.options.selectDeployment,
	): Promise<CloudflareDeploymentResult> {
		const { code, verifier, request } = this.oauthSession.take(params);
		onProgress?.('Completing Cloudflare authorization…');
		this.lifetime.signal.throwIfAborted();
		const tokens = await this.oauthClient.exchangeTokens(code, verifier);
		return this.runAuthorizedDeployment(request, tokens, device, onProgress, selectDeployment);
	}

	private async runAuthorizedDeployment(
		request: DeploymentRequest,
		tokens: CloudflareOAuthTokens,
		device?: CloudflareAuthorizedDevice,
		onProgress?: (message: string) => void,
		selectDeployment = this.options.selectDeployment,
		savedLogin = false,
	): Promise<CloudflareDeploymentResult> {
		let retained = savedLogin;
		try {
			this.lifetime.signal.throwIfAborted();
			const checkTarget = savedLogin || request.intent === 'reconnect' ? () => this.checkSavedTarget(request.metadata, request.intent) : undefined;
			const api = this.createGuardedApi(tokens, savedLogin ? 'saved' : 'temporary', checkTarget);
			this.assertRequestCurrent(request);
			const { metadata, account, reuseExisting } = await this.whileActive(() => resolveDeploymentTarget({
				request, api, getVaultName: this.options.getVaultName, selectDeployment, onProgress,
				whileActive: operation => this.whileActive(operation),
			}));
			checkTarget?.();
			onProgress?.('Preparing the selected server…');
			await this.prepareTarget(request, metadata, account);
			if (request.intent === 'delete') return await this.deleteServer(api, account, metadata, savedLogin, onProgress);
			const result = await this.deployServer(request, api, account, metadata, reuseExisting, device, onProgress);
			this.lifetime.signal.throwIfAborted();
			if (!savedLogin && this.options.onAuthorized) {
				this.options.onAuthorized(account.id, tokens);
				retained = true;
			}
			return result;
		} finally {
			if (!retained) await this.revokeTokens(tokens);
		}
	}

	/** Refuse a request whose saved server changed or gained a pending reset or deletion during authorization. */
	private assertRequestCurrent(request: DeploymentRequest): void {
		const saved = this.options.settingsOwner.settings.cloudflareDeployment;
		if (saved?.deletion && request.intent !== 'delete') throw new Error('Resume server deletion before connecting or updating.');
		if (request.intent !== 'reset' && request.intent !== 'delete' && saved?.reset) throw new Error('Resume the server reset before connecting or updating.');
		if ((request.intent === 'reset' || request.intent === 'delete') && stableJson(request.metadata) !== stableJson(saved)) {
			throw new Error('Server settings changed during authorization. Confirm the reset again.');
		}
		if ((request.intent === 'switch' || request.intent === 'create') && request.originalMetadata !== stableJson(saved)) throw new Error('Server settings changed during authorization. Start again.');
		if (request.intent === 'reconnect') this.checkSavedTarget(request.metadata, request.intent);
	}

	/** Stop sync before changing servers, then save the account the deployment targets. */
	private async prepareTarget(request: DeploymentRequest, metadata: CloudflareDeploymentMetadata, account: DeploymentAccount): Promise<void> {
		const previous = this.options.settingsOwner.settings.cloudflareDeployment;
		const changingServer = previous && (previous.accountId !== account.id || previous.workerName !== metadata.workerName);
		if (changingServer || request.intent === 'switch' || request.intent === 'create') {
			if (!this.options.beforeServerSwitch) throw new Error('Switching servers requires sync shutdown.');
			await this.whileActive(this.options.beforeServerSwitch);
		}
		if (!metadata.vaultName && (request.intent === 'update' || request.intent === 'reset')) {
			metadata.vaultName = normalizeVaultName(this.options.getVaultName?.());
		}
		metadata.accountId = account.id;
		metadata.accountName = account.name;
		await this.persistMetadata(metadata);
	}

	private async deleteServer(api: CloudflareApiClient, account: DeploymentAccount, metadata: CloudflareDeploymentMetadata, savedLogin: boolean, onProgress?: (message: string) => void): Promise<CloudflareDeploymentResult> {
		if (!this.options.beforeServerReset) throw new Error('Deletion requires sync shutdown.');
		await this.whileActive(() => deleteCrateServer({
			api, accountId: account.id, metadata,
			beforeDelete: () => this.whileActive(this.options.beforeServerReset!), onProgress,
			persist: () => this.persistMetadata(metadata),
		}));
		if (!savedLogin) await this.whileActive(() => this.options.settingsOwner.writeSettings({ cloudflareDeployment: null }));
		return { status: 'deleted', accountName: account.name };
	}

	/** Reset if requested, publish or reuse the Worker, then register this device. */
	private async deployServer(
		request: DeploymentRequest,
		api: CloudflareApiClient,
		account: DeploymentAccount,
		metadata: CloudflareDeploymentMetadata,
		reuseExisting: boolean,
		device?: CloudflareAuthorizedDevice,
		onProgress?: (message: string) => void,
	): Promise<CloudflareDeploymentResult> {
		const artifacts = request.intent === 'reset' ? await this.whileActive(this.options.loadArtifacts) : null;
		if (request.intent === 'reset') {
			if (!device || !artifacts || !this.options.beforeServerReset) throw new Error('Reset requires a new device credential and sync shutdown.');
			await this.whileActive(() => resetCrateServer({
				api, accountId: account.id, metadata, version: artifacts.version,
				beforeDelete: () => this.whileActive(this.options.beforeServerReset!), onProgress,
				persist: () => this.persistMetadata(metadata),
			}));
		}
		let workerUrl: string;
		if (reuseExisting) {
			// Registering a replica must never replace shared Worker/PWA code.
			const subdomain = await this.whileActive(() => api.getWorkersSubdomain(account.id));
			if (!subdomain) throw new Error('Existing Cloudflare server has no workers.dev subdomain');
			metadata.workersSubdomain = subdomain;
			await this.persistMetadata(metadata);
			workerUrl = `https://${metadata.workerName}.${subdomain}.workers.dev`;
		} else {
			const deploymentArtifacts = artifacts ?? await this.whileActive(this.options.loadArtifacts);
			workerUrl = await this.whileActive(() => provisionCloudflareDeployment({
				api,
				accountId: account.id,
				metadata,
				artifacts: deploymentArtifacts,
				onMetadataChanged: () => this.persistMetadata(metadata),
				onProgress,
			}));
		}
		if (device) {
			onProgress?.('Registering this device with the server…');
			if (!metadata.d1DatabaseId) throw new Error('Cloudflare deployment database is missing');
			const databaseId = metadata.d1DatabaseId;
			await this.whileActive(() => registerCloudflareAuthorizedDevice({
				api,
				accountId: account.id,
				databaseId,
				device,
			}));
		}
		if (metadata.reset) {
			delete metadata.reset;
			await this.persistMetadata(metadata);
		}
		return { status: 'deployed', workerUrl, accountName: account.name };
	}

	private async revokeTokens(tokens: CloudflareOAuthTokens): Promise<void> {
		try {
			await Promise.all([
				this.oauthClient.revokeAccessToken(tokens.accessToken),
				...(tokens.refreshToken ? [this.oauthClient.revokeAccessToken(tokens.refreshToken)] : []),
			]);
		} catch {
			// Failed operations discard credentials even if revocation is unavailable.
		}
	}

	async deployWithSavedAuthorization(
		intent: SavedDeploymentIntent,
		withAuthorization: WithCloudflareAuthorization,
		device?: CloudflareAuthorizedDevice,
		onProgress?: (message: string) => void,
		selectDeployment = this.options.selectDeployment,
	): Promise<CloudflareDeploymentResult> {
		this.assertIdle('A Cloudflare operation is already in progress.');
		const metadata = this.options.settingsOwner.settings.cloudflareDeployment;
		if (!metadata?.accountId) throw new Error('Connect a Cloudflare server first.');
		this.checkSavedTarget(metadata, intent);
		if ((intent === 'reset' || intent === 'delete') && !metadata.d1DatabaseId) throw new Error('Connect a Cloudflare server first.');
		const request: DeploymentRequest = {
			metadata: structuredClone(metadata), intent, discoverExisting: false,
			originalMetadata: stableJson(metadata),
		};
		return this.exclusive(async () => {
			const result = await withAuthorization(async tokens => {
				this.lifetime.signal.throwIfAborted();
				this.checkSavedTarget(request.metadata, request.intent);
				if (stableJson(this.options.settingsOwner.settings.cloudflareDeployment) !== request.originalMetadata) throw new Error('Server settings changed. Confirm the operation again.');
				return this.runAuthorizedDeployment(request, tokens, device, onProgress, selectDeployment, true);
			});
			if (result.status === 'deleted') await this.whileActive(() => this.options.settingsOwner.writeSettings({ cloudflareDeployment: null }));
			return result;
		});
	}

    private async restoreBackups<T>(withAuthorization: WithCloudflareAuthorization,
        operation: (api: CloudflareApiClient, source: CloudflareDeploymentMetadata) => Promise<T>): Promise<T> {
        this.assertIdle();
        const source = structuredClone(this.options.settingsOwner.settings.cloudflareDeployment);
        if (!source?.accountId || !source.d1DatabaseId || source.reset || source.deletion) throw new Error('Select the source Cloudflare server and finish any deletion first.');
        return this.exclusive(() => withAuthorization(tokens => operation(this.createGuardedApi(tokens, 'saved', () => this.checkSavedTarget(source, 'update')), source)));
    }

    async listRestoreBackups(withAuthorization: WithCloudflareAuthorization): Promise<BackupChoice[]> {
        return this.restoreBackups(withAuthorization, async (api, source) => {
            const { listUpgradeBackups } = await import('../restore/server-restore');
            return listUpgradeBackups(api, { account: source.accountId!, database: source.d1DatabaseId!, bucket: source.r2BucketName });
        });
    }

    async restoreBackup(withAuthorization: WithCloudflareAuthorization,
        choice: BackupChoice | null, onProgress: (message: string) => void): Promise<string> {
        return this.restoreBackups(withAuthorization, async (api, source) => {
            const artifacts = await this.whileActive(this.options.loadArtifacts);
            return runRestoreWorkflow({
                api, source, artifacts, choice, now: this.now, onProgress,
                saved: this.options.settingsOwner.settings.cloudflareRestore,
                persist: state => this.whileActive(() => {
                    this.checkSavedTarget(source, 'update');
                    return this.options.settingsOwner.writeSettings({ cloudflareRestore: structuredClone(state) });
                }),
            });
        });
    }

    async recoverUpdate(withAuthorization: WithCloudflareAuthorization): Promise<DeploymentRecoveryResult> {
        this.assertIdle();
        const metadata = structuredClone(this.options.settingsOwner.settings.cloudflareDeployment);
        if (!metadata?.accountId) throw new Error('Connect to your Cloudflare account first.');
        this.checkSavedTarget(metadata, 'update');
        return this.exclusive(() => withAuthorization(async tokens => {
            const api = this.createGuardedApi(tokens, 'saved', () => this.checkSavedTarget(metadata, 'update'));
            const artifacts = await this.whileActive(this.options.loadArtifacts);
            return resumeInterruptedUpdate({
                api, metadata, artifacts,
                whileActive: operation => this.whileActive(operation),
                persist: () => this.persistMetadata(metadata),
            });
        }));
    }

	private createGuardedApi(tokens: CloudflareOAuthTokens, authorization: 'saved' | 'temporary', checkTarget?: () => void): CloudflareApiClient {
		if (authorization === 'saved' && tokens.scope !== undefined) {
			const scopes = tokens.scope.split(/\s+/);
			if (CLOUDFLARE_OAUTH_SCOPES.some(scope => !scopes.includes(scope))) throw new CloudflareReauthorizationRequired();
		}
		// Obsidian cannot cancel dispatched requests. Guard both sides so a late
		// response cannot start more work. OAuth is separate so it can be revoked.
		return new CloudflareApiClient(tokens.accessToken, (url, request) => this.whileActive(async () => {
			checkTarget?.();
			const response = await this.options.transport(url, request);
			this.lifetime.signal.throwIfAborted();
			checkTarget?.();
			if (authorization === 'saved' && new URL(url).origin === 'https://api.cloudflare.com'
				&& (response.status === 401 || response.status === 403)) throw new CloudflareReauthorizationRequired();
			return response;
		}));
	}

	private checkSavedTarget(expected: CloudflareDeploymentMetadata, intent: DeploymentIntent): void {
		const current = this.options.settingsOwner.settings.cloudflareDeployment;
		if (current?.deletion && intent !== 'delete') throw new Error('Resume server deletion before continuing.');
		if (current?.reset && intent !== 'delete' && intent !== (current.reset.deleteOnly ? 'delete' : 'reset')) throw new Error('Resume the server reset or deletion before continuing.');
		if (!current || current.accountId !== expected.accountId || current.workerName !== expected.workerName
			|| current.d1DatabaseId !== expected.d1DatabaseId || current.r2BucketName !== expected.r2BucketName
			|| expected.deletion && current.deletion?.id !== expected.deletion.id) {
			throw new Error('Server settings changed. Start the update again.');
		}
	}

	cancelPendingDeployment(): void {
		if (this.handlingCallback) throw new Error('Wait for the current Cloudflare operation to finish.');
		this.oauthSession.cancel();
	}

	destroy(): void {
		this.lifetime.abort();
		this.oauthSession.cancel();
	}

	private assertIdle(message = 'Wait for the current Cloudflare operation to finish.'): void {
		this.lifetime.signal.throwIfAborted();
		if (this.handlingCallback) throw new Error(message);
	}

	/** Run one saved-authorization operation at a time; it replaces any pending browser authorization. */
	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		this.cancelPendingDeployment();
		this.handlingCallback = true;
		try { return await operation(); } finally { this.handlingCallback = false; }
	}

	private async whileActive<T>(operation: () => Promise<T>): Promise<T> {
		this.lifetime.signal.throwIfAborted();
		const result = await operation();
		this.lifetime.signal.throwIfAborted();
		return result;
	}

	private async persistMetadata(metadata: CloudflareDeploymentMetadata): Promise<void> {
		await this.whileActive(() => this.options.settingsOwner.writeSettings({
			cloudflareDeployment: { ...metadata },
		}));
	}
}
