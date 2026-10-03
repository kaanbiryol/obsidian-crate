import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement, MockSetting, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import { SECRET_KEYS } from '../../plugin/settings-types';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import { createEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import type { EncryptionProgress } from '../../sync/encryption-conversion';

let state: EncryptionServerState | null;
let body: FakeElement;
let titles: string[];
let closeModal: () => void;
let values: Map<string, string>;
const read = vi.fn(async (): Promise<EncryptionServerState | null> => state);
const folders = vi.fn(async () => ({ folders: ['Reminders'] }));
const convert = vi.fn(async (_http: unknown, keys: VaultKeyBundle, recovery: string, _progress: EncryptionProgress) => {
	state = { ...createEncryptionState(keys, await sealRecoveryBundle(keys, recovery)), mode: 'active' };
});
const turnOff = vi.fn(async () => {});
const sync = vi.fn(async () => ({ success: true, conflicts: [] }));
const setting = (name: string) => [...MockSetting.instances].reverse().find(item => item.nameEl.textContent === name)!;

beforeEach(() => {
	resetObsidianUiMocks(); convert.mockClear(); sync.mockClear(); turnOff.mockClear();
	read.mockReset().mockImplementation(async () => state);
	folders.mockReset().mockImplementation(async () => ({ folders: ['Reminders'] }));
	state = null; titles = []; values = new Map([[SECRET_KEYS.AUTH_TOKEN, 'token']]);
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../shared/SharedModal', () => ({ SharedModal: class {
		modalEl = new FakeElement('div');
		bodyEl = body = new FakeElement('div');
		openLayout(title: string) { titles.push(title); }
		setLayoutTitle(title: string) { titles.push(title); }
		onOpen() {}
		onClose() {}
		close() { this.onClose(); }
		open() { closeModal = () => this.close(); this.onOpen(); }
	} }));
	vi.doMock('../../sync/worker-api/http', () => ({ WorkerApiHttpClient: class {
		constructor(private readonly url: string) {}
		setAbortSignal() {}
		getWorkerUrl() { return this.url; }
		getServerInfo() { return Promise.resolve({ capabilities: ['e2ee-reading-v1'] }); }
		requestJson = folders;
	} }));
	vi.doMock('../../sync/encryption-conversion', async () => ({
		...await vi.importActual('../../sync/encryption-conversion'),
		readServerEncryption: read,
		convertEncryptedVault: convert,
	}));
});
afterEach(() => {
	vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
	for (const name of ['obsidian', '../shared/SharedModal', '../../sync/worker-api/http', '../../sync/encryption-conversion']) vi.doUnmock(name);
});

async function renderRow() {
	const { renderEncryptionSection } = await import('./encryption-section');
	const plugin = { app: {}, settings: { workerUrl: 'https://server.test', automaticSync: false, reading: { folderPath: 'Reading' } }, remindersSettings: { remindersFolderPath: 'Reminders' },
		secretStorage: { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => values.set(key, value) },
		syncRuntime: { sync, turnOffEncryption: turnOff, runEncryptionSetup: async (work: () => Promise<void>) => work() } };
	const cleanup = renderEncryptionSection(new FakeElement('div') as never, plugin as never);
	const row = setting('End-to-end encryption');
	return { plugin, cleanup, row, button: row.buttons[0]! };
}
async function open() {
	const { plugin, button } = await renderRow();
	await vi.waitFor(() => expect(button.buttonEl.classNames.has('is-disabled')).toBe(false));
	button.click();
	await vi.waitFor(() => expect(body.getAttribute('aria-busy')).toBe('false'));
	return plugin;
}
async function configure(mode: 'active' | 'converting') {
	const keys = addReminderScope(createVaultKeyBundle(), 'Reminders'), recovery = await generateRecoveryCode();
	state = { ...createEncryptionState(keys, await sealRecoveryBundle(keys, recovery)), mode };
	values.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(keys)); values.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery);
	return recovery;
}
function acknowledge(saved = true) {
	const checkbox = body.querySelector('input') as FakeElement & { checked: boolean };
	checkbox.checked = saved;
	checkbox.dispatchEvent(new Event('change'));
}

