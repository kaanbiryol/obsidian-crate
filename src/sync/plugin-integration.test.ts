import { beforeEach, expect, it, vi } from 'vitest';
import { TFile, TFolder, type Command, type Menu, type MenuItem, type TAbstractFile } from 'obsidian';
import type CratePlugin from '../main';
import { openRemoteRecoveryModal } from '../ui/remote-recovery-modal';
import { registerSyncCommands } from './plugin-integration';

vi.mock('../ui/remote-recovery-modal', () => ({ openRemoteRecoveryModal: vi.fn() }));
vi.mock('../ui/activity-modal', () => ({ ActivityModal: vi.fn() }));
vi.mock('./runtime', () => ({ SyncRuntime: vi.fn() }));
vi.mock('../reminders/runtime', () => ({ ensureReminderNotificationPolicy: vi.fn(), refreshReminderNotificationPolicy: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

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

it('opens the active file only when the history command is executed', () => {
 const { plugin, workspace, file, commands } = setup();
 const command = commands.find(command => command.id === 'show-file-history')!;
 expect(command.checkCallback!(true)).toBe(true);
 expect(openRemoteRecoveryModal).not.toHaveBeenCalled();
 command.checkCallback!(false);
 expect(openRemoteRecoveryModal).toHaveBeenCalledWith(plugin.app, plugin.syncRuntime, file.path);
 workspace.getActiveFile.mockReturnValue(null);
 expect(command.checkCallback!(false)).toBe(false);
 workspace.getActiveFile.mockReturnValue(file);
 plugin.syncRuntime.isConfigured.mockReturnValue(false);
 expect(command.checkCallback!(false)).toBe(false);
 expect(openRemoteRecoveryModal).toHaveBeenCalledTimes(1);
});

it('registers a file-only context action that opens the clicked file', () => {
 const { plugin, file, fileMenu } = setup();
 let click!: () => void;
 const item = { setTitle: vi.fn().mockReturnThis(), setIcon: vi.fn().mockReturnThis(), onClick: vi.fn((callback: () => void) => { click = callback; }) };
 const menu = { addItem: vi.fn((callback: (item: MenuItem) => void) => callback(item as unknown as MenuItem)) };
 expect(plugin.registerEvent).toHaveBeenCalledWith({ event: 'file-menu' });
 const clicked = Object.assign(new TFile(), { path: 'Archive/Other.md' });
 fileMenu(menu as unknown as Menu, clicked);
 expect(item.setTitle).toHaveBeenCalledWith('File history');
 click();
 expect(openRemoteRecoveryModal).toHaveBeenCalledWith(plugin.app, plugin.syncRuntime, clicked.path);
 fileMenu(menu as unknown as Menu, new TFolder());
 plugin.syncRuntime.isConfigured.mockReturnValue(false);
 fileMenu(menu as unknown as Menu, file);
 expect(menu.addItem).toHaveBeenCalledTimes(1);
});
