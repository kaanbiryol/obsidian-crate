import { beforeEach, expect, it, vi } from 'vitest';
import { TFile, TFolder, type Command, type Menu, type MenuItem, type TAbstractFile } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { openFileHistoryModal } from '../ui/activity/file-history-modal';
import { openSyncActivity, registerSyncCommands, startVaultReplacement } from './sync-integration';
import type { ActivityModalActions } from '../ui/activity/activity-modal';
import { setSyncReady } from './lifecycle-state';
import { Notice } from '../test/mocks/obsidian';

const activity = vi.hoisted(() => ({ open: vi.fn(), actions: [] as ActivityModalActions[] }));
vi.mock('../ui/activity/file-history-modal', () => ({ openFileHistoryModal: vi.fn() }));
vi.mock('../ui/activity/activity-modal', () => ({ ActivityModal: class {
	constructor(_app: unknown, _settings: unknown, _deps: unknown, actions: ActivityModalActions) { activity.actions.push(actions); }
	open() { activity.open(); }
} }));
vi.mock('../sync/runtime/runtime', () => ({ SyncRuntime: vi.fn() }));
vi.mock('../reminders/notification-policy-sync', () => ({ ensureReminderNotificationPolicy: vi.fn(), refreshReminderNotificationPolicy: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); activity.actions.length = 0; Notice.reset(); });

function setup() {
 const commands: Command[] = [];
 let fileMenu!: (menu: Menu, file: TAbstractFile) => void;
 const file = Object.assign(new TFile(), { path: 'Notes/Inbox.md' });
 const workspace = {
	getActiveFile: vi.fn<() => TFile | null>(() => file),
	on: vi.fn((_event: string, callback: typeof fileMenu) => { fileMenu = callback; return { event: 'file-menu' }; }),
 };
 const plugin = { app: { workspace }, syncRuntime: { isConfigured: vi.fn(() => true) },
	addCommand: (command: Command) => commands.push(command), registerEvent: vi.fn(),
 };
 registerSyncCommands(plugin as unknown as CratePlugin);
 return { plugin, workspace, file, commands, fileMenu };
}

it('opens the active file only when the history command is executed', async () => {
 const { plugin, workspace, file, commands } = setup();
 const command = commands.find(command => command.id === 'show-file-history')!;
 expect(command.checkCallback!(true)).toBe(true);
 expect(openFileHistoryModal).not.toHaveBeenCalled();
 command.checkCallback!(false);
 await vi.waitFor(() => expect(openFileHistoryModal).toHaveBeenCalledWith(plugin.app, plugin.syncRuntime, file.path));
 workspace.getActiveFile.mockReturnValue(null);
 expect(command.checkCallback!(false)).toBe(false);
 workspace.getActiveFile.mockReturnValue(file);
 plugin.syncRuntime.isConfigured.mockReturnValue(false);
 expect(command.checkCallback!(false)).toBe(false);
 expect(openFileHistoryModal).toHaveBeenCalledTimes(1);
});

it('registers a file-only context action that opens the clicked file', async () => {
 const { plugin, file, fileMenu } = setup();
 let click!: () => void;
 const item = { setTitle: vi.fn().mockReturnThis(), setIcon: vi.fn().mockReturnThis(), onClick: vi.fn((callback: () => void) => { click = callback; }) };
 const menu = { addItem: vi.fn((callback: (item: MenuItem) => void) => callback(item as unknown as MenuItem)) };
 expect(plugin.registerEvent).toHaveBeenCalledWith({ event: 'file-menu' });
 const clicked = Object.assign(new TFile(), { path: 'Archive/Other.md' });
 fileMenu(menu as unknown as Menu, clicked);
 expect(item.setTitle).toHaveBeenCalledWith('File history');
 click();
 await vi.waitFor(() => expect(openFileHistoryModal).toHaveBeenCalledWith(plugin.app, plugin.syncRuntime, clicked.path));
 fileMenu(menu as unknown as Menu, new TFolder());
 plugin.syncRuntime.isConfigured.mockReturnValue(false);
 fileMenu(menu as unknown as Menu, file);
 expect(menu.addItem).toHaveBeenCalledTimes(1);
});

it('waits for startup sync initialization before running sync now', async () => {
 const { plugin, commands } = setup();
 let ready!: () => void;
 setSyncReady(plugin as unknown as CratePlugin, new Promise<void>(resolve => { ready = resolve; }));
 const sync = vi.fn(async () => ({ outcome: 'cancelled' }));
 Object.assign(plugin.syncRuntime, { sync });
 commands.find(command => command.id === 'sync-now')!.checkCallback!(false);
 await Promise.resolve();
 expect(sync).not.toHaveBeenCalled();
 ready();
 await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
});

it('stops from sync activity as the Stop sync command does, so settings show automatic sync off', async () => {
 const stopSync = vi.fn(async () => {});
 const refreshSettingsTab = vi.fn();
 const plugin = { app: {}, settings: {}, refreshSettingsTab, syncRuntime: { stopSync } } as unknown as CratePlugin;
 openSyncActivity(plugin);
 expect(activity.open).toHaveBeenCalledOnce();
 await activity.actions[0]!.stop();
 expect(stopSync).toHaveBeenCalledOnce();
 // Before: the Activity Stop button called the runtime directly, so open settings kept showing Automatic sync on.
 expect(refreshSettingsTab).toHaveBeenCalledOnce();
 expect(Notice.messages).toEqual(['Sync stopped. Automatic sync is off on this device.']);
});

it('syncs from sync activity as Sync now does, reporting failures instead of rejecting', async () => {
 const sync = vi.fn(async () => { throw new Error('Offline'); });
 const plugin = { app: {}, settings: {}, syncRuntime: { sync } } as unknown as CratePlugin;
 openSyncActivity(plugin);
 await expect(activity.actions[0]!.sync()).resolves.toBeUndefined();
 expect(sync).toHaveBeenCalledOnce();
 expect(Notice.messages).toEqual(['Sync failed: Offline']);
});

it('opens activity and syncs only when a confirmed replacement is pending', async () => {
 const open = activity.open;
 const sync = vi.fn(async () => ({ outcome: 'completed', success: true, conflicts: [] }));
 const plugin = { app: {}, settings: { replaceVault: false }, syncRuntime: { isConfigured: () => true, sync } } as unknown as CratePlugin;
 expect(startVaultReplacement(plugin)).toBe(false);
 expect(open).not.toHaveBeenCalled();
 plugin.settings.replaceVault = true;
 expect(startVaultReplacement(plugin)).toBe(true);
 expect(open).toHaveBeenCalledOnce();
 await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
});
