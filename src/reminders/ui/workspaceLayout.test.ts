import { describe, expect, it, vi } from 'vitest';
import { activateOrRevealRemindersLeaf } from './workspaceLayout';

function createLeaf() {
	return {
		setViewState: vi.fn(async () => {}),
	};
}

describe('activateOrRevealRemindersLeaf', () => {
	it('reuses an existing reminders leaf so reload keeps its workspace position', async () => {
		const existingLeaf = createLeaf();
		const workspace = {
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
		const workspace = {
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
		const workspace = {
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
		const workspace = {
			getLeavesOfType: vi.fn(() => []),
			getRightLeaf: vi.fn(() => null),
			revealLeaf: vi.fn(),
		};

		await activateOrRevealRemindersLeaf(workspace, 'reminders-view');

		expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
		expect(workspace.revealLeaf).not.toHaveBeenCalled();
	});
});
