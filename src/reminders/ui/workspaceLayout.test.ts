import { describe, expect, it, vi } from 'vitest';
import { activateOrRevealRemindersLeaf } from './workspaceLayout';

function createLeaf() {
	return {
		setViewState: vi.fn(async () => {}),
		getViewState: vi.fn(() => ({ type: 'reminders-view' })),
	};
}

describe('activateOrRevealRemindersLeaf', () => {
	it('reuses an attached temporarily empty pane across plugin module reloads', async () => {
		const leaf = createLeaf();
		let leaves = [leaf];
		const workspace = {
			iterateAllLeaves: (callback: (value: typeof leaf) => void) => callback(leaf),
			getLeavesOfType: vi.fn(() => leaves),
			getRightLeaf: vi.fn(() => createLeaf()),
			revealLeaf: vi.fn(),
		};
		await activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		// Unload temporarily clears the view before Obsidian restores its type.
		leaves = [];
		leaf.getViewState.mockReturnValue({ type: 'empty' });
		vi.resetModules();
		const reloaded = await import('./workspaceLayout');
		await reloaded.activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		expect(workspace.getRightLeaf).not.toHaveBeenCalled();
		expect(leaf.setViewState).toHaveBeenCalledExactlyOnceWith({ type: 'reminders-view', active: true });
		expect(workspace.revealLeaf).toHaveBeenLastCalledWith(leaf);
	});
	it.each(['detached', 'repurposed'])('does not reclaim a %s reserved pane', async kind => {
		const original = createLeaf();
		const replacement = createLeaf();
		let leaves = [original];
		let attached = true;
		const workspace = {
			iterateAllLeaves: (callback: (value: typeof original) => void) => { if (attached) callback(original); },
			getLeavesOfType: vi.fn(() => leaves),
			getRightLeaf: vi.fn(() => replacement),
			revealLeaf: vi.fn(),
		};
		await activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		leaves = [];
		attached = kind !== 'detached';
		original.getViewState.mockReturnValue({ type: kind === 'repurposed' ? 'markdown' : 'empty' });
		await activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		expect(original.setViewState).not.toHaveBeenCalled();
		expect(workspace.getRightLeaf).toHaveBeenCalledOnce();
		expect(workspace.revealLeaf).toHaveBeenLastCalledWith(replacement);
	});
	it('allows the next open to recover after a failed activation', async () => {
		const leaf = createLeaf();
		leaf.setViewState.mockRejectedValueOnce(new Error('view unavailable'));
		const workspace = {
			iterateAllLeaves: (callback: (value: typeof leaf) => void) => callback(leaf),
			getLeavesOfType: vi.fn(() => []),
			getRightLeaf: vi.fn(() => leaf),
			revealLeaf: vi.fn(),
		};
		const failed = activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		const retry = activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		await expect(failed).rejects.toThrow('view unavailable');
		await retry;
		expect(workspace.getRightLeaf).toHaveBeenCalledOnce();
		expect(workspace.revealLeaf).toHaveBeenCalledExactlyOnceWith(leaf);
	});
	it('serializes concurrent opens while Obsidian is still constructing the first leaf', async () => {
		let finish!: () => void;
		const ready = new Promise<void>(resolve => { finish = resolve; });
		let leaves: ReturnType<typeof createLeaf>[] = [];
		const leaf = createLeaf();
		leaf.setViewState.mockImplementation(async () => { await ready; leaves = [leaf]; });
		const workspace = { iterateAllLeaves: vi.fn(), getLeavesOfType: vi.fn(() => leaves), getRightLeaf: vi.fn(() => leaf), revealLeaf: vi.fn() };
		const first = activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		const second = activateOrRevealRemindersLeaf(workspace, 'reminders-view');
		await Promise.resolve();
		finish(); await Promise.all([first, second]);
		expect(workspace.getRightLeaf).toHaveBeenCalledOnce();
		expect(leaf.setViewState).toHaveBeenCalledOnce();
	});
	it('does not finish activation before the deferred view is actually revealed', async () => {
		let finish!: () => void;
		const ready = new Promise<void>(resolve => { finish = resolve; });
		const workspace = { iterateAllLeaves: vi.fn(), getLeavesOfType: vi.fn(() => [createLeaf()]), getRightLeaf: vi.fn(), revealLeaf: vi.fn(() => ready) };
		let finished = false;
		const opening = activateOrRevealRemindersLeaf(workspace, 'reminders-view').then(() => { finished = true; });
		await Promise.resolve(); await Promise.resolve();
		expect(finished).toBe(false);
		finish(); await opening;
	});
	it('does not reveal a late view after its plugin unloads', async () => {
		const controller = new AbortController();
		const leaf = createLeaf();
		leaf.setViewState.mockImplementation(async () => { controller.abort(); });
		const workspace = { iterateAllLeaves: vi.fn(), getLeavesOfType: vi.fn(() => []), getRightLeaf: vi.fn(() => leaf), revealLeaf: vi.fn() };
		await activateOrRevealRemindersLeaf(workspace, 'reminders-view', undefined, controller.signal);
		expect(workspace.revealLeaf).not.toHaveBeenCalled();
	});
	it('reuses an existing reminders leaf so reload keeps its workspace position', async () => {
		const existingLeaf = createLeaf();
		const workspace = { iterateAllLeaves: vi.fn(),
			getLeavesOfType: vi.fn(() => [existingLeaf]),
			getRightLeaf: vi.fn(),
			revealLeaf: vi.fn(),
		};

		await activateOrRevealRemindersLeaf(workspace, 'reminders-view');

		expect(workspace.getLeavesOfType).toHaveBeenCalledWith('reminders-view');
		expect(workspace.getRightLeaf).not.toHaveBeenCalled();
		expect(existingLeaf.setViewState).not.toHaveBeenCalled();
		expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
	});

	it('creates and reveals a right sidebar leaf when no reminders leaf exists yet', async () => {
		const newLeaf = createLeaf();
		const workspace = { iterateAllLeaves: vi.fn(),
			getLeavesOfType: vi.fn(() => []),
			getRightLeaf: vi.fn(() => newLeaf),
			revealLeaf: vi.fn(),
		};

		await activateOrRevealRemindersLeaf(workspace, 'reminders-view');

		expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
		expect(newLeaf.setViewState).toHaveBeenCalledWith({
			type: 'reminders-view',
			active: true,
		});
		expect(workspace.revealLeaf).toHaveBeenCalledWith(newLeaf);
	});

	it.each([true, false])('opens a linked project when an existing view is %s', async exists => {
		const leaf = createLeaf();
		const workspace = { iterateAllLeaves: vi.fn(),
			getLeavesOfType: vi.fn(() => exists ? [leaf] : []),
			getRightLeaf: vi.fn(() => leaf),
			revealLeaf: vi.fn(),
		};
		await activateOrRevealRemindersLeaf(workspace, 'reminders-view', 'Work');
		expect(leaf.setViewState).toHaveBeenCalledExactlyOnceWith({
			type: 'reminders-view',
			active: true,
			state: { project: 'Work' },
		});
		expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
	});

	it('does not reveal a view when no workspace leaf can be created', async () => {
		const workspace = { iterateAllLeaves: vi.fn(),
			getLeavesOfType: vi.fn(() => []),
			getRightLeaf: vi.fn(() => null),
			revealLeaf: vi.fn(),
		};

		await activateOrRevealRemindersLeaf(workspace, 'reminders-view');

		expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
		expect(workspace.revealLeaf).not.toHaveBeenCalled();
	});
});
