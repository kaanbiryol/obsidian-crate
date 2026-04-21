import { Notice, Setting } from 'obsidian';
import {
	listAccessibleAccounts,
	verifyToken,
	buildCloudflareTokenTemplateUrl,
} from '../../cloudflare/api';
import { quickSetup } from '../../cloudflare/infrastructure';
import type CratePlugin from '../../main';
import { getCurrentDeviceName, getCurrentPlatformCode } from '../../plugin/deviceInfo';
import { SECRET_KEYS } from '../../plugin/types';
import { SyncApiClient } from '../../sync/api';
import { applySharedSettings } from '../../sync/shared-settings';
import { getErrorMessage, runButtonTask } from './action-helpers';
import type { CloudflareCredentials, SetupWizardState } from './config-types';

export function seedWizardState(plugin: CratePlugin, wizardState: SetupWizardState): void {
	if (!wizardState.wizardToken) {
		wizardState.wizardToken = (plugin.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
	}
}

export async function resolveCredentialsForSetup(
	plugin: CratePlugin,
	wizardState: SetupWizardState
): Promise<CloudflareCredentials> {
	if (wizardState.wizardTokenValidated && wizardState.wizardSelectedAccountId) {
		const apiToken = wizardState.wizardToken.trim();
		const accountId = wizardState.wizardSelectedAccountId.trim();
		if (!apiToken || !accountId) {
			throw new Error('Complete the token setup first');
		}
		await plugin.cloudflareSession.saveCredentials(accountId, apiToken);
		return { accountId, apiToken };
	}

	const creds = await plugin.cloudflareSession.resolveCredentials();
	if (!creds) {
		throw new Error('Please complete the token setup first');
	}

	return creds;
}

export async function createInfrastructureFromCredentials(
	plugin: CratePlugin,
	creds: CloudflareCredentials,
	onProgress: (message: string) => void
): Promise<void> {
	const result = await quickSetup(
		{
			accountId: creds.accountId,
			apiToken: creds.apiToken,
			deviceId: plugin.settings.deviceId,
			deviceName: getCurrentDeviceName(plugin.settings.deviceId),
			platform: getCurrentPlatformCode(),
		},
		onProgress
	);

	try {
		const tempClient = new SyncApiClient(result.workerUrl, result.authToken);
		const { settings: shared } = await tempClient.getSharedSettings();
		if (shared) {
			applySharedSettings(plugin.settings, shared);
		}
	} catch {
		// Best effort: setup remains valid even if shared settings cannot be fetched.
	}

	plugin.clearSettingsUiState();
	await plugin.syncRuntime.applyInfrastructureConfig({
		workerUrl: result.workerUrl,
		authToken: result.authToken,
		workerName: result.workerName,
		bucketName: result.bucketName,
		databaseId: result.databaseId,
		accountId: creds.accountId,
	});

	plugin.syncRuntime.pushSharedSettings().catch(() => {});
}

export function renderApiTokenSetup(
	containerEl: HTMLElement,
	plugin: CratePlugin,
	wizardState: SetupWizardState,
	rerender: () => void
): void {
	new Setting(containerEl)
		.setName('Create a prefilled Cloudflare API token')
		.setDesc('Open a prefilled token template with the required worker, bucket, database, account settings, and analytics permissions')
		.addButton(button => button
			.setButtonText('Open Cloudflare')
			.onClick(() => {
				window.open(buildCloudflareTokenTemplateUrl(), '_blank', 'noopener,noreferrer');
			}));

	new Setting(containerEl)
		.setName('API token')
		.setDesc('Paste the API token you created from the prefilled Cloudflare form')
		.addText(text => {
			text.inputEl.type = 'password';
			text
				.setPlaceholder('Paste API token')
				.setValue(wizardState.wizardToken)
				.onChange(value => {
					wizardState.wizardToken = value.trim();
					if (wizardState.wizardTokenValidated) {
						wizardState.wizardTokenValidated = false;
						wizardState.wizardSelectedAccountId = '';
					}
				});
			text.inputEl.size = 36;
		})
		.addButton(button => button
			.setButtonText('Validate')
			.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Validate',
					runningText: 'Validating...',
					task: async () => {
						const token = wizardState.wizardToken.trim();
						if (!token) {
							throw new Error('Enter an API token first');
						}
						const valid = await verifyToken(token);
						if (!valid) {
							throw new Error('Token is invalid or does not have sufficient permissions');
						}
						const accounts = await listAccessibleAccounts(token);
						if (accounts.length === 0) {
							throw new Error('No Cloudflare accounts accessible with this token');
						}
						wizardState.wizardTokenValidated = true;
						wizardState.wizardSelectedAccountId = accounts[0].id;
					},
					onSuccess: () => {
						new Notice('Token validated');
						rerender();
					},
					onError: (error) => {
						new Notice(`Validation failed: ${getErrorMessage(error)}`);
					},
				});
			}));
}
