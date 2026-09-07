import { Notice, Setting, type ButtonComponent } from 'obsidian';
import type { CachedDevicesState } from '../../plugin/settings-ui-state';
import type CratePlugin from '../../main';
import type { RegisteredDevice } from '../../protocol/sync-types';
import { openConfirmationModal } from '../confirmation-modal';
import { createSettingsSectionHeading } from './section-helpers';

export interface DevicesSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
}

export function renderDevicesSection(context: DevicesSectionContext): () => void {
	const { containerEl, plugin } = context;
	const apiClient = plugin.syncRuntime.getApiClient();
	if (!apiClient) return () => {};

	if (plugin.settingsUiState.devices?.client !== apiClient) {
		plugin.settingsUiState.devices = { client: apiClient, tokens: null, pending: null };
	}
	const cache = plugin.settingsUiState.devices;
	let disposed = false;
	const isActive = () => !disposed && plugin.settingsUiState.devices === cache;
	let refreshButton: ButtonComponent;

	createSettingsSectionHeading(containerEl, 'Devices');
	new Setting(containerEl)
		.setName('Connected devices')
		.setDesc('Remove sync access for devices you no longer use.')
		.addButton(button => {
			refreshButton = button.setButtonText('Refresh');
			button.onClick(() => { void refresh(); });
		});

	const listContainer = containerEl.createDiv({ cls: 'crate-connected-devices' });
	const statusEl = containerEl.createEl('p', { cls: 'setting-item-description' });
	statusEl.setAttribute('role', 'status');

	const renderList = () => {
		listContainer.empty();
		if (cache.tokens === null) return;
		if (cache.tokens.length === 0) {
			listContainer.createEl('p', {
				text: 'No connected devices found yet.',
				cls: 'setting-item-description',
			});
		}
		for (const token of orderDevices(cache.tokens)) {
			const label = formatDeviceLabel(token);
			const setting = new Setting(listContainer)
				.setName(label)
				.setDesc(formatDeviceDescription(token));
			if (token.is_current) continue;
			setting.addButton(button => {
				button.setButtonText('Remove').setDestructive();
				button.onClick(async () => {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Remove device',
						message: `${label} will lose sync access.`,
						details: ['Sign in with Cloudflare on that device to reconnect.'],
						confirmText: 'Remove device',
						warning: true,
					});
					if (!confirmed || !isActive()) return;
					button.setDisabled(true);
					try {
						// Finish any earlier listing before invalidating this device.
						await cache.pending?.catch(() => {});
						if (!isActive()) return;
						await apiClient.revokeToken(token.id);
						cache.tokens = cache.tokens?.filter(device => device.id !== token.id) ?? null;
						if (!isActive()) return;
						renderList();
						new Notice(`Removed ${label}`);
						await refresh();
					} catch {
						if (isActive()) {
							new Notice('Failed to remove device');
							button.setDisabled(false);
						}
					}
				});
			});
		}
	};

	async function refresh(): Promise<void> {
		if (!isActive()) return;
		refreshButton.setDisabled(true);
		statusEl.setText(cache.tokens === null ? 'Loading devices…' : 'Refreshing devices…');
		try {
			await refreshDeviceCache(cache);
			if (!isActive()) return;
			renderList();
			statusEl.setText('');
		} catch {
			if (!isActive()) return;
			statusEl.setText(cache.tokens === null
				? 'Failed to load connected devices.'
				: 'Could not refresh devices. Showing the last loaded list.');
		} finally {
			if (isActive()) refreshButton.setDisabled(false);
		}
	}

	renderList();
	void refresh();
	return () => { disposed = true; };
}

function refreshDeviceCache(cache: CachedDevicesState): Promise<void> {
	if (!cache.pending) {
		cache.pending = cache.client.listTokens()
			.then(({ tokens }) => { cache.tokens = tokens; })
			.finally(() => { cache.pending = null; });
	}
	return cache.pending;
}

function orderDevices(tokens: RegisteredDevice[]): RegisteredDevice[] {
	const currentTokens = tokens.filter((token) => token.is_current);
	const otherTokens = tokens.filter((token) => !token.is_current);
	return [...currentTokens, ...otherTokens];
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