it.each(['off', 'active', 'converting'] as const)('keeps the settings row unchanged when dismissing the %s dialog', async mode => {
	if (mode !== 'off') await configure(mode);
	await open();
	const expectedTitle = mode === 'off' ? 'Enable encryption' : mode === 'converting' ? 'Resume encryption' : 'Manage encryption';
	expect(titles).toEqual([expectedTitle, expectedTitle]);
	const row = setting('End-to-end encryption'), button = row.buttons[0]!;
	const description = row.descEl.collectText(), label = button.buttonEl.textContent;
	expect(read).toHaveBeenCalledTimes(2);
	closeModal();
	expect(row.descEl.collectText()).toBe(description);
	expect(button.buttonEl.textContent).toBe(label);
	expect(button.buttonEl.classNames.has('is-disabled')).toBe(false);
	expect(read).toHaveBeenCalledTimes(2);
	expect(convert).not.toHaveBeenCalled(); expect(turnOff).not.toHaveBeenCalled();
});

it('keeps the settings row unchanged when opening and cancelling the reset dialog', async () => {
	await configure('active'); await open();
	const row = setting('End-to-end encryption'), button = row.buttons[0]!;
	setting('Turn off encryption').buttons[0]!.click();
	expect(button.buttonEl.textContent).toBe('Manage encryption');
	closeModal();
	expect(row.descEl.querySelector('strong')?.textContent).toBe('On');
	expect(button.buttonEl.textContent).toBe('Manage encryption');
	expect(button.buttonEl.classNames.has('is-disabled')).toBe(false);
	expect(read).toHaveBeenCalledTimes(2);
	expect(turnOff).not.toHaveBeenCalled();
});

it('automatically verifies the key and requires acknowledgment before setup', async () => {
	const check = vi.spyOn(await import('../../encryption/recovery-verification'), 'verifyRecoveryCode');
	await open();
	const start = setting('Enable encryption').buttons[0]!;
	expect(start.buttonEl.textContent).toBe('Enable encryption');
	expect(start.buttonEl.classNames.has('is-disabled')).toBe(true);
	start.click();
	expect(convert).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
	const generated = (body.querySelector('textarea') as FakeElement & { value: string }).value;
	expect(check).toHaveBeenCalledWith(expect.any(Object), generated, expect.any(Object));
	expect(setting('Saved recovery key')).toBeUndefined();
	acknowledge();
	expect(start.buttonEl.classNames.has('is-disabled')).toBe(false);
	acknowledge(false); start.click();
	expect(start.buttonEl.classNames.has('is-disabled')).toBe(true);
	expect(convert).not.toHaveBeenCalled();
	acknowledge(); start.click();
	await vi.waitFor(() => expect(body.collectText()).toContain('Your vault is protected'));
	expect(titles.at(-1)).toBe('Encryption enabled');
	expect(convert).toHaveBeenCalledOnce(); expect(sync).not.toHaveBeenCalled();
	expect(body.collectText()).toContain('Automatic sync remains off');
	expect(body.querySelector('textarea')).toBeNull();
	expect(values.get(SECRET_KEYS.ENCRYPTION_RECOVERY)).toBe(generated);
	await vi.waitFor(() => expect(setting('End-to-end encryption').descEl.collectText()).toContain('On'));
	expect(setting('End-to-end encryption').buttons[0]!.buttonEl.textContent).toBe('Manage encryption');
	MockSetting.instances.at(-1)!.buttons[0]!.click();
	await vi.waitFor(() => expect(body.collectText()).toContain('Encryption on'));
});

it('replaces setup with counted progress, uses indeterminate stages, and preserves automatic sync', async () => {
	const plugin = await open(); plugin.settings.automaticSync = true;
	let finish!: () => void, progress!: EncryptionProgress;
	convert.mockImplementationOnce(async (_http, keys, recovery, update) => {
		progress = update; update('Encrypting files and retained versions', { completed: 0, total: 12 });
		await new Promise<void>(resolve => { finish = resolve; });
		state = { ...createEncryptionState(keys, await sealRecoveryBundle(keys, recovery)), mode: 'active' };
	});
	acknowledge(); setting('Enable encryption').buttons[0]!.click();
	await vi.waitFor(() => expect(body.collectText()).toContain('0 of 12 files and versions'));
	expect(body.querySelector('textarea')).toBeNull(); expect(body.querySelector('input')).toBeNull();
	expect(body.querySelector('progress')?.getAttribute('value')).toBe('0');
	progress('Encrypting files and retained versions', { completed: 3, total: 12 });
	expect(body.collectText()).toContain('3 of 12 files and versions');
	expect(body.querySelector('progress')?.getAttribute('value')).toBe('3');
	progress('Encrypting files and retained versions', { completed: 3 });
	expect(body.collectText()).toContain('3 files and versions encrypted');
	expect(body.querySelector('progress')?.getAttribute('value')).toBeNull();
	progress('Encrypting shared settings');
	expect(body.querySelector('progress')?.getAttribute('value')).toBeNull();
	expect(body.collectText()).not.toContain('3 of 12');
	finish();
	await vi.waitFor(() => expect(body.collectText()).toContain('Automatic sync remains on'));
	expect(body.querySelector('progress')).toBeNull();
	expect(plugin.settings.automaticSync).toBe(true); expect(sync).not.toHaveBeenCalled();
});

