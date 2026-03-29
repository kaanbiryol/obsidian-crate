import type CratePlugin from '../main';
import {
	type RemindersSettings,
	normalizeRemindersFolderPath,
	useRemindersSettingsStore,
} from './settings';
import { createLogger } from './utils/logger';

const remindersLogger = createLogger('Reminders');

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
	const parsed: unknown = JSON.parse(raw);
	return isRecord(parsed) ? parsed : null;
}

function getPluginDataPath(plugin: CratePlugin, filename: string): string {
	const configDir = plugin.app.vault.configDir;
	const pluginId = plugin.manifest.id;
	return `${configDir}/plugins/${pluginId}/${filename}`;
}

async function ensurePluginDataDir(plugin: CratePlugin): Promise<void> {
	const adapter = plugin.app.vault.adapter;
	const pluginDir = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
	if (await adapter.exists(pluginDir)) {
		return;
	}

	try {
		await adapter.mkdir(pluginDir);
	} catch {
		// Best effort: the directory may have been created concurrently.
	}
}

async function loadRemindersSettingsData(plugin: CratePlugin): Promise<Partial<RemindersSettings> | null> {
	try {
		const adapter = plugin.app.vault.adapter;
		const settingsPath = getPluginDataPath(plugin, 'reminders-settings.json');
		if (await adapter.exists(settingsPath)) {
			const content = await adapter.read(settingsPath);
			return parseJsonRecord(content);
		}
	} catch (error) {
		remindersLogger.error('Failed to load reminders settings:', error);
	}
	return null;
}

async function saveRemindersSettingsData(plugin: CratePlugin, settings: RemindersSettings): Promise<void> {
	try {
		const adapter = plugin.app.vault.adapter;
		await ensurePluginDataDir(plugin);
		const settingsPath = getPluginDataPath(plugin, 'reminders-settings.json');
		await adapter.write(settingsPath, JSON.stringify(settings, null, 2));
	} catch (error) {
		remindersLogger.error('Failed to save reminders settings:', error);
	}
}

export async function loadRemindersSettings(plugin: CratePlugin): Promise<void> {
	const settingsData = await loadRemindersSettingsData(plugin);

	if (settingsData) {
		const loaded = settingsData as Record<string, unknown>;
		if ('autoOpenSidebarOnMobile' in loaded) {
			if (loaded.autoOpenSidebarOnMobile === true) {
				loaded.autoOpenView = 'sidebar';
			}
			delete loaded.autoOpenSidebarOnMobile;
		}

		delete loaded.syncMethod;
		const normalizedSettingsData: Partial<RemindersSettings> = {
			...settingsData,
			remindersFolderPath: normalizeRemindersFolderPath(
				typeof loaded.remindersFolderPath === 'string' ? loaded.remindersFolderPath : undefined,
			),
		};

		useRemindersSettingsStore.setState((old) => ({
			...old,
			...normalizedSettingsData,
		}), true);
	}

	plugin.remindersSettings = useRemindersSettingsStore.getState();
	await saveRemindersSettingsData(plugin, plugin.remindersSettings);
}

export async function writeRemindersSettings(
	plugin: CratePlugin,
	update: Partial<RemindersSettings>,
): Promise<void> {
	const normalizedUpdate = { ...update };
	if (Object.prototype.hasOwnProperty.call(normalizedUpdate, 'remindersFolderPath')) {
		normalizedUpdate.remindersFolderPath = normalizeRemindersFolderPath(normalizedUpdate.remindersFolderPath);
	}
	useRemindersSettingsStore.setState(normalizedUpdate);
	plugin.remindersSettings = useRemindersSettingsStore.getState();
	await saveRemindersSettingsData(plugin, plugin.remindersSettings);
}
