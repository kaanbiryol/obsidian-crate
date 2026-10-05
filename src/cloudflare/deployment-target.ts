import type { CloudflareApiClient, CloudflareAccount } from './cloudflare-api';
import { discoverCloudflareDeployments, type DiscoveredCloudflareDeployment } from './deployment-discovery';
import type { CloudflareDeploymentMetadata, DeploymentRequest } from './deployment-types';
import { normalizeVaultName } from './vault-name';
import { randomHex } from './pkce';

export type SelectDeployment = (deployments: DiscoveredCloudflareDeployment[], missingServer?: boolean)
	=> Promise<DiscoveredCloudflareDeployment | 'create' | null>;

export function createCloudflareDeploymentMetadata(vaultName?: string): CloudflareDeploymentMetadata {
	const deploymentId = randomHex(8);
	const resourceName = `crate-${deploymentId}`;
	return {
		deploymentId,
		...(normalizeVaultName(vaultName) ? { vaultName: normalizeVaultName(vaultName) } : {}),
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

/** Select a vault's server without coupling target discovery to an OAuth session. */
export async function resolveDeploymentTarget({ request, api, getVaultName, selectDeployment, onProgress, whileActive }: {
	request: DeploymentRequest;
	api: CloudflareApiClient;
	getVaultName?: () => string;
	selectDeployment: SelectDeployment;
	onProgress?: (message: string) => void;
	whileActive: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
	let metadata = request.metadata;
	let discoveredExisting = false;
	onProgress?.('Checking your Cloudflare account…');
	const account = selectAccount(await whileActive(() => api.listAuthorizedAccounts()), metadata);
	if (request.discoverExisting) {
		onProgress?.('Finding your Crate servers…');
		const remembered = request.intent === 'connect' && Boolean(metadata.d1DatabaseId);
		const workers = remembered ? await whileActive(() => api.listWorkers(account.id)) : null;
		const missingServer = Boolean(workers && !workers.some(worker => worker.id === metadata.workerName));
		const deployments = await whileActive(() => discoverCloudflareDeployments(api, account));
		// Account membership does not identify a vault. Only reuse this vault's saved server.
		const savedDeployment = remembered && !missingServer
			? deployments.find(deployment => deployment.metadata.workerName === metadata.workerName
				&& deployment.metadata.d1DatabaseId === metadata.d1DatabaseId
				&& deployment.metadata.r2BucketName === metadata.r2BucketName)
			: undefined;
		const selected = savedDeployment
			?? await whileActive(() => selectDeployment(deployments, missingServer));
		if (!selected) throw new Error('No Cloudflare server was selected');
		if (selected === 'create') {
			metadata = createCloudflareDeploymentMetadata(getVaultName?.());
		} else {
			metadata = selected.metadata;
			discoveredExisting = true;
		}
	}
	return { metadata, account, reuseExisting: Boolean(request.intent === 'reconnect' || (request.intent === 'connect' || request.intent === 'switch') && metadata.d1DatabaseId && (discoveredExisting || metadata.lastDeployedVersion)) };
}