it('retries an interrupted conversion with the same keys without starting a normal sync', async () => {
	await open();
	convert.mockRejectedValueOnce(new Error('Connection lost'));
	acknowledge(); setting('Enable encryption').buttons[0]!.click();
	await vi.waitFor(() => expect(body.collectText()).toContain('Connection lost'));
	expect(titles.at(-1)).toBe('Encryption needs attention');
	expect(body.querySelector('textarea')).toBeNull();
	MockSetting.instances.at(-1)!.buttons[0]!.click();
	await vi.waitFor(() => expect(body.collectText()).toContain('Your vault is protected'));
	expect(convert.mock.calls[1]![1]).toBe(convert.mock.calls[0]![1]);
	expect(convert.mock.calls[1]![2]).toBe(convert.mock.calls[0]![2]);
	expect(sync).not.toHaveBeenCalled();
});

it('does not offer conversion when the automatic key check fails', async () => {
	vi.spyOn(await import('../../encryption/recovery-verification'), 'verifyRecoveryCode').mockRejectedValueOnce(new Error('Recovery verification failed'));
	await open();
	expect(body.collectText()).toContain('Recovery verification failed');
	expect(body.querySelector('textarea')).toBeNull();
	expect(setting('Enable encryption')).toBeUndefined();
	expect(convert).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
	expect(values.has(SECRET_KEYS.ENCRYPTION_KEYS)).toBe(false);
});

it('keeps the loading placeholder until server and recovery preparation finish', async () => {
	const { button } = await renderRow();
	await vi.waitFor(() => expect(button.buttonEl.textContent).toBe('Enable encryption'));
	let finishState!: (value: EncryptionServerState | null) => void;
	let finishFolders!: (value: { folders: string[] }) => void;
	read.mockImplementationOnce(() => new Promise(resolve => { finishState = resolve; }));
	folders.mockImplementationOnce(() => new Promise(resolve => { finishFolders = resolve; }));
	button.click();
	expect(titles).toEqual(['Enable encryption']);
	expect(body.getAttribute('aria-busy')).toBe('true');
	expect(body.collectText()).toContain('Loading encryption settings');
	finishState(null);
	await vi.waitFor(() => expect(folders).toHaveBeenCalledOnce());
	expect(titles).toEqual(['Enable encryption', 'Enable encryption']);
	expect(body.getAttribute('aria-busy')).toBe('true');
	expect(body.querySelector('.crate-encryption-placeholder')).not.toBeNull();
	expect(body.querySelector('textarea')).toBeNull();
	finishFolders({ folders: ['Reminders'] });
	await vi.waitFor(() => expect(body.getAttribute('aria-busy')).toBe('false'));
	expect(body.querySelector('.crate-encryption-placeholder')).toBeNull();
	expect(body.querySelector('textarea')).not.toBeNull();
});

it('replaces loading with a retryable error and clears its busy state', async () => {
	const { button } = await renderRow();
	await vi.waitFor(() => expect(button.buttonEl.textContent).toBe('Enable encryption'));
	read.mockRejectedValueOnce(new Error('Offline'));
	button.click();
	await vi.waitFor(() => expect(body.collectText()).toContain('Encryption status unavailable'));
	expect(body.getAttribute('aria-busy')).toBe('false');
	expect(body.querySelector('.crate-encryption-placeholder')).toBeNull();
	MockSetting.instances.at(-1)!.buttons[0]!.click();
	expect(body.getAttribute('aria-busy')).toBe('true');
	await vi.waitFor(() => expect(body.querySelector('textarea')).not.toBeNull());
	expect(body.getAttribute('aria-busy')).toBe('false');
});

it('resumes using the automatically verified local recovery key after acknowledgment', async () => {
	const recovery = await configure('converting');
	await open();
	const resume = setting('Resume encryption').buttons[0]!;
	resume.click(); expect(convert).not.toHaveBeenCalled();
	acknowledge(); resume.click();
	await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(setting('End-to-end encryption').buttons[0]!.buttonEl.textContent).toBe('Manage encryption'));
	expect(values.get(SECRET_KEYS.ENCRYPTION_RECOVERY)).toBe(recovery);
	expect(sync).not.toHaveBeenCalled();
});

