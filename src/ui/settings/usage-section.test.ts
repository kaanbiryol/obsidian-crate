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
		const { actions, root } = setup();
		expect(fetchUsage).not.toHaveBeenCalled();
		actions.buttons[0]!.click();
		await flush();
		expect(fetchUsage).toHaveBeenCalledOnce();
		expect(root.collectText()).toContain('Free allowance exceeded');
		expect(root.collectText()).toContain('110% used');
	});

	it('ignores a response after hiding the settings tab', async () => {
		let resolve!: (value: unknown) => void;
		fetchUsage.mockReturnValue(new Promise(r => { resolve = r; }));
		const { cleanup, actions, root } = setup();
		actions.buttons[0]!.click();
		cleanup();
		resolve([{ label: 'Old results', metrics: [] }]);
		await flush();
		expect(root.collectText()).not.toContain('Old results');
	});
});

it('shows the last saved numbers and their date immediately without another request', () => {
	const { actions, root } = setup({ accountId: 'account-a', updatedAt: Date.UTC(2026, 0, 2, 14, 32, 56), groups: [{ label: 'Workers · today (UTC)', metrics: [{ label: 'Saved requests', used: 79, allowance: 100000 }] }] });
	expect(fetchUsage).not.toHaveBeenCalled();
	expect(actions.descEl.textContent).toContain('2026-01-02 14:32:56 UTC');
	expect(actions.buttons).toHaveLength(1);
	expect(root.querySelector('.crate-usage-period')?.textContent).toBe('2026-01-02 · UTC');
	expect(root.querySelector('.crate-usage-metric-footer')?.collectText()).not.toContain('remaining');
	expect(root.querySelector('progress')?.attributes.get('aria-label')).toContain('reported usage 79 of 100,000');
});

it('points to the single reconnect action when refresh discovers expired authorization', async () => {
	const { connection, actions, root } = setup();
	expect(MockSetting.instances.some(setting => setting.nameEl.textContent === 'Cloudflare connection')).toBe(false);
	fetchUsage.mockImplementation(async () => { connection.needsAuthorization = true; throw new Error('Reconnect Cloudflare'); });
	actions.buttons[0]!.click();
	await flush();
	expect(root.collectText()).toContain('Select Reconnect under Account and devices');
});

it('retains monthly periods and unavailable data without implying zero usage', () => {
	const { root } = setup({ accountId: 'account-a', updatedAt: Date.UTC(2026, 0, 2), groups: [
		{ label: 'R2 · this calendar month (UTC)', metrics: [], error: 'Remaining allowance is unavailable.' },
		{ label: 'Storage · sum of today’s resource peaks', metrics: [{ label: 'D1 storage', used: 5_000_000, bytes: true }] },
	] });
	expect(root.querySelector('.crate-usage-period')?.textContent).toBe('January · UTC');
	expect(root.collectText()).toContain('Remaining allowance is unavailable.');
	expect(root.collectText()).toContain('2026-01-02 · peak storage');
	expect(root.collectText()).toContain('0.005 GB');
	expect(root.querySelector('progress')).toBeNull();
});

it('uses today only for the current UTC day and preserves the year for older months', () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
	try {
		const current = setup({ accountId: 'account-a', updatedAt: Date.UTC(2026, 9, 3), groups: [
			{ label: 'Workers · today (UTC)', metrics: [] },
		] });
		expect(current.root.querySelector('.crate-usage-period')?.textContent).toBe('Today · UTC');
		const old = setup({ accountId: 'account-a', updatedAt: Date.UTC(2025, 9, 3), groups: [
			{ label: 'R2 · this calendar month (UTC)', metrics: [] },
		] });
		expect(old.root.querySelector('.crate-usage-period')?.textContent).toBe('October 2025 · UTC');
	} finally { vi.useRealTimers(); }
});
