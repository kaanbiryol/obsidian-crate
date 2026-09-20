import { Notice, Setting, type ButtonComponent } from 'obsidian';
import type { CachedDevicesState } from '../../plugin/settings-ui-state';
import type CratePlugin from '../../main';
import type { RegisteredDevice } from '../../protocol/sync-types';
import { openConfirmationModal } from '../confirmation-modal';
import { createSettingsDisclosure } from './section-helpers';

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

	const devicesEl = createSettingsDisclosure(containerEl, 'Devices and sessions');
	new Setting(devicesEl)
		.setName('Connected devices and sessions')
		.setDesc('Browsers and home screen apps appear separately, even on the same device.')
		.addButton(button => {
			refreshButton = button.setButtonText('Refresh');
			button.onClick(() => { void refresh(); });
		});

	const listContainer = devicesEl.createDiv({ cls: 'crate-connected-devices' });
	const statusEl = devicesEl.createEl('p', { cls: 'setting-item-description' });
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
				.setName(label);
			if (token.is_current) setting.nameEl.createSpan( { text: 'This device', cls: 'crate-current-device-badge' });
			if (token.device_id) {
				setting.descEl.addClass('crate-device-description');
				const details = createSettingsDisclosure(setting.descEl, formatDeviceDescription(token));
				if (token.last_seen_at) details.createEl('p', { text: `Last seen ${formatDateTime(token.last_seen_at)}` });
				details.createEl('p', { text: `Device ID: ${token.device_id}` });
				details.createEl('p', { text: `Added ${formatDateTime(token.created_at)}` });
			} else {
				setting.setDesc(formatDeviceDescription(token));
			}
			if (token.is_current) continue;
			setting.addButton(button => {
				button.setButtonText(token.platform === 'pwa' ? 'Disconnect session' : 'Disconnect device').setDestructive();
				button.onClick(async () => {
					const webSession = token.platform === 'pwa';
					const confirmed = await openConfirmationModal(plugin.app, {
						title: webSession ? 'Remove session' : 'Remove device',
						message: `${label} will lose ${webSession ? 'access to reminders' : 'sync access'}.`,
						details: [webSession
							? 'Open a fresh app link from Crate in Obsidian to reconnect.'
							: plugin.settings.cloudflareDeployment
								? 'Sign in with Cloudflare on that device to reconnect.'
								: 'Generate a new access token on your server to reconnect that device.'],
						confirmText: webSession ? 'Remove session' : 'Remove device',
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

	if (token.last_seen_at) {
		parts.push(`Last seen ${formatLastSeen(token.last_seen_at)}`);
	} else {
		parts.push('Not used yet');
	}

	if (token.platform) {
		parts.push(formatPlatform(token.platform));
	}

	return parts.join(' • ');
}

function formatDeviceLabel(token: RegisteredDevice): string {
	const baseLabel = token.device_name?.trim() || token.device_id?.trim() || 'Unnamed device';
	return token.is_current ? baseLabel.replace(/\s*\((?:this|current device)\)\s*$/i, '') : baseLabel;
}

function formatLastSeen(value: string): string {
	const normalized = value.includes('T') ? value : value.replace(' ', 'T');
	const time = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`).getTime();
	if (!Number.isFinite(time)) return value;
	const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
	const days = Math.floor(minutes / 1440);
	return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function formatDateTime(value: string): string {
	const normalized = value.includes('T') ? value : value.replace(' ', 'T');
	const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatPlatform(value: string): string {
	switch (value) {
		case 'pwa':
			return 'Reminders web session';
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
