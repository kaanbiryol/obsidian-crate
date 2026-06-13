type RemindersLeaf = {
	setViewState(state: { type: string; active: boolean }): Promise<void>;
};

export type RemindersWorkspace = {
	getLeavesOfType(type: string): RemindersLeaf[];
	getRightLeaf(split: boolean): RemindersLeaf | null;
	revealLeaf(leaf: RemindersLeaf): void;
};

export async function activateOrRevealRemindersLeaf(
	workspace: RemindersWorkspace,
	viewType: string,
): Promise<void> {
	let leaf = workspace.getLeavesOfType(viewType)[0];

	if (!leaf) {
		const rightLeaf = workspace.getRightLeaf(false);
		if (rightLeaf) {
			leaf = rightLeaf;
			await leaf.setViewState({ type: viewType, active: true });
		}
	}

	if (leaf) {
		workspace.revealLeaf(leaf);
	}
}
