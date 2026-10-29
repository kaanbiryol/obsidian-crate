import type { PathTags } from '../../encryption/path-tags';
import { portablePathKey } from '../../protocol/portable-path';
import { insertBeforeExtension } from '../local/file-discovery';

/** Where the local manifest keeps the server path of notes with a random server name. */
export interface WireStore {
	wireOf(path: string): string | undefined;
	noteWire(path: string, wire: string): void;
	getAllPaths(): string[];
	getEntry(path: string): { readonly hash: string } | undefined;
}

/** A synced file, the server path it is stored at and its plaintext hash. */
export interface SyncedFile { path: string; wire: string; hash: string }

/** A distinct local name for a server file whose claimed name is taken: the start of
 * its server name is added to the name. */
export function distinctLocalName(path: string, wire: string): string {
	const name = wire.lastIndexOf('/') + 1;
	return insertBeforeExtension(path, ` - ${wire.slice(name, name + 8)}`);
}

/** Maps plaintext paths to their server paths and back. Tags are recomputed;
 * only notes created without the path key need their server name remembered. */
export class PathIndex {
	private store?: WireStore;
	private readonly plainByWire = new Map<string, string>();
	private readonly opaque = new Map<string, string>();
	// Tags of files read by `syncedIn`. A path's tag never changes.
	private readonly syncedTags = new Map<string, string>();
	private scanned = false;
	constructor(readonly tags: PathTags) {}

	useStore(store: WireStore): void {
		this.store = store;
		this.scanned = false;
	}

	async wireFor(path: string): Promise<string> {
		return this.opaque.get(portablePathKey(path)) ?? this.store?.wireOf(path) ?? this.tags.wire(path);
	}

	/** Record where a verified file is stored, so later writes reach the same server path. */
	async learn(path: string, wire: string): Promise<void> {
		this.plainByWire.set(wire, path);
		if (wire === await this.tags.wire(path)) return;
		this.opaque.set(portablePathKey(path), wire);
		this.store?.noteWire(path, wire);
	}

	/** Files this device has synced directly inside `folder`, from the local manifest. */
	async syncedIn(folder: string): Promise<SyncedFile[]> {
		const store = this.store;
		if (!store) return [];
		const key = portablePathKey(folder), files: SyncedFile[] = [];
		for (const path of store.getAllPaths()) {
			const slash = path.lastIndexOf('/'), entry = store.getEntry(path);
			if (slash < 0 || !entry || portablePathKey(path.slice(0, slash)) !== key) continue;
			let wire = store.wireOf(path) ?? this.syncedTags.get(path);
			if (!wire) {
				wire = await this.tags.wire(path).catch(() => undefined);
				if (wire) this.syncedTags.set(path, wire);
			}
			if (wire) files.push({ path, wire, hash: entry.hash });
		}
		return files;
	}

	/** The plaintext path of a server path this device has synced, if any. */
	async plainFor(wire: string): Promise<string | undefined> {
		const known = this.plainByWire.get(wire);
		if (known || this.scanned || !this.store) return known;
		// Deletes carry no metadata. Server paths of synced files are rebuilt once, on
		// demand; later ones are learned as they sync.
		this.scanned = true;
		for (const path of this.store.getAllPaths()) {
			const tag = this.store.wireOf(path) ?? await this.tags.wire(path).catch(() => null);
			if (tag && !this.plainByWire.has(tag)) this.plainByWire.set(tag, path);
		}
		return this.plainByWire.get(wire);
	}
}
