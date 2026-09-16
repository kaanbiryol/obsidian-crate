import { FileSystemAdapter, Platform, TFile, type App } from 'obsidian';
import { assertLocalSyncPath } from '../../sync/local-path-safety';

export interface PendingFileAction {
    title: string;
    icon: string;
    run(): Promise<void>;
}

export function getPendingFileActions(app: App, path: string, onOpened: () => void): PendingFileAction[] {
    assertLocalSyncPath(path);
    const actions: PendingFileAction[] = [];
    // Hidden configuration files are not in Obsidian's vault file index.
    if (app.vault.getAbstractFileByPath(path) instanceof TFile) {
        actions.push({ title: 'Open in Obsidian', icon: 'file', run: async () => {
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) throw new Error('This file is no longer available in the vault.');
            await app.workspace.getLeaf('tab').openFile(file);
            onOpened();
        } });
    }
    const adapter = app.vault.adapter;
    if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
        actions.push({
            title: Platform.isMacOS ? 'Reveal in Finder' : Platform.isWin ? 'Reveal in File Explorer' : 'Reveal in file manager',
            icon: 'folder-open',
            run: async () => {
                // For deleted files, reveal the closest remaining parent folder.
                let target = path;
                while (target && !await adapter.exists(target)) {
                    target = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
                }
                // Electron is supplied by Obsidian and never loaded on mobile.
                // eslint-disable-next-line @typescript-eslint/no-require-imports -- Desktop-only host API.
                const { shell } = require('electron') as { shell: { showItemInFolder(path: string): void } };
                shell.showItemInFolder(adapter.getFullPath(target));
            },
        });
    }
    return actions;
}
