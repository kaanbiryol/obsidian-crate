import { recoverDeployment, type DeploymentRecoveryResult } from './deployment-recovery';
import { deleteCrateServer } from './server-delete';
import { resetCrateServer } from './server-reset';
import type { CrateSettings } from '../plugin/settings';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { CloudflareApiClient, type CloudflareAccount } from './cloudflare-api';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import type { HttpTransport } from './http';
import {
	CLOUDFLARE_OAUTH_AUTHORIZE_URL,
	CLOUDFLARE_OAUTH_REDIRECT_URL,
	CLOUDFLARE_OAUTH_SCOPES,
} from './oauth-config';
import { CloudflareOAuthClient, CloudflareReauthorizationRequired, type CloudflareOAuthTokens } from './oauth-client';
import { constantTimeEqual, createPkcePair, randomBase64Url, randomHex } from './pkce';
import { provisionCloudflareDeployment } from './provisioner';
import {
	discoverCloudflareDeployments,
	type DiscoveredCloudflareDeployment,
} from './deployment-discovery';
import {
	registerCloudflareAuthorizedDevice,
	type CloudflareAuthorizedDevice,
} from './device-registration';

const OAUTH_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

interface DeploymentSettingsOwner {
	settings: CrateSettings;
	writeSettings(update: Partial<CrateSettings>): Promise<void>;
}

interface PendingOAuthSession {
	state: string;
	verifier: string;
	createdAt: number;
	metadata: CloudflareDeploymentMetadata;
	discoverExisting: boolean;
	originalMetadata: string;
	intent: 'connect' | 'switch' | 'create' | 'update' | 'reset' | 'delete';
}

export interface CloudflareDeploymentResult {
	deleted?: true;
	workerUrl: string;
	accountName: string;
}

export interface CloudflareDeploymentServiceOptions {
	clientId: string;
	settingsOwner: DeploymentSettingsOwner;
	transport: HttpTransport;
	loadArtifacts: () => Promise<CloudflareDeploymentArtifacts>;
	openExternal: (url: string) => void;
	selectDeployment: (
		deployments: DiscoveredCloudflareDeployment[],
		missingServer?: boolean,
	) => Promise<DiscoveredCloudflareDeployment | 'create' | null>;
	onAuthorized?: (accountId: string, tokens: CloudflareOAuthTokens) => void;
	beforeServerReset?: () => Promise<void>;
	beforeServerSwitch?: () => Promise<void>;
	now?: () => number;
}

function createCloudflareDeploymentMetadata(): CloudflareDeploymentMetadata {
	const deploymentId = randomHex(8);
	const resourceName = `crate-${deploymentId}`;
	return {
		deploymentId,
		accountId: null,
		accountName: null,
		workerName: resourceName,
		d1DatabaseName: resourceName,
		d1DatabaseId: null,
		r2BucketName: resourceName,
		workersSubdomain: null,
		lastDeployedVersion: null,
		lastDeployedFingerprint: null,
	};
}

function selectAccount(
	accounts: CloudflareAccount[],
	metadata: CloudflareDeploymentMetadata,
): CloudflareAccount {
	if (metadata.accountId) {
		const previousAccount = accounts.find(account => account.id === metadata.accountId);
		if (previousAccount) return previousAccount;
		throw new Error(`Authorize the Cloudflare account previously used by this vault${
			metadata.accountName ? ` (${metadata.accountName})` : ''
		}`);
	}
	const [onlyAccount] = accounts;
	if (accounts.length === 1 && onlyAccount) return onlyAccount;
	if (accounts.length === 0) {
		throw new Error('Cloudflare did not grant access to an account');
	}
	throw new Error('Select exactly one Cloudflare account when authorizing Crate, then try again');
}

export class CloudflareDeploymentService {
	private readonly oauthClient: CloudflareOAuthClient;
	private readonly now: () => number;
	private readonly lifetime = new AbortController();
	private pendingSession: PendingOAuthSession | null = null;
	private handlingCallback = false;

	constructor(private readonly options: CloudflareDeploymentServiceOptions) {
		this.oauthClient = new CloudflareOAuthClient(options.clientId, options.transport);
		this.now = options.now ?? Date.now;
	}

	get isBusy(): boolean { return this.handlingCallback; }

	get pendingIntent(): PendingOAuthSession['intent'] | null {
		return this.pendingSession?.intent ?? null;
	}

