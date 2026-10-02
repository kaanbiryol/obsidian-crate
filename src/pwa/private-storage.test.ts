import { afterEach, expect, it } from 'vitest';
import { LocalStateCipher } from '../encryption/local-state';
import { lockPrivateStorage, requirePrivateStorageUnlock, unlockPrivateStorage, privateStorage } from './private-storage';

function storage(): Storage {
	const map = new Map<string, string>();
	return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, clear: () => map.clear(),
		getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } };
}
afterEach(() => lockPrivateStorage());
const key = 'crate-reminder-outbox:v1:session:Reminders:operation';
const secret = crypto.getRandomValues(new Uint8Array(32));
const cipher = () => new LocalStateCipher('vault', 'scope', secret);

it('encrypts drafts and exact saved commands before dispatch, preserving other folders', () => {
	const local = storage(), session = storage();
	const saved = '{"body":"exact private request","ambiguous":true}';
	local.setItem(key, saved); local.setItem(key.replace(':Reminders:', ':Other:'), 'different scope');
	session.setItem('crate-reminder-draft:Reminders:new', 'unsaved draft');
	requirePrivateStorageUnlock(); unlockPrivateStorage(cipher(), 'Reminders', local, session);
	expect(local.getItem(key)).not.toContain('private request');
	expect(session.getItem('crate-reminder-draft:Reminders:new')).not.toContain('unsaved');
	expect(privateStorage(local).getItem(key)).toBe(saved);
	expect(local.getItem(key.replace(':Reminders:', ':Other:'))).toBe('different scope');
	privateStorage(local).setItem(key, 'next exact body');
	lockPrivateStorage();
	expect(() => privateStorage(local).setItem(key, 'plaintext')).toThrow('Unlock');
	expect(privateStorage(local).getItem(key)).toBe(local.getItem(key));
	unlockPrivateStorage(cipher(), 'Reminders', local, session);
	expect(privateStorage(local).getItem(key)).toBe('next exact body');
});

it('can resume a partial quota failure without replacing already encrypted commands', () => {
	const local = storage(), session = storage();
	local.setItem(key, 'first'); local.setItem(key + '-2', 'second');
	const set = local.setItem.bind(local);
	local.setItem = (name, value) => { if (name.endsWith('-2')) throw new Error('Quota'); set(name, value); };
	requirePrivateStorageUnlock();
	expect(() => unlockPrivateStorage(cipher(), 'Reminders', local, session)).toThrow('Quota');
	const encrypted = local.getItem(key);
	expect(local.getItem(key + '-2')).toBe('second');
	local.setItem = set;
	unlockPrivateStorage(cipher(), 'Reminders', local, session);
	expect(local.getItem(key)).toBe(encrypted);
	expect(privateStorage(local).getItem(key + '-2')).toBe('second');
});

it('preserves corrupt and substituted ciphertext for recovery without treating it as a command', () => {
	const local = storage();
	unlockPrivateStorage(cipher(), 'Reminders', local, storage());
	privateStorage(local).setItem(key, 'private');
	local.setItem(key + '-other', local.getItem(key)!);
	expect(privateStorage(local).getItem(key + '-other')).toBe(local.getItem(key));
	expect(privateStorage(local).getItem(key + '-other')).not.toBe('private');
});
