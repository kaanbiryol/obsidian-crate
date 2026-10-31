import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareDeploymentMetadata } from '../../../cloudflare/deployment/types';
import type { ConfirmationModalOptions } from '../../confirmation-modal';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';

const confirm = vi.fn<(app: unknown, options: ConfirmationModalOptions) => Promise<boolean>>();
const start = vi.fn();

function deployment(overrides: Partial<CloudflareDeploymentMetadata> = {}): CloudflareDeploymentMetadata {
	return {
		deploymentId: '0123456789abcdef', accountId: 'account', accountName: 'Personal',
		workerName: 'crate-0123456789abcdef', d1DatabaseName: 'crate-0123456789abcdef',
		d1DatabaseId: 'database', r2BucketName: 'crate-0123456789abcdef', workersSubdomain: 'personal',
		lastDeployedVersion: 'crate', lastDeployedFingerprint: 'f'.repeat(64),
		...overrides,
	};
}

async function render(saved: CloudflareDeploymentMetadata | null, configured = false) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../../plugin/cloudflare-operations', () => ({ startCloudflareDeployment: start }));
	vi.doMock('../../confirmation-modal', () => ({ openConfirmationModal: confirm }));
	const { renderInfrastructureSection, renderServerActions } = await import('./infrastructure-section');
	const containerEl = new FakeElement('div');
	const plugin = {
		app: {}, settings: { cloudflareDeployment: saved, debugLogging: false },
		settingsUiState: { diagnostics: null }, syncRuntime: { isConfigured: () => configured },
	};
	const context = { containerEl: containerEl as never, plugin: plugin as never, isConfigured: configured, rerender: vi.fn() };
	if (configured) renderServerActions(context);
	else renderInfrastructureSection(context);
	return { containerEl, plugin };
}

beforeEach(() => { resetObsidianUiMocks(); confirm.mockReset(); start.mockReset(); });
afterEach(() => {
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../../plugin/cloudflare-operations');
	vi.doUnmock('../../confirmation-modal');
});

describe('advanced server actions', () => {
	it.each([false, true])('offers resume for a saved deletion even when disconnected (connected: %s)', async configured => {
		const saved = deployment({ deletion: {
			id: 'delete-job', phase: 'clearing-bucket', databaseId: 'database',
			bucketCreatedAt: 'date', workerCreatedAt: 'date', helperName: 'crate-delete-helper',
		} });
		const { containerEl, plugin } = await render(saved, configured);
		expect(containerEl.collectText()).toContain('Advanced server actions');
		const button = MockSetting.instances.flatMap(setting => setting.buttons)
			.find(button => button.buttonEl.textContent === 'Resume server deletion');
		expect(button).toBeDefined();
		expect(start).not.toHaveBeenCalled();
		confirm.mockResolvedValue(true);
		button!.click();
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(plugin, 'delete'));
		expect(confirm.mock.calls[0]![1].details).toContain('Database: crate-0123456789abcdef (database)');
	});

	it('offers deletion of a remembered server without an empty heading on a disconnected device', async () => {
		await render(deployment());
		expect(MockSetting.instances.flatMap(setting => setting.buttons).map(button => button.buttonEl.textContent))
			.toContain('Delete server and all data');
	});

	it.each([null, deployment({ accountId: null }), deployment({ d1DatabaseId: null })])(
		'avoids an empty advanced section without a complete saved server (%j)', async saved => {
			const { containerEl } = await render(saved);
			expect(containerEl.collectText()).not.toContain('Advanced server actions');
			expect(start).not.toHaveBeenCalled();
		},
	);
});
