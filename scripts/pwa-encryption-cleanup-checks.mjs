import assert from 'node:assert/strict';

/** Native IndexedDB transactions and Web Locks, using the production storage code. */
export async function verifyEncryptedAttemptCleanup(page, grant, serverDay) {
	const result = await page.evaluate(async ({ grant, serverDay }) => {
		const t = window.crateEncryptionTest;
		const scope = t.decodeWebAppKey(grant)[0];
		const keys = await t.readReminderKeys(scope.vaultId, scope.scope.id);
		t.unlockPrivateStorage(await t.unlockLocalState(keys), keys.folderPath, localStorage, sessionStorage);
		const prefix = `${keys.vaultId}:${keys.scopeId}:`;
		const old = serverDay - 180;
		const operation = (label, day = old) => `e1_${String(day).padStart(8, '0')}_${label.padEnd(20, '_')}`;
		const ids = Object.fromEntries(['settled', 'pending', 'uncertain', 'rejected', 'damaged', 'future', 'boundary'].map(label => [label, operation(label, label === 'boundary' ? serverDay - 179 : old)]));
		const attempt = { semanticHash: 'a'.repeat(64), body: 'exact encrypted request', acknowledgment: 'saved acknowledgment' };
		for (const [label, id] of Object.entries(ids)) {
			const value = label === 'uncertain' ? { ...attempt, acknowledgment: undefined }
				: label === 'rejected' ? { ...attempt, rejected: true }
					: label === 'future' ? { ...attempt, futureField: true } : attempt;
			await t.saveEncryptedReminderAttempt(prefix + id, value, undefined, () => true);
		}
		const other = `${keys.vaultId}:other-scope:${operation('other')}`;
		await t.saveEncryptedReminderAttempt(other, attempt, undefined, () => true);
		const db = await new Promise((resolve, reject) => { const request = indexedDB.open('crate-encrypted-reminder-attempts'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
		const corrupt = db.transaction('attempts', 'readwrite'); corrupt.objectStore('attempts').put('damaged original bytes', prefix + ids.damaged);
		await new Promise((resolve, reject) => { corrupt.oncomplete = resolve; corrupt.onabort = reject; });
		const readRaw = key => new Promise((resolve, reject) => { const request = db.transaction('attempts').objectStore('attempts').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
		const pendingKey = `crate-reminder-outbox:v1:${'b'.repeat(64)}:Reminders:${ids.pending}`;
		localStorage.setItem(pendingKey, 'unreadable pending bytes from an earlier session');
		const draftKey = 'crate-reminder-draft:Reminders:cleanup-test'; sessionStorage.setItem(draftKey, 'unreadable draft');
		const prune = current => navigator.locks.request('crate-reminder-outbox', () => t.pruneEncryptedReminderAttempts(keys, serverDay, current));
		await prune(() => true);
		if (!await readRaw(prefix + ids.settled)) throw new Error('Cleanup removed an attempt while a draft might refer to it');
		sessionStorage.removeItem(draftKey);
		await prune(() => false);
		if (!await readRaw(prefix + ids.settled)) throw new Error('Stale session removed data');
		await prune(() => true);
		const remaining = {};
		for (const [label, id] of Object.entries(ids)) remaining[label] = await readRaw(prefix + id) !== undefined;
		if (await readRaw(prefix + ids.damaged) !== 'damaged original bytes' || localStorage.getItem(pendingKey) !== 'unreadable pending bytes from an earlier session') throw new Error('Recovery bytes changed during cleanup');
		remaining.other = await readRaw(other) !== undefined;
		// Removing the final queue reference makes the acknowledged, expired record collectible.
		localStorage.removeItem(pendingKey); await prune(() => true);
		remaining.pendingAfterSettlement = await readRaw(prefix + ids.pending) !== undefined;
		const isolated = { ...keys, scopeId: 'cleanup-transaction-test' };
		const batchPrefix = `${keys.vaultId}:${isolated.scopeId}:`;
		const batch = Array.from({ length: 103 }, (_, index) => batchPrefix + operation(`batch${String(index).padStart(3, '0')}`));
		for (const key of batch) await t.saveEncryptedReminderAttempt(key, attempt, undefined, () => true);
		let checks = 0;
		await t.pruneEncryptedReminderAttempts(isolated, serverDay, () => ++checks < 4);
		if (await readRaw(batch[0]) === undefined) throw new Error('Session change did not roll back an in-progress deletion');
		const cursor = await t.pruneEncryptedReminderAttempts(isolated, serverDay, () => true);
		if (!cursor || await readRaw(batch[99]) !== undefined || await readRaw(batch[100]) === undefined) throw new Error('Cleanup exceeded its bounded page');
		if (await t.pruneEncryptedReminderAttempts(isolated, serverDay, () => true, cursor) !== undefined || await readRaw(batch[102]) !== undefined) throw new Error('Cleanup failed to finish the next page');
		// Keep synthetic quarantine entries out of the rest of the test scenario.
		const tx = db.transaction('attempts', 'readwrite');
		for (const id of Object.values(ids)) tx.objectStore('attempts').delete(prefix + id);
		tx.objectStore('attempts').delete(other);
		await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; }); db.close();
		return remaining;
	}, { grant, serverDay });
	assert.deepEqual(result, { settled: false, pending: true, uncertain: true, rejected: true, damaged: true, future: true, boundary: true, other: true, pendingAfterSettlement: false });
}
