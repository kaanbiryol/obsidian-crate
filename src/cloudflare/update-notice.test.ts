import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notices: FakeDocumentFragment[] = [];
const embeddedArtifact = {
	version: '0.2.0',
	fingerprint: 'b'.repeat(64),
};

class FakeLink {
	private clickHandler?: () => void;

	constructor(readonly text: string) {}

	addEventListener(type: string, listener: () => void): void {
		if (type === 'click') {
			this.clickHandler = listener;
		}
	}

	click(): void {
		this.clickHandler?.();
	}
}

class FakeDocumentFragment {
	readonly spans: string[] = [];
	readonly links: FakeLink[] = [];

	createSpan(options: { text: string }): void {
		this.spans.push(options.text);
	}

	createEl(_tag: string, options: { text: string }): FakeLink {
		const link = new FakeLink(options.text);
		this.links.push(link);
		return link;
	}
}

async function loadUpdateNotice() {
	vi.doMock('obsidian', () => ({
		Notice: class Notice {
			constructor(message: FakeDocumentFragment) {
				notices.push(message);
			}
		},
	}));
	vi.doMock('./embedded-artifacts', () => ({
		EMBEDDED_CLOUDFLARE_ARTIFACT: embeddedArtifact,
	}));

	return import('./update-notice');
}

function createPlugin(overrides: {
	configured?: boolean;
	lastDeployedVersion?: string;
	lastDeployedFingerprint?: string | null;
	deployment?: boolean;
} = {}) {
	return {
		settings: {
			cloudflareDeployment: overrides.deployment === false ? null : {
				lastDeployedVersion: overrides.lastDeployedVersion ?? embeddedArtifact.version,
				lastDeployedFingerprint: overrides.lastDeployedFingerprint ?? 'a'.repeat(64),
			},
		},
		syncRuntime: {
			isConfigured: vi.fn(() => overrides.configured ?? true),
		},
		openSettingsTab: vi.fn(),
	};
}

beforeEach(() => {
	notices.length = 0;
	vi.stubGlobal('DocumentFragment', FakeDocumentFragment as unknown as typeof DocumentFragment);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('./embedded-artifacts');
});

describe('showCloudflareServerUpdateNotice', () => {
	it('notifies when the Worker or PWA artifact changes within the same plugin version', async () => {
		const { showCloudflareServerUpdateNotice } = await loadUpdateNotice();
		const plugin = createPlugin();

		showCloudflareServerUpdateNotice(plugin as never);

		expect(notices).toHaveLength(1);
		expect(notices[0]?.spans).toEqual([
			'A Crate server update is available. ',
			' to update the Worker and web app.',
		]);
		expect(notices[0]?.links[0]?.text).toBe('Open settings');

		notices[0]?.links[0]?.click();
		expect(plugin.openSettingsTab).toHaveBeenCalledTimes(1);
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
