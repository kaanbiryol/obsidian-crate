import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import release from '../../cloudflare/server-release.json';
import type { DevelopmentBuild } from '../../protocol/server-build';
import { FakeDocumentFragment } from '../../test/factories/obsidian';

const notices: FakeDocumentFragment[] = [];
const embeddedArtifact = {
	version: '0.2.0',
	fingerprint: 'b'.repeat(64),
	development: undefined as DevelopmentBuild | undefined,
};

async function loadUpdateNotice(isMobile = false) {
	vi.doMock('obsidian', () => ({
		Platform: { isMobile },
		Notice: class Notice {
			constructor(message: FakeDocumentFragment) {
				notices.push(message);
			}
		},
	}));
	vi.doMock('../../cloudflare/deployment/embedded-artifacts', () => ({
		EMBEDDED_CLOUDFLARE_ARTIFACT: embeddedArtifact,
	}));

	return import('./update-notice');
}

function createPlugin(overrides: {
	configured?: boolean;
	lastDeployedVersion?: string;
	lastDeployedFingerprint?: string | null;
	lastKnownRevision?: number;
	cachedRevision?: number;
	workerUrl?: string;
	deployment?: boolean;
} = {}) {
	return {
		settings: {
			workerUrl: overrides.workerUrl ?? 'https://crate-0123456789abcdef.example.workers.dev',
			cloudflareDeployment: overrides.deployment === false ? null : {
				workerName: 'crate-0123456789abcdef',
				workersSubdomain: 'example',
				lastKnownRevision: overrides.lastKnownRevision,
				lastDeployedVersion: overrides.lastDeployedVersion ?? embeddedArtifact.version,
				lastDeployedFingerprint: overrides.lastDeployedFingerprint ?? 'a'.repeat(64),
			},
		},
		syncRuntime: {
			isConfigured: vi.fn(() => overrides.configured ?? true),
			getCachedVersionInfo: vi.fn(() => overrides.cachedRevision === undefined ? undefined : { serverRevision: overrides.cachedRevision }),
		},
		openSettingsTab: vi.fn(),
	};
}

beforeEach(() => {
	notices.length = 0;
	embeddedArtifact.development = undefined;
	vi.stubGlobal('DocumentFragment', FakeDocumentFragment);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('./deployment/embedded-artifacts');
});

describe('showCloudflareServerUpdateNotice', () => {
	it.each(['saved', 'cached'] as const)('explains a newer server using its %s revision instead of suggesting a server update', async source => {
		const { showCloudflareServerUpdateNotice } = await loadUpdateNotice();
		const plugin = createPlugin(source === 'saved'
			? { lastKnownRevision: release.revision + 1 }
			: { lastKnownRevision: release.revision - 1, cachedRevision: release.revision + 1 });

		showCloudflareServerUpdateNotice(plugin as never);

		expect(notices).toHaveLength(1);
		expect(notices[0]?.spans).toEqual([
			'Your Crate server is newer than this plugin’s bundled server. ',
			' to review the versions. Updating this server requires a newer plugin build.',
		]);
		notices[0]?.links[0]?.click();
		expect(plugin.openSettingsTab).toHaveBeenCalledOnce();
	});

	it.each([
		{ workerUrl: 'https://another.example.com' },
		{ cachedRevision: release.revision - 1 },
	])('does not use an outdated saved revision when the connected server differs: %j', async overrides => {
		const { showCloudflareServerUpdateNotice } = await loadUpdateNotice();
		showCloudflareServerUpdateNotice(createPlugin({ lastKnownRevision: release.revision + 1, ...overrides }) as never);
		expect(notices[0]?.spans[0]).toBe('Review your Crate server update. ');
	});

	it('notifies when the Worker or PWA artifact changes within the same plugin version', async () => {
		const { showCloudflareServerUpdateNotice } = await loadUpdateNotice();
		const plugin = createPlugin();

		showCloudflareServerUpdateNotice(plugin as never);

		expect(notices).toHaveLength(1);
		expect(notices[0]?.spans).toEqual([
			'Review your Crate server update. ',
			' to update or verify the Worker and web app.',
		]);
		expect(notices[0]?.links[0]?.text).toBe('Open settings');

		notices[0]?.links[0]?.click();
		expect(plugin.openSettingsTab).toHaveBeenCalledTimes(1);
	});

	it('points the update to the desktop on mobile', async () => {
		const { showCloudflareServerUpdateNotice } = await loadUpdateNotice(true);
		showCloudflareServerUpdateNotice(createPlugin() as never);
		expect(notices).toEqual(['A Crate server update is available. Open Crate settings in Obsidian on your desktop to update it.']);
	});

	it('stays quiet when the deployed artifact is current', async () => {
		const { showCloudflareServerUpdateNotice } = await loadUpdateNotice();
		const plugin = createPlugin({
			lastDeployedVersion: embeddedArtifact.version,
			lastDeployedFingerprint: embeddedArtifact.fingerprint,
		});

		showCloudflareServerUpdateNotice(plugin as never);

		expect(notices).toHaveLength(0);
	});

	it('stays quiet for disconnected or unmanaged installations', async () => {
		const { showCloudflareServerUpdateNotice } = await loadUpdateNotice();

		showCloudflareServerUpdateNotice(createPlugin({ configured: false }) as never);
		showCloudflareServerUpdateNotice(createPlugin({ deployment: false }) as never);

		expect(notices).toHaveLength(0);
	});
});

it.each([true, false])('only advertises a development update for its target server (matches=%s)', async matches => {
	embeddedArtifact.development = { number: 28, worker: matches ? 'crate-0123456789abcdef' : 'crate-fedcba9876543210' };
	const { showCloudflareServerUpdateNotice } = await loadUpdateNotice();
	showCloudflareServerUpdateNotice(createPlugin({ lastKnownRevision: release.revision - 1 }) as never);
	expect(notices).toHaveLength(matches ? 1 : 0);
});
