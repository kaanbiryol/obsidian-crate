import type { CrateSettings } from '../plugin/settings';
import type { CloudflareDeploymentMetadata } from '../plugin/types';
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

const OAUTH_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

interface DeploymentSettingsOwner {
	settings: CrateSettings;
	saveSettings(): Promise<void>;
}

interface PendingOAuthSession {
	state: string;
	verifier: string;
	createdAt: number;
}

export interface CloudflareDeploymentResult {
	workerUrl: string;
	accountName: string;
}

export interface CloudflareDeploymentServiceOptions {
	clientId: string;
	settingsOwner: DeploymentSettingsOwner;
	transport: HttpTransport;
	loadArtifacts: () => Promise<CloudflareDeploymentArtifacts>;
	openExternal: (url: string) => void;
	now?: () => number;
}

export function createCloudflareDeploymentMetadata(): CloudflareDeploymentMetadata {
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
	};
}

function selectAccount(
	accounts: CloudflareAccount[],
	metadata: CloudflareDeploymentMetadata,
): CloudflareAccount {
	const previousAccount = metadata.accountId
		? accounts.find(account => account.id === metadata.accountId)
		: null;
	if (previousAccount) return previousAccount;
	if (accounts.length === 1) return accounts[0];
	if (accounts.length === 0) {
		throw new Error('Cloudflare did not grant access to an account');
	}
	throw new Error('Select exactly one Cloudflare account when authorizing Crate, then try again');
}

export class CloudflareDeploymentService {
	private readonly oauthClient: CloudflareOAuthClient;
	private readonly now: () => number;
	private pendingSession: PendingOAuthSession | null = null;

	constructor(private readonly options: CloudflareDeploymentServiceOptions) {
		this.oauthClient = new CloudflareOAuthClient(options.clientId, options.transport);
		this.now = options.now ?? Date.now;
	}

	async startDeployment(): Promise<void> {
		let metadata = this.options.settingsOwner.settings.cloudflareDeployment;
		if (!metadata) {
			metadata = createCloudflareDeploymentMetadata();
			await this.persistMetadata(metadata);
		}

		const { verifier, challenge } = await createPkcePair();
		const state = randomBase64Url(32);
		this.pendingSession = { verifier, state, createdAt: this.now() };

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

	async handleCallback(params: Record<string, string>): Promise<CloudflareDeploymentResult> {
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

		const accessToken = await this.oauthClient.exchangeAuthorizationCode(params.code, pending.verifier);
		let result: CloudflareDeploymentResult;
		try {
			const api = new CloudflareApiClient(accessToken, this.options.transport);
			const metadata = this.options.settingsOwner.settings.cloudflareDeployment;
			if (!metadata) throw new Error('Cloudflare deployment metadata is missing');
			const account = selectAccount(await api.listAuthorizedAccounts(), metadata);
			metadata.accountId = account.id;
			metadata.accountName = account.name;
			await this.persistMetadata(metadata);

			const workerUrl = await provisionCloudflareDeployment({
				api,
				accountId: account.id,
				metadata,
				artifacts: await this.options.loadArtifacts(),
				onMetadataChanged: () => this.persistMetadata(metadata),
			});
			result = { workerUrl, accountName: account.name };
		} finally {
			try {
				await this.oauthClient.revokeAccessToken(accessToken);
			} catch {
				// The token remains only in this stack frame and is discarded regardless.
			}
		}

		this.options.openExternal(`${result.workerUrl}/`);
		return result;
	}

	destroy(): void {
		this.pendingSession = null;
	}

	private async persistMetadata(metadata: CloudflareDeploymentMetadata): Promise<void> {
		this.options.settingsOwner.settings.cloudflareDeployment = metadata;
		await this.options.settingsOwner.saveSettings();
	}
}
