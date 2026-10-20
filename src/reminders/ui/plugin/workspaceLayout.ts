type RemindersLeaf = {
	setViewState(state: { type: string; active: boolean; state?: { project: string } }): Promise<void>;
	getViewState(): { type: string };
};

export type RemindersWorkspace = {
	getLeavesOfType(type: string): RemindersLeaf[];
	getRightLeaf(split: boolean): RemindersLeaf | null;
	revealLeaf(leaf: RemindersLeaf): void | Promise<void>;
	iterateAllLeaves(callback: (leaf: RemindersLeaf) => void): void;
};

// Obsidian temporarily changes unloaded views to "empty" before restoring a
// deferred view. Keep one workspace-owned reservation across module reloads;
// a module-local WeakMap would disappear before the next plugin can reuse it.
const ACTIVATION_STATE = Symbol.for('crate.reminders-view.activation.v1');
type ActivationState = { leaf?: RemindersLeaf; pending?: Promise<void> };
type ActivationWorkspace = RemindersWorkspace & { [ACTIVATION_STATE]?: ActivationState };

function attachedReservation(workspace: RemindersWorkspace, leaf?: RemindersLeaf): RemindersLeaf | undefined {
	if (!leaf) return undefined;
	let attached = false;
	workspace.iterateAllLeaves(candidate => { if (candidate === leaf) attached = true; });
	return attached ? leaf : undefined;
}

export async function activateOrRevealRemindersLeaf(
	workspace: RemindersWorkspace,
	viewType: string,
	project?: string,
	signal?: AbortSignal,
): Promise<void> {
	// Obsidian does not expose a new leaf as this view type until setViewState
	// completes. Serialize opens so commands and automatic startup share it.
	const ownedWorkspace = workspace as ActivationWorkspace;
	const activation = ownedWorkspace[ACTIVATION_STATE] ??= {};
	const previous = activation.pending ?? Promise.resolve();
	const opening = previous.catch(() => {}).then(async () => {
		if (signal?.aborted) return;
		const existingLeaf = workspace.getLeavesOfType(viewType)[0];
		const reserved = attachedReservation(workspace, activation.leaf);
		const reservedType = reserved?.getViewState().type;
		const reusable = reservedType === viewType || reservedType === 'empty' ? reserved : undefined;
		const leaf = existingLeaf ?? reusable ?? workspace.getRightLeaf(false);
		if (!leaf) return;
		activation.leaf = leaf;

		if (!existingLeaf || project) {
			await leaf.setViewState({
				type: viewType,
				active: true,
				...(project ? { state: { project } } : {}),
			});
		}
		if (!signal?.aborted) await workspace.revealLeaf(leaf);
	});
	activation.pending = opening;
	try { await opening; }
	finally {
		if (activation.pending === opening) delete activation.pending;
	}
}
