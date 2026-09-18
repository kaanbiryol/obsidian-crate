import type { CloudflareDeploymentMetadata } from './deployment-types';
import type { CloudflareWorkerSettings } from './cloudflare-api';

export const VAULT_NAME_BINDING = 'CRATE_VAULT_NAME';

export function normalizeVaultName(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	return value.replace(/\p{Cc}/gu, ' ').trim().slice(0, 160) || undefined;
}

export function readVaultName(settings: CloudflareWorkerSettings): string | undefined {
	return normalizeVaultName(settings.bindings?.find(binding => binding.type === 'plain_text' && binding.name === VAULT_NAME_BINDING)?.text);
}

export function vaultChoiceLabel(metadata: CloudflareDeploymentMetadata, choices: CloudflareDeploymentMetadata[]): string {
	const name = normalizeVaultName(metadata.vaultName);
	const ambiguous = !name || choices.filter(choice => normalizeVaultName(choice.vaultName) === name).length > 1;
	return `${name ?? 'Unnamed vault'}${ambiguous ? ` (${metadata.deploymentId.slice(-6)})` : ''}`;
}
