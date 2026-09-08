import type { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, type CrateSettings } from '../../plugin/settings-types';
import { SyncApiClient } from '../../sync/api';
import { SyncEngine } from '../../sync/engine';
import type { ApiHttpTransport } from '../../sync/worker-api/http';
import type { FileManifest } from '../../protocol/sync-types';
import { sha256Hex } from './auth';
import worker from './index';
import type { Env } from './types';
import { PersistentTestVault, TEST_PLUGIN_DIR } from './sync-engine-vault-test-harness';

interface PausedResponse {
	committed(): void;
	released: Promise<void>;
}

/** Each instance is a separate device; only its disk and settings survive reopen. */
export class SyncTestDevice {
	readonly disk = new PersistentTestVault();
	readonly settings: CrateSettings;
	readonly requests: string[] = [];
	readonly responses: Array<{ route: string; status: number; bytes: number; wallMs: number }> = [];
	private pause: PausedResponse | null = null;
	api!: SyncApiClient;
	engine!: SyncEngine;

	constructor(readonly id: string, private readonly runtimeEnv: Env) {
		this.settings = { ...structuredClone(DEFAULT_SETTINGS), deviceId: id, workerUrl: 'https://worker.test', syncInterval: 0 };
	}

	async authorize(lifetimeMs = 60_000): Promise<void> {
		await this.runtimeEnv.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope, expires_at) VALUES (?, ?, ?, ?)')
			.bind(this.id, await sha256Hex(this.id), 'vault', Date.now() + lifetimeMs).run();
	}

	async open(): Promise<void> {
		this.api = new SyncApiClient(this.settings.workerUrl, this.id, this.transport);
		this.engine = new SyncEngine({
			manifest: { dir: TEST_PLUGIN_DIR },
			app: { vault: this.disk.vault, fileManager: {}, workspace: { onLayoutReady: () => {} } },
		} as unknown as Plugin, this.api, this.settings);
		await this.engine.initialize();
	}

	close(): void { this.engine?.destroy(); }

	checkpoint(): FileManifest {
		return JSON.parse(this.disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`)) as FileManifest;
	}

	pauseNextUploadResponse(): { committed: Promise<void>; release(): void } {
		let committed!: () => void;
		let release!: () => void;
		const committedPromise = new Promise<void>(resolve => { committed = resolve; });
		const released = new Promise<void>(resolve => { release = resolve; });
		this.pause = { committed, released };
		return { committed: committedPromise, release };
	}

	private readonly transport: ApiHttpTransport = async request => {
		const path = new URL(request.url).pathname;
		const started = performance.now();
		this.requests.push(`${request.method ?? 'GET'} ${path}`);
		const response = await worker.fetch(new Request(request.url, {
			method: request.method, body: request.body,
			headers: { ...request.headers, ...(request.contentType ? { 'Content-Type': request.contentType } : {}) },
		}), this.runtimeEnv);
		if (this.pause && response.ok && (path === '/sync/upload' || path === '/sync/batch-upload')) {
			const pause = this.pause;
			this.pause = null;
			pause.committed();
			await pause.released;
		}
		const arrayBuffer = await response.arrayBuffer();
		this.responses.push({ route: `${request.method ?? 'GET'} ${path}`, status: response.status,
			bytes: arrayBuffer.byteLength, wallMs: performance.now() - started });
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => { headers[key] = value; });
		return {
			status: response.status,
			headers,
			arrayBuffer, text: new TextDecoder().decode(arrayBuffer),
		};
	};
}
