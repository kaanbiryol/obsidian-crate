import type { App, PluginManifest } from 'obsidian';
import { createLogger, errorMessage } from '../plugin/logger';
import type { FileEntry } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';
import { computeHash } from './hasher';

const logger = createLogger('MarkdownBaseCache');
const CACHE_DIRNAME = 'markdown-base-cache';
const HASH_RE = /^[a-f0-9]{64}$/;
const SEED_CONCURRENCY = 2;

export interface MarkdownBaseCacheManifest {
	getAllPaths(): string[];
	getEntry(path: string): FileEntry | undefined;
}

export interface MarkdownBaseCacheSeedOptions {
	isDestroyed(): boolean;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
}

export function isMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith('.md');
}

export class MarkdownBaseCache {
	private readonly app: App;
	private readonly cacheDir: string;

	constructor(app: App, pluginManifest: PluginManifest) {
		this.app = app;
		this.cacheDir = `${pluginManifest.dir}/${CACHE_DIRNAME}`;
	}

	getIgnoredPrefix(): string {
		return `${this.cacheDir}/`;
	}

	async readBase(path: string, hash: string): Promise<ArrayBuffer | null> {
		if (!isMarkdownPath(path) || !isValidHash(hash)) {
			return null;
		}

		const cachePath = this.getCachePath(hash);
		try {
			if (!await this.app.vault.adapter.exists(cachePath)) {
				return null;
			}
			return await this.app.vault.adapter.readBinary(cachePath);
		} catch (error) {
			logger.warn(`Failed to read Markdown base cache for ${path}:`, errorMessage(error));
			return null;
		}
	}

	async putBase(path: string, hash: string, content: ArrayBuffer): Promise<void> {
		if (!isMarkdownPath(path) || !isValidHash(hash) || content.byteLength > MAX_FILE_SIZE_BYTES) {
			return;
		}

		try {
			await this.ensureCacheDir();
			await this.app.vault.adapter.writeBinary(this.getCachePath(hash), content);
		} catch (error) {
			logger.warn(`Failed to write Markdown base cache for ${path}:`, errorMessage(error));
		}
	}

	async seedFromManifest(
		manifest: MarkdownBaseCacheManifest,
		options: MarkdownBaseCacheSeedOptions,
	): Promise<void> {
		const paths = manifest.getAllPaths()
			.filter(isMarkdownPath)
			.filter((path) => {
				const entry = manifest.getEntry(path);
				return entry !== undefined
					&& isValidHash(entry.hash)
					&& entry.size <= MAX_FILE_SIZE_BYTES;
			});

		const tasks = paths.map((path) => async () => {
			if (options.isDestroyed()) {
				return;
			}

			const entry = manifest.getEntry(path);
			if (!entry) {
				return;
			}

			try {
				if (await this.app.vault.adapter.exists(this.getCachePath(entry.hash))) {
					return;
				}
				const content = await this.app.vault.adapter.readBinary(path);
				if (content.byteLength > MAX_FILE_SIZE_BYTES) {
					return;
				}
				const hash = await computeHash(content);
				if (hash === entry.hash) {
					await this.putBase(path, entry.hash, content);
				}
			} catch (error) {
				logger.debug(`Skipped Markdown base cache seed for ${path}:`, errorMessage(error));
			}
		});

		await options.runConcurrent(tasks, SEED_CONCURRENCY);
		await this.pruneReferencedHashes(getReferencedMarkdownHashes(manifest));
	}

	async pruneReferencedHashes(referencedHashes: Set<string>): Promise<void> {
		try {
			const listing = await this.app.vault.adapter.list(this.cacheDir);
			await Promise.allSettled(
				listing.files
					.filter((path) => path.endsWith('.md'))
					.filter((path) => !referencedHashes.has(getHashFromCachePath(path)))
					.map((path) => this.app.vault.adapter.remove(path)),
			);
		} catch {
			// Cache directory may not exist yet. Pruning is best effort.
		}
	}

	async pruneUnreferenced(manifest: MarkdownBaseCacheManifest): Promise<void> {
		await this.pruneReferencedHashes(getReferencedMarkdownHashes(manifest));
	}

	private async ensureCacheDir(): Promise<void> {
		try {
			await this.app.vault.adapter.mkdir(this.cacheDir);
		} catch {
			// Directory may already exist.
		}
	}

	private getCachePath(hash: string): string {
		return `${this.cacheDir}/${hash}.md`;
	}
}

function isValidHash(hash: string): boolean {
	return HASH_RE.test(hash);
}

function getReferencedMarkdownHashes(manifest: MarkdownBaseCacheManifest): Set<string> {
	const hashes = new Set<string>();
	for (const path of manifest.getAllPaths()) {
		const entry = manifest.getEntry(path);
		if (entry && isMarkdownPath(path) && isValidHash(entry.hash)) {
			hashes.add(entry.hash);
		}
	}
	return hashes;
}

function getHashFromCachePath(path: string): string {
	const fileName = path.split('/').pop() ?? '';
	return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}