	async startDeployment(intent: 'connect' | 'switch' | 'create' | 'update' | 'reset' | 'delete' = 'connect'): Promise<void> {
		this.lifetime.signal.throwIfAborted();
		if (this.handlingCallback) throw new Error('Wait for the current Cloudflare operation to finish.');
		const existingMetadata = this.options.settingsOwner.settings.cloudflareDeployment;
		if (existingMetadata?.reset?.deleteOnly && intent !== 'delete') throw new Error('Resume server deletion before connecting or updating.');
		if (existingMetadata?.reset && !existingMetadata.reset.deleteOnly && intent === 'delete') throw new Error('Finish the server reset before deleting this server.');
		if (existingMetadata?.reset && intent !== 'reset' && intent !== 'delete') throw new Error('Resume the server reset before connecting or updating.');
		if ((intent === 'reset' || intent === 'delete') && (!existingMetadata?.accountId || !existingMetadata.d1DatabaseId)) {
			throw new Error('Connect to a Crate server before resetting its remote data.');
		}
		const metadata = existingMetadata && intent !== 'switch' && intent !== 'create'
			? { ...existingMetadata }
			: createCloudflareDeploymentMetadata();

		const { verifier, challenge } = await createPkcePair();
		this.lifetime.signal.throwIfAborted();
		const state = randomBase64Url(32);
		this.pendingSession = {
			verifier,
			state,
			createdAt: this.now(),
			metadata,
			originalMetadata: JSON.stringify(existingMetadata),
			discoverExisting: intent === 'switch' || (intent === 'connect' && (!existingMetadata || Boolean(existingMetadata.lastDeployedVersion))),
			intent,
		};

		const authorizationUrl = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
		authorizationUrl.search = new URLSearchParams({
			response_type: 'code',
			client_id: this.options.clientId,
			redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URL,
			scope: [...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' '),
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		}).toString();
		this.options.openExternal(authorizationUrl.toString());
	}

	async handleCallback(params: Record<string, string>, device?: CloudflareAuthorizedDevice, onProgress?: (message: string) => void, selectDeployment = this.options.selectDeployment): Promise<CloudflareDeploymentResult> {
		this.lifetime.signal.throwIfAborted();
		if (this.handlingCallback) throw new Error('A Cloudflare operation is already in progress.');
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
		const pending = this.pendingSession;
		if (!pending) {
			throw new Error('No Cloudflare deployment is waiting for authorization. Start again from Crate settings');
		}
		if (!params.state || !constantTimeEqual(params.state, pending.state)) {
			throw new Error('Cloudflare authorization state did not match. Start the deployment again');
		}
		if (this.now() - pending.createdAt > OAUTH_SESSION_MAX_AGE_MS) {
			this.pendingSession = null;
			throw new Error('Cloudflare authorization expired. Start the deployment again');
		}
		this.pendingSession = null;

		if (params.error) {
			throw new Error('Cloudflare authorization was cancelled or denied');
		}
		if (!params.code) {
			throw new Error('Cloudflare did not return an authorization code');
		}

		onProgress?.('Completing Cloudflare authorization…');
		this.lifetime.signal.throwIfAborted();
		const tokens = await this.oauthClient.exchangeTokens(params.code, pending.verifier);
		return this.runAuthorizedDeployment(pending, tokens, device, onProgress, selectDeployment);
	}

