import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import type { RegisteredDevice } from '../../plugin/types';
import { openConfirmationModal } from '../confirmation-modal';
import { createSettingsSectionHeading } from './section-helpers';

export interface DevicesSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
}

export function renderDevicesSection(context: DevicesSectionContext): void {
	const { containerEl, plugin } = context;
	const apiClient = plugin.syncRuntime.getApiClient();

	if (!apiClient) {
		return;
	}

	createSettingsSectionHeading(containerEl, 'Devices');
	new Setting(containerEl)
		.setName('Connected devices')
		.setDesc('Remove sync access for devices you no longer use.')
		.addButton((button) => {
			button.setButtonText('Refresh');
			button.onClick(async () => {
				await loadDevices(listContainer, plugin);
			});
		});

	const listContainer = containerEl.createDiv({ cls: 'crate-connected-devices' });
	void loadDevices(listContainer, plugin);
}

async function loadDevices(container: HTMLElement, plugin: CratePlugin): Promise<void> {
	container.empty();
	const apiClient = plugin.syncRuntime.getApiClient();
	if (!apiClient) {
		container.createEl('p', {
			text: 'Sync API is unavailable.',
			cls: 'setting-item-description',
		});
		return;
	}

	try {
		const { tokens } = await apiClient.listTokens();
		const visibleTokens = orderDevices(tokens.filter(shouldDisplayToken));
		if (visibleTokens.length === 0) {
			container.createEl('p', {
				text: 'No connected devices found yet.',
				cls: 'setting-item-description',
			});
			return;
		}

		for (const token of visibleTokens) {
			const label = formatDeviceLabel(token);
			const setting = new Setting(container)
				.setName(label)
				.setDesc(formatDeviceDescription(token));

			if (token.is_current) {
				continue;
			}

			setting.addButton((button) => {
				button.setButtonText('Remove');
				button.setWarning();
				button.onClick(async () => {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Remove device',
						message: `Remove sync access for ${label}?`,
						details: ['That device will need a new setup link before it can sync again.'],
						confirmText: 'Remove device',
						warning: true,
					});
					if (!confirmed) {
						return;
					}

					try {
						await apiClient.revokeToken(token.id);
						new Notice(`Removed ${label}`);
						await loadDevices(container, plugin);
					} catch {
						new Notice('Failed to remove device');
					}
				});
			});
		}
	} catch {
		container.createEl('p', {
			text: 'Failed to load connected devices.',
			cls: 'setting-item-description',
		});
	}
}

function orderDevices(tokens: RegisteredDevice[]): RegisteredDevice[] {
	const currentTokens = tokens.filter((token) => token.is_current);
	const otherTokens = tokens.filter((token) => !token.is_current);
	return [...currentTokens, ...otherTokens];
}

function shouldDisplayToken(token: RegisteredDevice): boolean {
	return token.device_name !== 'setup-link' || !!token.last_seen_at;
}

function formatDeviceDescription(token: RegisteredDevice): string {
	const parts: string[] = [];

	if (token.is_current) {
		parts.push('Current device');
	} else if (token.last_seen_at) {
		parts.push(`Last seen ${formatDateTime(token.last_seen_at)}`);
	} else {
		parts.push('Not used yet');
	}

	if (token.platform) {
		parts.push(formatPlatform(token.platform));
	}
	if (token.device_id) {
		parts.push(token.device_id);
	}
	parts.push(`Added ${formatDateTime(token.created_at)}`);

	return parts.join(' • ');
}

function formatDeviceLabel(token: RegisteredDevice): string {
	const baseLabel = token.device_name?.trim() || token.device_id?.trim() || 'Unnamed device';
	return token.is_current ? `${baseLabel} (Current device)` : baseLabel;
}

function formatDateTime(value: string): string {
	const normalized = value.includes('T') ? value : value.replace(' ', 'T');
	const parsed = new Date(normalized);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatPlatform(value: string): string {
	switch (value) {
		case 'ios':
			return 'iOS';
		case 'android':
			return 'Android';
		case 'macos':
			return 'macOS';
		case 'windows':
			return 'Windows';
		case 'linux':
			return 'Linux';
		case 'mobile':
			return 'Mobile';
		case 'desktop':
			return 'Desktop';
		default:
			return value;
	}
}
