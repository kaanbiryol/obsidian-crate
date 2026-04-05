import { Notice, requestUrl, Setting } from 'obsidian';
import {
	buildCloudflareTokenTemplateUrl,
	generateAuthToken,
	listAccessibleAccounts,
	verifyToken,
} from '../../cloudflare/api';
import { computeTokenHash, quickSetup } from '../../cloudflare/infrastructure';
import type CratePlugin from '../../main';
import { SECRET_KEYS } from '../../plugin/types';
import { SyncApiClient } from '../../sync/api';
import { applySharedSettings } from '../../sync/shared-settings';
import { openConfirmationModal } from '../confirmation-modal';
import { QRModal } from '../qr-modal';
import { getErrorMessage, runButtonTask } from './action-helpers';
import { createSettingsSectionHeading } from './section-helpers';

interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export interface SetupWizardState {
	wizardToken: string;
	wizardTokenValidated: boolean;
	wizardSelectedAccountId: string;
}

export interface ConfigSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	wizardState: SetupWizardState;
	rerender: () => void;
}

export function renderConfigSection(context: ConfigSectionContext): void {
	const { containerEl, plugin, wizardState, rerender } = context;
	seedWizardState(plugin, wizardState);

	const hasCloudflareCredentials = plugin.cloudflareSession.hasCredentials();

	createSettingsSectionHeading(containerEl, 'Configuration');

	const setupProgress = containerEl.createEl('p', {
		cls: 'crate-action-progress',
	});
	setupProgress.hide();

	const isConfigured = plugin.syncRuntime.isConfigured();

	if (!hasCloudflareCredentials && !isConfigured) {
		new Setting(containerEl)
			.setName('Create a Cloudflare API token')
			.setDesc('Create a token with edit access to workers, R2 storage, and D1, plus read access to account settings and account analytics')
			.addButton(button => button
				.setButtonText('Open Cloudflare')
				.onClick(() => {
					window.open(buildCloudflareTokenTemplateUrl(), '_blank', 'noopener,noreferrer');
				}));

		new Setting(containerEl)
			.setName('API token')
			.setDesc('Paste the API token you created on the Cloudflare dashboard')
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
				text.inputEl.size = 50;
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
	} else if (hasCloudflareCredentials) {
		new Setting(containerEl)
			.setName('Connected account')
			.setDesc(plugin.settings.cloudflareAccountId)
			.addExtraButton(button => button
				.setIcon('x')
				.setTooltip('Sign out')
				.onClick(async () => {
					await plugin.syncRuntime.clearSyncConfiguration({ clearCloudflareCredentials: true });
					new Notice('Signed out and configuration cleared');
					rerender();
				}));
	}

	const wizardReady = wizardState.wizardTokenValidated && !!wizardState.wizardSelectedAccountId;
	if (!isConfigured && (hasCloudflareCredentials || wizardReady)) {
		new Setting(containerEl)
			.setName('Quick setup')
			.setDesc('Set up sync infrastructure or reconnect to an existing one')
			.addButton(button => button
				.setButtonText('Set up')
				.setCta()
				.onClick(async () => {
					await runButtonTask({
						button,
						idleText: 'Set up',
						runningText: 'Working...',
						progressEl: setupProgress,
						progressMessage: 'Starting setup...',
						task: async ({ setProgress }) => {
							const creds = await resolveCredentialsForSetup(plugin, wizardState);
							await createInfrastructureFromCredentials(plugin, creds, setProgress);
						},
						onSuccess: () => {
							new Notice('Infrastructure created and plugin configured');
							rerender();
						},
						onError: (error) => {
							new Notice(`Setup failed: ${getErrorMessage(error)}`);
						},
					});
				}));
	}

	if (isConfigured) {
		new Setting(containerEl)
			.setName('Set up another device')
			.setDesc('Share a setup link for another device. The link contains sync credentials, so share it securely.')
			.addButton(button => button
				.setButtonText('Copy link')
				.onClick(async () => {
					const link = await buildSetupLink(plugin);
					if (!link) return;
					await navigator.clipboard.writeText(link);
					new Notice('Setup link copied to clipboard');
					}))
				.addButton(button => button
					.setButtonText('Show code')
					.onClick(async () => {
						const link = await buildSetupLink(plugin);
						if (!link) return;
						new QRModal(plugin.app, link).open();
					}));
	}

	if (hasCloudflareCredentials || isConfigured) {
		new Setting(containerEl)
			.setName('Reset local configuration')
			.setDesc('Clears worker URL/auth token and local infrastructure metadata')
			.addButton(button => button
				.setButtonText('Reset local data')
				.setWarning()
				.onClick(async () => {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Reset local configuration',
						message: 'Clear this device\'s Crate configuration?',
						details: ['Remote Cloudflare resources will not be deleted.'],
						confirmText: 'Reset local data',
						warning: true,
					});
					if (!confirmed) {
						return;
					}
					await plugin.syncRuntime.clearSyncConfiguration();
					new Notice('Local plugin configuration cleared');
					rerender();
				}));
	}
}

function seedWizardState(plugin: CratePlugin, wizardState: SetupWizardState): void {
	if (!wizardState.wizardToken) {
		wizardState.wizardToken = (plugin.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
	}
}

async function resolveCredentialsForSetup(
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

async function createInfrastructureFromCredentials(
	plugin: CratePlugin,
	creds: CloudflareCredentials,
	onProgress: (message: string) => void
): Promise<void> {
	const result = await quickSetup(
		{
			accountId: creds.accountId,
			apiToken: creds.apiToken,
		},
		onProgress
	);

	try {
		const tempClient = new SyncApiClient(result.workerUrl, result.authToken);
		const { settings: shared } = await tempClient.getSharedSettings();
		if (shared) {
			applySharedSettings(plugin.settings, shared);
		}
	} catch { /* best-effort */ }

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

async function buildSetupLink(plugin: CratePlugin): Promise<string | null> {
	const currentAuthToken = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
	if (!currentAuthToken) {
		new Notice('Auth token not found');
		return null;
	}

	const newToken = generateAuthToken();
	const tokenHash = await computeTokenHash(newToken);
	const workerUrl = plugin.settings.workerUrl.replace(/\/$/, '');

	try {
		await requestUrl({
			url: `${workerUrl}/auth/tokens`,
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${currentAuthToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ token_hash: tokenHash, device_name: 'setup-link' }),
		});
	} catch {
		new Notice('Failed to register token for new device');
		return null;
	}

	const params = new URLSearchParams();
	params.set('workerUrl', plugin.settings.workerUrl);
	params.set('authToken', newToken);
	if (plugin.settings.workerName) {
		params.set('workerName', plugin.settings.workerName);
	}
	if (plugin.settings.bucketName) {
		params.set('bucketName', plugin.settings.bucketName);
	}
	if (plugin.settings.databaseId) {
		params.set('databaseId', plugin.settings.databaseId);
	}
	if (plugin.settings.cloudflareAccountId) {
		params.set('accountId', plugin.settings.cloudflareAccountId);
	}
	params.set('ignorePatterns', JSON.stringify(plugin.settings.ignorePatterns));
	params.set('syncOnStartup', String(plugin.settings.syncOnStartup));
	params.set('syncInterval', String(plugin.settings.syncInterval));
	params.set('showStatusBar', String(plugin.settings.showStatusBar));
	params.set('pushEnabled', String(plugin.settings.pushEnabled));

	return `obsidian://crate-setup?${params.toString()}`;
}
