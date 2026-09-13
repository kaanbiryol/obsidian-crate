import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

const fetchUsage = vi.fn();
vi.mock('obsidian', () => createObsidianUiModule());

import type { UsageSnapshot } from '../../cloudflare/usage-snapshot';
import { renderUsageSection } from './usage-section';

beforeEach(() => { resetObsidianUiMocks(); fetchUsage.mockReset(); });
afterEach(() => { vi.clearAllMocks(); });

function setup(snapshot: UsageSnapshot | null = null) {
	const connection = { snapshot, connected: true, needsAuthorization: false, fetchUsage, connect: vi.fn(), disconnect: vi.fn() };
	const root = new FakeElement('div');
	const cleanup = renderUsageSection(root as never, {
		settings: { cloudflareDeployment: { accountId: 'account-a' } }, cloudflareUsageConnection: connection,
	} as never);
	const actions = MockSetting.instances.find(s => s.nameEl.textContent === 'Usage metrics')!;
	return { connection, root, cleanup, actions };
}

async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

describe('usage settings', () => {
	it('only fetches on refresh through the usage connection', async () => {
		fetchUsage.mockResolvedValue([{ label: 'Workers', metrics: [{ label: 'Requests', used: 110, allowance: 100 }] }]);
		const { actions } = setup();
		expect(fetchUsage).not.toHaveBeenCalled();
		actions.buttons[0]!.click();
		await flush();
		expect(fetchUsage).toHaveBeenCalledOnce();
		expect(MockSetting.instances.find(s => s.nameEl.textContent === 'Requests')?.descEl.textContent).toContain('Estimated remaining: 0');
	});

	it('ignores a response after hiding the settings tab', async () => {
		let resolve!: (value: unknown) => void;
		fetchUsage.mockReturnValue(new Promise(r => { resolve = r; }));
		const { cleanup, actions } = setup();
		actions.buttons[0]!.click();
		cleanup();
		resolve([{ label: 'Old results', metrics: [] }]);
		await flush();
		expect(MockSetting.instances.some(s => s.nameEl.textContent === 'Old results')).toBe(false);
	});
});

it('shows the last saved numbers and their date immediately without another request', () => {
	const { actions } = setup({ accountId: 'account-a', updatedAt: Date.UTC(2026, 0, 2, 14, 32, 56), groups: [{ label: 'Workers · today (UTC)', metrics: [{ label: 'Saved requests', used: 79, allowance: 100000 }] }] });
	expect(fetchUsage).not.toHaveBeenCalled();
	expect(actions.descEl.textContent).toContain('2026-01-02 14:32:56 UTC');
	expect(actions.buttons).toHaveLength(1);
	expect(MockSetting.instances.some(s => s.nameEl.textContent === 'Workers · 2026-01-02 · since 00:00 UTC')).toBe(true);
	expect(MockSetting.instances.find(s => s.nameEl.textContent === 'Saved requests')?.descEl.textContent).toContain('Reported: 79');
});

it('reveals reconnect when refresh discovers expired authorization', async () => {
	const { connection, actions } = setup();
	const reconnect = MockSetting.instances.find(setting => setting.nameEl.textContent === 'Cloudflare connection')!;
	expect((reconnect.settingEl as unknown as HTMLElement).hidden).toBe(true);
	fetchUsage.mockImplementation(async () => { connection.needsAuthorization = true; throw new Error('Reconnect Cloudflare'); });
	actions.buttons[0]!.click();
	await flush();
	expect((reconnect.settingEl as unknown as HTMLElement).hidden).toBe(false);
});
