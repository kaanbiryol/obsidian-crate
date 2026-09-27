// Features share one browser history. Creating either detail stack replaces the
// current entry, so a saved slot from the other feature loses its predecessor.
// State survives reloads too; only the latest stack in this document is reusable.
let documentStackId: string | null = null;

export function isCurrentDetailStack(stackId: string | undefined): boolean {
	return Boolean(stackId && stackId === documentStackId);
}

export function createDetailStack(): string {
	documentStackId = crypto.randomUUID();
	return documentStackId;
}
