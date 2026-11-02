import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import { SECRET_KEYS } from '../../platform/secret-keys';

// Obsidian's text helper, which the shared fake element lacks.
Object.assign(FakeElement.prototype, { appendText(this: FakeElement, text: string) { this.createSpan({ text }); } });

// Pairing screens poll only while visible, like Connect web app.
const page = { hidden: true };
const listTokens = vi.fn(async () => ({ tokens: [] }));
const readEncryption = vi.fn(async () => null);

beforeEach(() => {
	resetObsidianUiMocks(); listTokens.mockClear(); readEncryption.mockClear();
	page.hidden = true;
	vi.useFakeTimers();
	vi.stubGlobal('window', { setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: number) => clearTimeout(id) });
	vi.stubGlobal('document', page);
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../plugin/shared-modal', async () => ({ ...await vi.importActual<typeof import('../plugin/shared-modal')>('../plugin/shared-modal'), SharedModal: class {
		modalEl = new FakeElement('div');
		contentEl = new FakeElement('div');
		bodyEl = this.contentEl.createDiv();
		openLayout() {}
		setLayoutTitle() {}
		onClose() {}
		close() { this.onClose(); }
	} }));
	vi.doMock('../qr-modal', () => ({ renderQrCode: () => {} }));
	vi.doMock('../../sync/encryption/server-encryption', () => ({ readServerEncryption: readEncryption }));
});
afterEach(() => {
	vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules();
	for (const name of ['obsidian', '../plugin/shared-modal', '../qr-modal', '../../sync/encryption/server-encryption']) vi.doUnmock(name);
});

const plugin = () => ({
	app: {},
	settings: { workerUrl: 'https://crate-0123456789abcdef.example.workers.dev' },
	secretStorage: { get: (key: string) => key === SECRET_KEYS.AUTH_TOKEN ? 'token' : null },
	cloudflareSavedLogin: { withAuthorization: (operation: (tokens: unknown) => unknown) => operation({}) },
	cloudflareDeploymentService: { issueDevicePairing: async () => ({ code: 'c'.repeat(64), tokenId: 'a'.repeat(32), expiresAt: Date.now() + 600_000 }) },
	syncRuntime: { getApiClient: () => ({ listTokens }) },
	refreshSettingsTab: () => {},
});

it('Add a device checks for the new device only while visible', async () => {
	const { AddDeviceModal } = await import('./add-device-modal');
	const modal = new AddDeviceModal(plugin() as never);
	modal.onOpen();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(listTokens).not.toHaveBeenCalled();
	page.hidden = false;
	await vi.advanceTimersByTimeAsync(2_500);
	expect(listTokens).toHaveBeenCalled();
	modal.onClose();
});

it('Unlock this vault requests keys only while visible', async () => {
	const { DeviceKeyPairingModal } = await import('./device-key-pairing-modal');
	const modal = new DeviceKeyPairingModal(plugin() as never);
	modal.onOpen();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(readEncryption).not.toHaveBeenCalled();
	page.hidden = false;
	await vi.advanceTimersByTimeAsync(2_500);
	expect(readEncryption).toHaveBeenCalled();
	modal.onClose();
});