it('refreshes the row after an interrupted conversion so it can be resumed', async () => {
	await open();
	convert.mockImplementationOnce(async (_http, keys, recovery) => {
		state = { ...createEncryptionState(keys, await sealRecoveryBundle(keys, recovery)), mode: 'converting' };
		throw new Error('Connection lost');
	});
	acknowledge(); setting('Enable encryption').buttons[0]!.click();
	await vi.waitFor(() => expect(setting('End-to-end encryption').buttons[0]!.buttonEl.textContent).toBe('Resume conversion'));
	expect(setting('End-to-end encryption').descEl.querySelector('strong')?.textContent).toBe('Converting…');
	expect(read).toHaveBeenCalledTimes(3);
	closeModal();
	expect(read).toHaveBeenCalledTimes(3);
});

it.each(['missing', 'damaged', 'wrong'] as const)('restores the saved copy when the local recovery key is %s', async kind => {
	const recovery = await configure('converting');
	if (kind === 'missing') values.delete(SECRET_KEYS.ENCRYPTION_RECOVERY);
	else values.set(SECRET_KEYS.ENCRYPTION_RECOVERY, kind === 'damaged' ? 'damaged saved copy' : await generateRecoveryCode());
	await open();
	expect(body.collectText()).toContain('saved copy before resuming encryption');
	expect(setting('Resume encryption')).toBeUndefined();
	expect(convert).not.toHaveBeenCalled();
	setting('Recovery key').texts[0]!.change(recovery);
	MockSetting.instances.at(-1)!.buttons[0]!.click();
	await vi.waitFor(() => expect(setting('Resume encryption')).toBeDefined());
	expect(values.get(SECRET_KEYS.ENCRYPTION_RECOVERY)).toBe(recovery);
	acknowledge(); setting('Resume encryption').buttons[0]!.click();
	await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(setting('End-to-end encryption').buttons[0]!.buttonEl.textContent).toBe('Manage encryption'));
	expect(sync).not.toHaveBeenCalled();
});

it('reports active keys and offers recovery when this device has damaged keys', async () => {
	await configure('active'); await open();
	expect(body.collectText()).toContain('Unlocked on this device');
	expect(setting('Recovery key').descEl.textContent).toContain('Keep a copy for recovery.');
	values.set(SECRET_KEYS.ENCRYPTION_KEYS, 'invalid json');
	await open();
	await vi.waitFor(() => expect(setting('This device').descEl.textContent).toContain('Locked'));
	expect(setting('Notification keys').descEl.textContent).toContain('Unavailable');
	expect(body.collectText()).toContain('Unlock vault');
});


it('requires typed data-loss confirmation before starting the destructive reset', async () => {
	await configure('active');
	const plugin = await open();
	setting('Turn off encryption').buttons[0]!.click();
	expect(body.collectText()).toContain('Files that exist only on the server will be lost');
	expect(body.collectText()).toContain('Existing backup copies stay as they are');
	const action = MockSetting.instances.at(-1)!.buttons[0]!;
	expect(action.buttonEl.classNames.has('is-disabled')).toBe(true);
	action.click(); expect(turnOff).not.toHaveBeenCalled();
	setting('Confirm data loss').texts[0]!.change('reset');
	expect(action.buttonEl.classNames.has('is-disabled')).toBe(false);
	action.click();
	await vi.waitFor(() => expect(turnOff).toHaveBeenCalledWith(state, expect.any(Function),
		{ workerUrl: plugin.settings.workerUrl, authToken: 'token' }, expect.any(AbortSignal)));
});

it('opens the saved reset directly without requiring the now-revoked old credential', async () => {
	await configure('active');
	const plugin = await open();
	values.set(SECRET_KEYS.ENCRYPTION_RESET, 'saved checkpoint');
	read.mockClear();
	const { renderEncryptionSection } = await import('./encryption-section');
	renderEncryptionSection(new FakeElement('div') as never, plugin as never);
	expect(setting('End-to-end encryption').descEl.collectText()).toContain('Reset in progress');
	expect(setting('End-to-end encryption').buttons[0]!.buttonEl.textContent).toBe('Resume reset');
	expect(read).not.toHaveBeenCalled();
	setting('End-to-end encryption').buttons[0]!.click();
	const action = MockSetting.instances.at(-1)!.buttons[0]!;
	expect(action.buttonEl.textContent).toBe('Resume reset');
	action.click();
	await vi.waitFor(() => expect(turnOff).toHaveBeenCalledWith(null, expect.any(Function), expect.any(Object), expect.any(AbortSignal)));
});

