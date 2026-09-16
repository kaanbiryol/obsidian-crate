import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({
    FileSystemAdapter: class {}, TFile: class {},
    Platform: { isDesktopApp: true, isMacOS: true, isWin: false },
}));
import { FileSystemAdapter, Platform, TFile } from 'obsidian';
import { getPendingFileActions } from './file-actions';

beforeEach(() => { Platform.isDesktopApp = true; Platform.isMacOS = true; Platform.isWin = false; });
function fixture(file: TFile | null) {
    const openFile = vi.fn(async () => {});
    const closed = vi.fn();
    const getAbstractFileByPath = vi.fn(() => file);
    const app = { vault: { adapter: Object.create(FileSystemAdapter.prototype) as FileSystemAdapter, getAbstractFileByPath }, workspace: { getLeaf: vi.fn(() => ({ openFile })) } };
    return { app, openFile, closed, getAbstractFileByPath, actions: () => getPendingFileActions(app as never, 'Notes/Example.md', closed) };
}

describe('pending file actions', () => {
    it('opens the current vault file in an Obsidian tab, then dismisses activity', async () => {
        const file = new TFile();
        const h = fixture(file);
        await h.actions().find(action => action.title === 'Open in Obsidian')!.run();
        expect(h.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
        expect(h.openFile).toHaveBeenCalledWith(file);
        expect(h.closed).toHaveBeenCalledOnce();
    });
    it('keeps activity open when the file disappears or opening fails', async () => {
        const h = fixture(new TFile());
        const action = h.actions()[0]!;
        h.getAbstractFileByPath.mockReturnValue(null);
        await expect(action.run()).rejects.toThrow('no longer available');
        expect(h.openFile).not.toHaveBeenCalled();
        expect(h.closed).not.toHaveBeenCalled();
    });
    it('offers only Finder for hidden or deleted files absent from the vault index', () => {
        const h = fixture(null);
        expect(h.actions().map(action => action.title)).toEqual(['Reveal in Finder']);
    });
    it('uses the system file manager label on Windows and Linux', () => {
        const h = fixture(null);
        Platform.isMacOS = false; Platform.isWin = true;
        expect(h.actions()[0]?.title).toBe('Reveal in File Explorer');
        Platform.isWin = false;
        expect(h.actions()[0]?.title).toBe('Reveal in file manager');
    });
    it('omits desktop reveal actions on mobile', () => {
        Platform.isDesktopApp = false;
        expect(fixture(new TFile()).actions().map(action => action.title)).toEqual(['Open in Obsidian']);
        expect(fixture(null).actions()).toEqual([]);
    });
    it('rejects paths outside the vault', () => {
        const h = fixture(null);
        expect(() => getPendingFileActions(h.app as never, '../elsewhere', h.closed)).toThrow('Invalid sync path');
    });
});
