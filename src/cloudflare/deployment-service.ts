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
import { CloudflareOAuthClient } from './oauth-client';
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
	intent: 'connect' | 'update' | 'reset' | 'delete';
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
	) => Promise<DiscoveredCloudflareDeployment | null>;
	beforeServerReset?: () => Promise<void>;
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

	get pendingIntent(): PendingOAuthSession['intent'] | null {
		return this.pendingSession?.intent ?? null;
	}

	async startDeployment(intent: 'connect' | 'update' | 'reset' | 'delete' = 'connect'): Promise<void> {
		this.lifetime.signal.throwIfAborted();
		if (this.handlingCallback) throw new Error('Wait for the current Cloudflare operation to finish.');
		const existingMetadata = this.options.settingsOwner.settings.cloudflareDeployment;
		if (existingMetadata?.reset?.deleteOnly && intent !== 'delete') throw new Error('Resume server deletion before connecting or updating.');
		if (existingMetadata?.reset && !existingMetadata.reset.deleteOnly && intent === 'delete') throw new Error('Finish the server reset before deleting this server.');
		if (existingMetadata?.reset && intent !== 'reset' && intent !== 'delete') throw new Error('Resume the server reset before connecting or updating.');
		if ((intent === 'reset' || intent === 'delete') && (!existingMetadata?.accountId || !existingMetadata.d1DatabaseId)) {
			throw new Error('Connect to a Crate server before resetting its remote data.');
		}
		const metadata = existingMetadata
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
			discoverExisting: existingMetadata === null,
			intent,
		};

		const authorizationUrl = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
		authorizationUrl.search = new URLSearchParams({
			response_type: 'code',
			client_id: this.options.clientId,
			redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URL,
			scope: CLOUDFLARE_OAUTH_SCOPES.join(' '),
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		}).toString();
		this.options.openExternal(authorizationUrl.toString());
	}

	async handleCallback(params: Record<string, string>, device?: CloudflareAuthorizedDevice, onProgress?: (message: string) => void): Promise<CloudflareDeploymentResult> {
		this.lifetime.signal.throwIfAborted();
		if (this.handlingCallback) throw new Error('A Cloudflare operation is already in progress.');
		this.handlingCallback = true;
		try {
			return await this.whileActive(() => this.handleAuthorizedCallback(params, device, message => {
				this.lifetime.signal.throwIfAborted();
				onProgress?.(message);
			}));
		} finally {
			this.handlingCallback = false;
		}
	}

	private async handleAuthorizedCallback(
		params: Record<string, string>,
		device?: CloudflareAuthorizedDevice,
		onProgress?: (message: string) => void,
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
		const accessToken = await this.oauthClient.exchangeAuthorizationCode(params.code, pending.verifier);
		let result: CloudflareDeploymentResult;
		try {
			this.lifetime.signal.throwIfAborted();
			// Obsidian's transport cannot cancel a dispatched request. Guard both
			// sides so its late response cannot start another request or save settings.
			// OAuth stays outside this guard: even a late exchange must be revoked.
			const api = new CloudflareApiClient(accessToken, (url, request) =>
				this.whileActive(() => this.options.transport(url, request)));
			if (pending.intent !== 'reset' && pending.intent !== 'delete' && this.options.settingsOwner.settings.cloudflareDeployment?.reset) throw new Error('Resume the server reset before connecting or updating.');
			if ((pending.intent === 'reset' || pending.intent === 'delete') && JSON.stringify(pending.metadata) !== JSON.stringify(this.options.settingsOwner.settings.cloudflareDeployment)) {
				throw new Error('Server settings changed during authorization. Confirm the reset again.');
			}
			let metadata = pending.metadata;
			let discoveredExisting = false;
			onProgress?.('Checking your Cloudflare account…');
			const account = selectAccount(await this.whileActive(() => api.listAuthorizedAccounts()), metadata);
			if (pending.discoverExisting) {
				const deployments = await this.whileActive(() => discoverCloudflareDeployments(api, account));
				const [onlyDeployment] = deployments;
				if (deployments.length === 1 && onlyDeployment) {
					metadata = onlyDeployment.metadata;
					discoveredExisting = true;
				} else if (deployments.length > 1) {
					const selected = await this.whileActive(() => this.options.selectDeployment(deployments));
					if (!selected) throw new Error('No Cloudflare server was selected');
					metadata = selected.metadata;
					discoveredExisting = true;
				}
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
				await this.whileActive(() => this.options.settingsOwner.writeSettings({ cloudflareDeployment: null }));
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
			if (pending.intent === 'connect' && metadata.d1DatabaseId && (discoveredExisting || metadata.lastDeployedVersion)) {
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
		} finally {
			try {
				await this.oauthClient.revokeAccessToken(accessToken);
			} catch {
				// The token remains only in this stack frame and is discarded regardless.
			}
		}

		return result;
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