it.each([
	['off', 'Off', 'Enable encryption'],
	['active', 'On', 'Manage encryption'],
	['converting', 'Converting…', 'Resume conversion'],
	['resetting', 'Reset in progress', 'View reset'],
] as const)('shows the server’s %s state and its matching action without changing encryption', async (mode, status, action) => {
	if (mode !== 'off') {
		await configure('active');
		state = { ...state!, mode };
	}
	values.delete(SECRET_KEYS.ENCRYPTION_KEYS);
	const { row, button } = await renderRow();
	await vi.waitFor(() => expect(button.buttonEl.textContent).toBe(action));
	expect(row.descEl.querySelector('strong')?.textContent).toBe(status);
	expect(read).toHaveBeenCalledOnce();
	expect(convert).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(turnOff).not.toHaveBeenCalled();
});

it('reports failed checks as unknown and allows retry without treating missing local keys as off', async () => {
	await configure('active'); values.delete(SECRET_KEYS.ENCRYPTION_KEYS);
	read.mockRejectedValueOnce(new Error('Offline'));
	const { row, button } = await renderRow();
	await vi.waitFor(() => expect(button.buttonEl.textContent).toBe('Retry'));
	expect(row.descEl.querySelector('strong')?.textContent).toBe('Status unavailable');
	button.click();
	await vi.waitFor(() => expect(button.buttonEl.textContent).toBe('Manage encryption'));
	expect(row.descEl.querySelector('strong')?.textContent).toBe('On');
});

it.each(['url', 'token'] as const)('rejects an encryption status read after the connection %s changes', async field => {
	let finish!: (value: EncryptionServerState | null) => void;
	read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const { plugin, row, button } = await renderRow();
	expect(button.buttonEl.classNames.has('is-disabled')).toBe(true);
	if (field === 'url') plugin.settings.workerUrl = 'https://another.test';
	else values.set(SECRET_KEYS.AUTH_TOKEN, 'another-token');
	finish(null);
	await vi.waitFor(() => expect(button.buttonEl.textContent).toBe('Retry'));
	expect(row.descEl.querySelector('strong')?.textContent).toBe('Status unavailable');
});

it.each(['settings closed', 'plugin unloaded'] as const)('ignores late status reads after %s', async reason => {
	let finish!: (value: EncryptionServerState | null) => void;
	read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const { plugin, cleanup, row, button } = await renderRow();
	if (reason === 'settings closed') cleanup();
	else (await import('../../plugin/lifecycle-state')).endPluginLifecycle(plugin as never);
	finish(null);
	await Promise.resolve(); await Promise.resolve();
	expect(row.descEl.querySelector('strong')?.textContent).toBe('Checking…');
	expect(button.buttonEl.classNames.has('is-disabled')).toBe(true);
});

it('refreshes the row once after turning encryption off', async () => {
	await configure('active'); await open();
	turnOff.mockImplementationOnce(async () => { state = null; values.delete(SECRET_KEYS.ENCRYPTION_RESET); });
	setting('Turn off encryption').buttons[0]!.click();
	const action = MockSetting.instances.at(-1)!.buttons[0]!;
	setting('Confirm data loss').texts[0]!.change('reset'); action.click();
	await vi.waitFor(() => expect(setting('End-to-end encryption').buttons[0]!.buttonEl.textContent).toBe('Enable encryption'));
	expect(setting('End-to-end encryption').descEl.querySelector('strong')?.textContent).toBe('Off');
	expect(read).toHaveBeenCalledTimes(3);
});


it('copies one recovery key for Obsidian and the web app and rejects a stale server connection', async () => {
	const keys = addReminderScope(addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading'), 'Other');
	const recovery = await generateRecoveryCode();
	state = { ...createEncryptionState(keys, await sealRecoveryBundle(keys, recovery)), mode: 'active' };
	values.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(keys)); values.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery);
	const writeText = vi.fn(async (_value: string) => {});
	vi.stubGlobal('navigator', { clipboard: { writeText } });
	const plugin = await open();
	expect(body.collectText()).toContain('Connect without copying keys.');
	expect(body.collectText()).not.toContain('Web app key');
	expect(body.collectText()).not.toContain('Individual folder keys');
	expect(body.collectText()).not.toContain('older web apps');
	setting('Recovery key').buttons[0]!.click();
	await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
	expect(writeText).toHaveBeenCalledWith(recovery);
	await vi.waitFor(() => expect(setting('Recovery key').buttons[0]!.buttonEl.textContent).toBe('Copied'));
	plugin.settings.workerUrl = 'https://other.test';
	setting('Recovery key').buttons[0]!.click();
	await vi.waitFor(() => expect(body.collectText()).toContain('connection changed'));
	expect(writeText).toHaveBeenCalledOnce();
});
