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

	it('leaves fullscreen/mobile flows untouched when no workspace leaf can be created', async () => {
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
