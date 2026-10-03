import assert from 'node:assert/strict';

export async function verifyBlockedEncryptionStorage(page) {
	const result = await page.evaluate(async () => {
		const t = window.encryptionStorageTest;
		const bundle = t.addReminderScope(t.createVaultKeyBundle(), 'Reminders');
		const grant = t.createReminderKeyGrant(bundle, 'Reminders');
		const keys = await t.rememberReminderKeys(grant);
		const cipher = await t.unlockLocalState(keys);
		t.unlockPrivateStorage(cipher, 'Reminders', localStorage, sessionStorage);
		const key = `${grant.vaultId}:${grant.scope.id}`, attemptKey = `${key}:blocked-attempt`;
		const attempt = { semanticHash: 'a'.repeat(64), body: 'Preserve this exact request' };
		await t.saveEncryptedReminderAttempt(attemptKey, attempt, undefined, () => true);
		const draft = cipher.seal('Preserve this draft', 'blocked-draft');
		sessionStorage.setItem('crate-reminder-draft:Reminders:blocked', draft);
		const notice = (await t.createReminderProjection(bundle, 'Reminders/Inbox.md', new TextEncoder().encode('- [ ] Private push 2099-01-02 <!-- crate-id:blocked -->').buffer)).reminders[0].notification;
		const databases = [['crate-encryption-keys', 'keys'], ['crate-encrypted-reminder-attempts', 'attempts']];
		const open = (name, version, upgrade) => new Promise((resolve, reject) => {
			const request = indexedDB.open(name, version);
			request.onupgradeneeded = event => upgrade?.(request.result, event);
			request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
		});
		const read = (db, store, key) => new Promise((resolve, reject) => {
			const request = db.transaction(store).objectStore(store).get(key);
			request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
		});
		const blockers = await Promise.all(databases.map(([name]) => open(name, 1)));
		const originalAttempt = await read(blockers[1], 'attempts', attemptKey);
		const deletions = [];
		try {
			for (const [name] of databases) {
				// Real native requests queue behind a blocked deletion. Unlike a mock
				// open, this also exercises the browser's eventual upgrade/success events.
				const request = indexedDB.deleteDatabase(name);
				deletions.push(new Promise((resolve, reject) => { request.onsuccess = resolve; request.onerror = () => reject(request.error); }));
				await new Promise(resolve => { request.onblocked = resolve; });
			}
			localStorage.setItem(t.AUTH_TOKEN_KEY, 'blocked-session');
			const scoped = { version: 1, vaultId: grant.vaultId, generation: grant.generation, mode: 'active', scope: {
				id: grant.scope.id, folderPath: 'Reminders', keyId: grant.scope.data.id, notificationKeyId: grant.scope.notifications.id,
			} };
			const rejectBlocked = promise => promise.then(() => { throw new Error('Blocked storage was treated as available or empty'); }, error => {
				if (!error.message.includes('Close other Crate tabs and retry')) throw error;
			});
			let timer;
			try {
				await Promise.race([
					Promise.all([
						rejectBlocked(t.readReminderKeys(grant.vaultId, grant.scope.id)),
						rejectBlocked(t.rememberReminderKeys(grant)),
						rejectBlocked(t.clearReminderKeys(() => true)),
						rejectBlocked(t.loadEncryptedReminderAttempt(attemptKey)),
						rejectBlocked(t.saveEncryptedReminderAttempt(attemptKey, { ...attempt, body: 'Must not commit late' }, attempt, () => true)),
						rejectBlocked(t.clearEncryptedReminderAttempts(() => true)),
						rejectBlocked(t.preparePwaEncryption('blocked-session', async () => Response.json({ encryption: scoped }))),
						t.decryptPushDisplay(notice).then(display => { if (display !== null) throw new Error('Blocked push did not use the generic fallback'); }),
					]),
					new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Blocked encrypted storage did not settle')), 6000); }),
				]);
			} finally { clearTimeout(timer); }
			if (t.encryptionSnapshot().status !== 'locked') throw new Error('Bootstrap did not leave checking with a recoverable error');
			if ((await read(blockers[0], 'keys', key)).localState !== keys.localState || await read(blockers[1], 'attempts', attemptKey) !== originalAttempt) throw new Error('Failed storage operation changed private bytes');
			if (sessionStorage.getItem('crate-reminder-draft:Reminders:blocked') !== draft) throw new Error('Failed startup erased the draft');
		} finally { blockers.forEach(db => db.close()); }
		await Promise.all(deletions);
		// These explicit test deletions removed the old databases. Timed-out opens
		// must abort late creation, leaving no stores or enrollment writes behind.
		for (const [name, store] of databases) {
			let fresh = false;
			const db = await open(name, 1, (db, event) => { fresh = event.oldVersion === 0; db.createObjectStore(store); });
			if (!fresh || await read(db, store, store === 'keys' ? key : attemptKey) !== undefined) throw new Error('An abandoned open created or wrote private storage');
			db.close();
		}
		await t.rememberReminderKeys(grant);
		if ((await t.decryptPushDisplay(notice))?.title !== 'Private push') throw new Error('Push decryption did not recover after unblocking');
		t.resetPwaEncryption(true);
		// A newer database must survive attempts to read, enroll, or erase it.
		for (const [name, store] of databases) {
			const db = await open(name, 2, db => db.createObjectStore('future'));
			db.close();
			const rejected = promise => promise.then(() => { throw new Error('Future database was accepted'); }, error => {
				if (!error.message.includes('unsupported format')) throw error;
			});
			if (store === 'keys') {
				await rejected(t.rememberReminderKeys(grant)); await rejected(t.clearReminderKeys(() => true));
			} else {
				await rejected(t.loadEncryptedReminderAttempt(attemptKey)); await rejected(t.clearEncryptedReminderAttempts(() => true));
			}
			const preserved = await open(name, 2);
			if (!preserved.objectStoreNames.contains('future')) throw new Error('Future store was removed');
			if (store === 'keys' && !(await read(preserved, store, key))) throw new Error('Future keys were erased');
			preserved.close();
		}
		return { bounded: true, fallback: true, preserved: true, lateOpensFenced: true, recovered: true };
	});
	assert.deepEqual(result, { bounded: true, fallback: true, preserved: true, lateOpensFenced: true, recovered: true });
}
