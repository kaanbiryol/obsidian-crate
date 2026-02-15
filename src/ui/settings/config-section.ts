import { Notice, Setting } from 'obsidian';
import { verifyCredentials } from '../../cloudflare/api';
import { quickSetup } from '../../cloudflare/infrastructure';
import type CratePlugin from '../../main';
import { SECRET_KEYS } from '../../types';
import { getErrorMessage, runButtonTask } from './action-helpers';

interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export interface ManualSetupState {
	manualEntryEnabled: boolean;
	manualAccountId: string;
	manualApiToken: string;
	manualBucketName: string;
	manualWorkerName: string;
}

export interface ConfigSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	manualState: ManualSetupState;
	rerender: () => void;
}

export function renderConfigSection(context: ConfigSectionContext): void {
	const { containerEl, plugin, manualState, rerender } = context;
	seedManualState(plugin, manualState);

	const hasCloudflareCredentials = plugin.cloudflareSession.hasCredentials();
	if (hasCloudflareCredentials) {
		manualState.manualEntryEnabled = false;
	}

	containerEl.createEl('h3', { text: 'Configuration' });
	containerEl.createEl('p', {
		text: 'Sign in with Cloudflare to enable one-click setup and infrastructure management.',
		cls: 'setting-item-description',
	});

	const setupProgress = containerEl.createEl('p', {
		cls: 'setting-item-description crate-action-progress',
	});
	setupProgress.style.display = 'none';

	if (!hasCloudflareCredentials) {
		renderQuickSetupGuide(containerEl);

		new Setting(containerEl)
			.setName('Cloudflare sign in')
			.setDesc('Authorize directly in browser and auto-create infrastructure (desktop)')
			.addButton(button => button
				.setButtonText('Sign in with Cloudflare')
				.setCta()
				.onClick(async () => {
					let loggedIn = false;
					await runButtonTask({
						button,
						idleText: 'Sign in with Cloudflare',
						runningText: 'Waiting...',
						progressEl: setupProgress,
						progressMessage: 'Waiting for Cloudflare authorization...',
						task: async ({ setProgress }) => {
							await plugin.cloudflareSession.loginWithCloudflare();
							loggedIn = true;
							const creds = await plugin.cloudflareSession.resolveCredentials();
							if (!creds) {
								throw new Error('Cloudflare credentials are unavailable after login');
							}
							setProgress('Creating infrastructure...');
							await createInfrastructureFromCredentials(plugin, manualState, creds, setProgress);
						},
						onSuccess: () => {
							new Notice('Cloudflare login successful and infrastructure is ready');
							rerender();
						},
						onError: (error) => {
							const message = getErrorMessage(error);
							if (loggedIn) {
								new Notice(`Cloudflare login succeeded but setup failed: ${message}`);
							} else {
								new Notice(`Cloudflare login failed: ${message}`);
							}
						},
					});
				}));
	} else {
		new Setting(containerEl)
			.setName('Cloudflare account')
			.setDesc(plugin.settings.cloudflareAccountId)
			.addButton(button => button
				.setButtonText('Re-authenticate')
				.onClick(async () => {
					const shouldSetup = !plugin.syncRuntime.isConfigured();
					await runButtonTask({
						button,
						idleText: 'Re-authenticate',
						runningText: 'Waiting...',
						progressEl: shouldSetup ? setupProgress : undefined,
						task: async ({ setProgress }) => {
							await plugin.cloudflareSession.loginWithCloudflare();
							if (shouldSetup) {
								setProgress('Creating infrastructure...');
								const creds = await plugin.cloudflareSession.resolveCredentials();
								if (!creds) {
									throw new Error('Cloudflare credentials are unavailable after login');
								}
								await createInfrastructureFromCredentials(plugin, manualState, creds, setProgress);
							}
						},
						onSuccess: () => {
							if (shouldSetup) {
								new Notice('Cloudflare account updated and infrastructure is ready');
							} else {
								new Notice('Cloudflare account updated');
							}
							rerender();
						},
						onError: (error) => {
							new Notice(`Cloudflare login failed: ${getErrorMessage(error)}`);
						},
					});
				}))
			.addExtraButton(button => button
				.setIcon('x')
				.setTooltip('Sign out from Cloudflare')
				.onClick(async () => {
					await plugin.cloudflareSession.clearCredentials();
					new Notice('Cloudflare credentials cleared');
					rerender();
				}));
	}

	if (!hasCloudflareCredentials) {
		new Setting(containerEl)
			.setName('Manual entry')
			.setDesc('Show advanced fields for account, API token, bucket, and worker names')
			.addToggle(toggle => toggle
				.setValue(manualState.manualEntryEnabled)
				.onChange((value) => {
					manualState.manualEntryEnabled = value;
					rerender();
				}));

		if (manualState.manualEntryEnabled) {
			renderManualEntryFields(containerEl, plugin, manualState, rerender);
		}
	}

	if (!plugin.syncRuntime.isConfigured() && (hasCloudflareCredentials || manualState.manualEntryEnabled)) {
		new Setting(containerEl)
			.setName('Quick setup')
			.setDesc('Create R2 + D1 + Worker and configure this plugin automatically')
			.addButton(button => button
				.setButtonText('Create infrastructure')
				.setCta()
				.onClick(async () => {
					await runButtonTask({
						button,
						idleText: 'Create infrastructure',
						runningText: 'Working...',
						progressEl: setupProgress,
						progressMessage: 'Starting setup...',
						task: async ({ setProgress }) => {
							const creds = await resolveCredentialsForSetup(plugin, manualState);
							await createInfrastructureFromCredentials(plugin, manualState, creds, setProgress);
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

	if (hasCloudflareCredentials) {
		new Setting(containerEl)
			.setName('Reset local plugin configuration')
			.setDesc('Clears worker URL/auth token and local infrastructure metadata')
			.addButton(button => button
				.setButtonText('Reset local')
				.setWarning()
				.onClick(async () => {
					if (!confirm('Clear local plugin configuration? Cloudflare resources will not be deleted.')) {
						return;
					}
					await plugin.syncRuntime.clearSyncConfiguration();
					new Notice('Local plugin configuration cleared');
					rerender();
				}));
	}
}

function renderQuickSetupGuide(containerEl: HTMLElement): void {
	const quickGuide = containerEl.createDiv({ cls: 'crate-quick-guide' });
	quickGuide.createEl('h4', { text: 'Quick setup guide' });
	const quickGuideList = quickGuide.createEl('ol');
	quickGuideList.createEl('li', {
		text: 'Select Sign in with Cloudflare and approve access in your browser.',
	});
	quickGuideList.createEl('li', {
		text: 'Infrastructure setup runs automatically right after sign-in.',
	});
	quickGuideList.createEl('li', {
		text: 'If setup fails, use Create infrastructure. Then run Test connection and Sync now.',
	});
}

function renderManualEntryFields(
	containerEl: HTMLElement,
	plugin: CratePlugin,
	manualState: ManualSetupState,
	rerender: () => void
): void {
	new Setting(containerEl)
		.setName('Cloudflare account ID')
		.setDesc('Used for manual setup mode')
		.addText(text => {
			text
				.setPlaceholder('Cloudflare account ID')
				.setValue(manualState.manualAccountId)
				.onChange(value => {
					manualState.manualAccountId = value.trim();
				});
			text.inputEl.size = 50;
		});

	new Setting(containerEl)
		.setName('Cloudflare API token')
		.setDesc('Used for manual setup mode')
		.addText(text => {
			text.inputEl.type = 'password';
			text
				.setPlaceholder('Paste Cloudflare API token')
				.setValue(manualState.manualApiToken)
				.onChange(value => {
					manualState.manualApiToken = value.trim();
				});
			text.inputEl.size = 50;
		});

	new Setting(containerEl)
		.setName('R2 bucket name')
		.setDesc('Optional for setup. Leave empty to auto-generate')
		.addText(text => {
			text
				.setPlaceholder('crate-xxxxxxxx')
				.setValue(manualState.manualBucketName)
				.onChange(value => {
					manualState.manualBucketName = value.trim();
				});
			text.inputEl.size = 40;
		});

	new Setting(containerEl)
		.setName('Worker name')
		.setDesc('Optional for setup. Leave empty to auto-generate')
		.addText(text => {
			text
				.setPlaceholder('crate-sync-xxxxxx')
				.setValue(manualState.manualWorkerName)
				.onChange(value => {
					manualState.manualWorkerName = value.trim();
				});
			text.inputEl.size = 40;
		});

	new Setting(containerEl)
		.setName('Save manual credentials')
		.setDesc('Validate and save account ID and API token from manual entry fields')
		.addButton(button => button
			.setButtonText('Save')
			.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Save',
					runningText: 'Validating...',
					task: async () => {
						const accountId = manualState.manualAccountId.trim();
						const apiToken = manualState.manualApiToken.trim();
						if (!accountId || !apiToken) {
							throw new Error('Enter both Cloudflare account ID and API token');
						}

						const valid = await verifyCredentials({ accountId, apiToken });
						if (!valid) {
							throw new Error('Cloudflare credentials are invalid');
						}
						await plugin.cloudflareSession.saveCredentials(accountId, apiToken);
					},
					onSuccess: () => {
						new Notice('Manual Cloudflare credentials saved');
						rerender();
					},
					onError: (error) => {
						new Notice(`Failed to save manual credentials: ${getErrorMessage(error)}`);
					},
				});
			}));
}

function seedManualState(plugin: CratePlugin, manualState: ManualSetupState): void {
	if (!manualState.manualAccountId) {
		manualState.manualAccountId = plugin.settings.cloudflareAccountId.trim();
	}
	if (!manualState.manualApiToken) {
		manualState.manualApiToken = (plugin.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
	}
	if (!manualState.manualBucketName) {
		manualState.manualBucketName = plugin.settings.bucketName.trim();
	}
	if (!manualState.manualWorkerName) {
		manualState.manualWorkerName = plugin.settings.workerName.trim();
	}
}

async function resolveCredentialsForSetup(
	plugin: CratePlugin,
	manualState: ManualSetupState
): Promise<CloudflareCredentials> {
	if (manualState.manualEntryEnabled) {
		const accountId = manualState.manualAccountId.trim();
		const apiToken = manualState.manualApiToken.trim();
		if (!accountId || !apiToken) {
			throw new Error('Enter both Cloudflare account ID and API token in manual entry mode');
		}

		const valid = await verifyCredentials({ accountId, apiToken });
		if (!valid) {
			throw new Error('Cloudflare credentials are invalid');
		}

		await plugin.cloudflareSession.saveCredentials(accountId, apiToken);
		return { accountId, apiToken };
	}

	const creds = await plugin.cloudflareSession.resolveCredentials();
	if (!creds) {
		throw new Error('Please sign in with Cloudflare first');
	}

	return creds;
}

async function createInfrastructureFromCredentials(
	plugin: CratePlugin,
	manualState: ManualSetupState,
	creds: CloudflareCredentials,
	onProgress: (message: string) => void
): Promise<void> {
	const manualBucketName = manualState.manualBucketName.trim();
	const manualWorkerName = manualState.manualWorkerName.trim();

	const result = await quickSetup(
		{
			accountId: creds.accountId,
			apiToken: creds.apiToken,
			bucketName: manualState.manualEntryEnabled && manualBucketName
				? manualBucketName
				: undefined,
			workerName: manualState.manualEntryEnabled && manualWorkerName
				? manualWorkerName
				: undefined,
		},
		onProgress
	);

	await plugin.syncRuntime.applyInfrastructureConfig({
		workerUrl: result.workerUrl,
		authToken: result.authToken,
		workerName: result.workerName,
		bucketName: result.bucketName,
		databaseId: result.databaseId,
		accountId: creds.accountId,
	});
}
