type RemindersLeaf = {
	setViewState(state: { type: string; active: boolean; state?: { project: string } }): Promise<void>;
};

export type RemindersWorkspace = {
	getLeavesOfType(type: string): RemindersLeaf[];
	getRightLeaf(split: boolean): RemindersLeaf | null;
	revealLeaf(leaf: RemindersLeaf): void;
};

export async function activateOrRevealRemindersLeaf(
	workspace: RemindersWorkspace,
	viewType: string,
	project?: string,
): Promise<void> {
	const existingLeaf = workspace.getLeavesOfType(viewType)[0];
	const leaf = existingLeaf ?? workspace.getRightLeaf(false);
	if (!leaf) return;

	if (!existingLeaf || project) {
		await leaf.setViewState({
			type: viewType,
			active: true,
			...(project ? { state: { project } } : {}),
		});
	}
	workspace.revealLeaf(leaf);
}
