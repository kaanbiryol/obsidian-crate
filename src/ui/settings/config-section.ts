import { Notice, Platform, requestUrl, Setting } from 'obsidian';
import { generateAuthToken, verifyCredentials } from '../../cloudflare/api';
import { computeTokenHash, quickSetup, refreshWorkerAuthToken } from '../../cloudflare/infrastructure';
import type CratePlugin from '../../main';
import { SECRET_KEYS } from '../../types';
import { SyncApiClient } from '../../sync/api';
import { QRModal } from '../qr-modal';
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
	const isDesktop = Platform.isDesktopApp;

	const hasCloudflareCredentials = plugin.cloudflareSession.hasCredentials();
	if (hasCloudflareCredentials) {
		manualState.manualEntryEnabled = false;
	}

	containerEl.createEl('h3', { text: 'Configuration' });

	const setupProgress = containerEl.createEl('p', {
		cls: 'crate-action-progress',
	});
	setupProgress.style.display = 'none';

	const isConfigured = plugin.syncRuntime.isConfigured();

	if (!hasCloudflareCredentials && !isConfigured) {
		new Setting(containerEl)
			.setName('Cloudflare sign in')
			.setDesc(
				isDesktop
					? 'Sign in via browser. Infrastructure is created automatically after authorization.'
					: 'Desktop only. Set up on desktop first, then use "Set up another device" to copy a setup link.'
			)
			.addButton(button => {
				button.setButtonText('Sign in with Cloudflare').setCta();
				if (!isDesktop) {
					button.setDisabled(true);
					button.setTooltip('Cloudflare sign-in is only available on desktop');
					return button;
				}

				button.onClick(async () => {
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
				});

				return button;
			});
	} else if (hasCloudflareCredentials) {
		new Setting(containerEl)
			.setName('Cloudflare account')
			.setDesc(
				isDesktop
					? plugin.settings.cloudflareAccountId
					: `${plugin.settings.cloudflareAccountId} (re-authentication requires desktop)`
			)
			.addButton(button => {
				button.setButtonText('Re-authenticate');
				if (!isDesktop) {
					button.setDisabled(true);
					button.setTooltip('Cloudflare re-authentication is only available on desktop');
					return button;
				}

				button.onClick(async () => {
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
							} else {
								const connTest = await plugin.syncRuntime.testConnection();
								if (!connTest.success) {
									const creds = await plugin.cloudflareSession.resolveCredentials();
									if (!creds) {
										throw new Error('Cloudflare credentials are unavailable after login');
									}
									const newToken = await refreshWorkerAuthToken(creds, {
										workerUrl: plugin.settings.workerUrl,
										workerName: plugin.settings.workerName,
										bucketName: plugin.settings.bucketName,
										databaseId: plugin.settings.databaseId,
									});
									await plugin.syncRuntime.applyInfrastructureConfig({
										workerUrl: plugin.settings.workerUrl,
										authToken: newToken,
										workerName: plugin.settings.workerName,
										bucketName: plugin.settings.bucketName,
										databaseId: plugin.settings.databaseId,
									});
								}
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
				});

				return button;
			})
			.addExtraButton(button => button
				.setIcon('x')
				.setTooltip('Sign out from Cloudflare')
				.onClick(async () => {
					await plugin.syncRuntime.clearSyncConfiguration({ clearCloudflareCredentials: true });
					new Notice('Signed out and configuration cleared');
					rerender();
				}));
	}

	if (!hasCloudflareCredentials && !isConfigured) {
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

	if (!isConfigured && (hasCloudflareCredentials || manualState.manualEntryEnabled)) {
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

	if (isConfigured) {
		new Setting(containerEl)
			.setName('Set up another device')
			.setDesc('Share a setup link to configure Crate on another device. The link contains your sync credentials - share it securely.')
			.addButton(button => button
				.setButtonText('Copy link')
				.onClick(async () => {
					const link = await buildSetupLink(plugin);
					if (!link) return;
					await navigator.clipboard.writeText(link);
					new Notice('Setup link copied to clipboard');
				}))
			.addButton(button => button
				.setButtonText('Show QR')
				.onClick(async () => {
					const link = await buildSetupLink(plugin);
					if (!link) return;
					new QRModal(plugin.app, link).open();
				}));
	}

	if (hasCloudflareCredentials || isConfigured) {
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
		throw new Error(
			Platform.isDesktopApp
				? 'Please sign in with Cloudflare first'
				: 'Please sign in with Cloudflare on desktop first, or use manual entry mode'
		);
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

	try {
		const tempClient = new SyncApiClient(result.workerUrl, result.authToken);
		const { settings: shared } = await tempClient.getSharedSettings();
		if (shared) {
			plugin.settings.ignorePatterns = shared.ignorePatterns;
			plugin.settings.syncOnStartup = shared.syncOnStartup;
			plugin.settings.syncInterval = shared.syncInterval;
			plugin.settings.showStatusBar = shared.showStatusBar;
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
	const analyticsToken = plugin.secretStorage.get(SECRET_KEYS.ANALYTICS_TOKEN);
	if (analyticsToken) {
		params.set('analyticsToken', analyticsToken);
	}
	params.set('ignorePatterns', JSON.stringify(plugin.settings.ignorePatterns));
	params.set('syncOnStartup', String(plugin.settings.syncOnStartup));
	params.set('syncInterval', String(plugin.settings.syncInterval));
	params.set('showStatusBar', String(plugin.settings.showStatusBar));

	return `obsidian://crate-setup?${params.toString()}`;
}
