/** Roll back an IndexedDB transaction and wait until it settles. Aborting a
 * transaction that already finished throws InvalidStateError, which callers
 * ignore along with the rejection of its `done` promise. */
export async function abortTransaction(tx: { abort(): void; readonly done: Promise<void> }): Promise<void> {
	try { tx.abort(); } catch { /* The transaction may already have finished. */ }
	await tx.done.catch(() => {});
}