	private async runAuthorizedDeployment(
		pending: PendingOAuthSession,
		tokens: CloudflareOAuthTokens,
		device?: CloudflareAuthorizedDevice,
		onProgress?: (message: string) => void,
		selectDeployment = this.options.selectDeployment,
		savedLogin = false,
	): Promise<CloudflareDeploymentResult> {
		const accessToken = tokens.accessToken;
		let retained = savedLogin;
		let result: CloudflareDeploymentResult;
		try {
			this.lifetime.signal.throwIfAborted();
			// Obsidian's transport cannot cancel a dispatched request. Guard both
			// sides so its late response cannot start another request or save settings.
			// OAuth stays outside this guard: even a late exchange must be revoked.
			const api = new CloudflareApiClient(accessToken, (url, request) =>
				this.whileActive(async () => {
					if (savedLogin) this.checkSavedTarget(pending.metadata, pending.intent);
					const response = await this.options.transport(url, request);
					if (savedLogin) this.checkSavedTarget(pending.metadata, pending.intent);
					if (savedLogin && (response.status === 401 || response.status === 403)) throw new CloudflareReauthorizationRequired();
					return response;
				}));
			if (pending.intent !== 'reset' && pending.intent !== 'delete' && this.options.settingsOwner.settings.cloudflareDeployment?.reset) throw new Error('Resume the server reset before connecting or updating.');
			if ((pending.intent === 'reset' || pending.intent === 'delete') && JSON.stringify(pending.metadata) !== JSON.stringify(this.options.settingsOwner.settings.cloudflareDeployment)) {
				throw new Error('Server settings changed during authorization. Confirm the reset again.');
			}
			if ((pending.intent === 'switch' || pending.intent === 'create') && pending.originalMetadata !== JSON.stringify(this.options.settingsOwner.settings.cloudflareDeployment)) throw new Error('Server settings changed during authorization. Start again.');
			let metadata = pending.metadata;
			let discoveredExisting = false;
			onProgress?.('Checking your Cloudflare account…');
			const account = selectAccount(await this.whileActive(() => api.listAuthorizedAccounts()), metadata);
			if (pending.discoverExisting) {
				onProgress?.('Finding your Crate servers…');
				const remembered = pending.intent === 'connect' && Boolean(metadata.d1DatabaseId);
				const workers = remembered ? await this.whileActive(() => api.listWorkers(account.id)) : null;
				const missingServer = Boolean(workers && !workers.some(worker => worker.id === metadata.workerName));
				const deployments = await this.whileActive(() => discoverCloudflareDeployments(api, account));
				const selected = !missingServer && pending.intent === 'connect' && deployments.length === 1
					? deployments[0]!
					: await this.whileActive(() => selectDeployment(deployments, missingServer));
				if (!selected) throw new Error('No Cloudflare server was selected');
				if (selected === 'create') {
					metadata = createCloudflareDeploymentMetadata();
				} else {
					metadata = selected.metadata;
					discoveredExisting = true;
				}
			}
			if (savedLogin) this.checkSavedTarget(pending.metadata, pending.intent);
			onProgress?.('Preparing the selected server…');
			const previous = this.options.settingsOwner.settings.cloudflareDeployment;
			const changingServer = previous && (previous.accountId !== account.id || previous.workerName !== metadata.workerName);
			if (changingServer || pending.intent === 'switch' || pending.intent === 'create') {
				if (!this.options.beforeServerSwitch) throw new Error('Switching servers requires sync shutdown.');
				await this.whileActive(this.options.beforeServerSwitch);
			}
			metadata.accountId = account.id;
			metadata.accountName = account.name;
			await this.persistMetadata(metadata);

			if (pending.intent === 'delete') {
				if (!this.options.beforeServerReset) throw new Error('Deletion requires sync shutdown.');
				const artifacts = await this.whileActive(this.options.loadArtifacts);
				await this.whileActive(() => deleteCrateServer({
					api, accountId: account.id, metadata, version: artifacts.version,
					beforeDelete: () => this.whileActive(this.options.beforeServerReset!), onProgress,
					persist: () => this.persistMetadata(metadata),
				}));
				if (!savedLogin) await this.whileActive(() => this.options.settingsOwner.writeSettings({ cloudflareDeployment: null }));
				return { workerUrl: '', accountName: account.name, deleted: true };
			}
			const artifacts = pending.intent === 'reset' ? await this.whileActive(this.options.loadArtifacts) : null;
			if (pending.intent === 'reset') {
				if (!device || !artifacts || !this.options.beforeServerReset) throw new Error('Reset requires a new device credential and sync shutdown.');
				await this.whileActive(() => resetCrateServer({
					api, accountId: account.id, metadata, version: artifacts.version,
					beforeDelete: () => this.whileActive(this.options.beforeServerReset!), onProgress,
					persist: () => this.persistMetadata(metadata),
				}));
			}
			let workerUrl: string;
			if ((pending.intent === 'connect' || pending.intent === 'switch') && metadata.d1DatabaseId && (discoveredExisting || metadata.lastDeployedVersion)) {
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
			result = { workerUrl, accountName: account.name };
			this.lifetime.signal.throwIfAborted();
			if (!savedLogin && this.options.onAuthorized) {
				this.options.onAuthorized(account.id, tokens);
				retained = true;
			}
		} finally {
			try {
				if (!retained) await Promise.all([
					this.oauthClient.revokeAccessToken(accessToken),
					...(tokens.refreshToken ? [this.oauthClient.revokeAccessToken(tokens.refreshToken)] : []),
				]);
			} catch {
				// Failed operations discard credentials even if revocation is unavailable.
			}
		}

		return result;
	}

	async deployWithSavedAuthorization(
		intent: 'connect' | 'update' | 'reset' | 'delete',
		withAuthorization: <T>(operation: (tokens: CloudflareOAuthTokens) => Promise<T>) => Promise<T>,
		device?: CloudflareAuthorizedDevice,
		onProgress?: (message: string) => void,
		selectDeployment = this.options.selectDeployment,
	): Promise<CloudflareDeploymentResult> {
		this.lifetime.signal.throwIfAborted();
		if (this.handlingCallback) throw new Error('A Cloudflare operation is already in progress.');
		const metadata = this.options.settingsOwner.settings.cloudflareDeployment;
		if (!metadata?.accountId) throw new Error('Connect a Cloudflare server first.');
		this.checkSavedTarget(metadata, intent);
		if ((intent === 'reset' || intent === 'delete') && !metadata.d1DatabaseId) throw new Error('Connect a Cloudflare server first.');
		this.pendingSession = null;
		this.handlingCallback = true;
		const pending: PendingOAuthSession = {
			metadata: structuredClone(metadata), intent, discoverExisting: false,
			originalMetadata: JSON.stringify(metadata), state: '', verifier: '', createdAt: this.now(),
		};
		try {
			const result = await withAuthorization(async tokens => {
				this.lifetime.signal.throwIfAborted();
				this.checkSavedTarget(pending.metadata, pending.intent);
				if (JSON.stringify(this.options.settingsOwner.settings.cloudflareDeployment) !== pending.originalMetadata) throw new Error('Server settings changed. Confirm the operation again.');
				if (tokens.scope !== undefined && CLOUDFLARE_OAUTH_SCOPES.some(scope => !tokens.scope!.split(/\s+/).includes(scope))) {
					throw new CloudflareReauthorizationRequired();
				}
				return this.runAuthorizedDeployment(pending, tokens, device, onProgress, selectDeployment, true);
			});
			if (result.deleted) await this.whileActive(() => this.options.settingsOwner.writeSettings({ cloudflareDeployment: null }));
			return result;
		} finally { this.handlingCallback = false; }
	}

    async recoverUpdate(withAuthorization: <T>(operation: (tokens: CloudflareOAuthTokens) => Promise<T>) => Promise<T>): Promise<DeploymentRecoveryResult> {
        this.lifetime.signal.throwIfAborted();
        if (this.handlingCallback) throw new Error('Wait for the current Cloudflare operation to finish.');
        const metadata = structuredClone(this.options.settingsOwner.settings.cloudflareDeployment);
        if (!metadata?.accountId) throw new Error('Connect to your Cloudflare account first.');
        this.checkSavedTarget(metadata, 'update');
        this.handlingCallback = true;
        try {
            return await withAuthorization(async tokens => {
                const api = new CloudflareApiClient(tokens.accessToken, async (url, request) => {
                    this.lifetime.signal.throwIfAborted();
                    this.checkSavedTarget(metadata, 'update');
                    const response = await this.options.transport(url, request);
                    this.lifetime.signal.throwIfAborted();
                    this.checkSavedTarget(metadata, 'update');
                    return response;
                });
                const artifacts = await this.whileActive(this.options.loadArtifacts);
                const recovery = await recoverDeployment(api, metadata, artifacts.fingerprint);
                if (recovery.status !== 'resume' || !recovery.resumeValue) return recovery;
                await this.whileActive(() => provisionCloudflareDeployment({
                    api, accountId: metadata.accountId!, metadata, artifacts,
                    resumeUpdateValue: recovery.resumeValue,
                    onMetadataChanged: () => this.persistMetadata(metadata),
                }));
                return { status: 'completed', message: 'The interrupted server update was completed and verified.', diagnostics: recovery.diagnostics };
            });
        } finally { this.handlingCallback = false; }
    }

	private checkSavedTarget(expected: CloudflareDeploymentMetadata, intent: PendingOAuthSession['intent']): void {
		const current = this.options.settingsOwner.settings.cloudflareDeployment;
		if (current?.reset && intent !== (current.reset.deleteOnly ? 'delete' : 'reset')) throw new Error('Resume the server reset or deletion before continuing.');
		if (!current || current.accountId !== expected.accountId || current.workerName !== expected.workerName
			|| current.d1DatabaseId !== expected.d1DatabaseId || current.r2BucketName !== expected.r2BucketName) {
			throw new Error('Server settings changed. Start the update again.');
		}
	}

	cancelPendingDeployment(): void {
		if (this.handlingCallback) throw new Error('Wait for the current Cloudflare operation to finish.');
		this.pendingSession = null;
	}

	destroy(): void {
		this.lifetime.abort();
		this.pendingSession = null;
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
