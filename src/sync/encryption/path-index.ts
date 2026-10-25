import type { PathTags } from '../../encryption/path-tags';
import { portablePathKey } from '../../protocol/portable-path';

/** Where the local manifest keeps the server path of notes with a random server name. */
export interface WireStore {
	wireOf(path: string): string | undefined;
	pathOfWire(wire: string): string | undefined;
	noteWire(path: string, wire: string): void;
	getAllPaths(): string[];
}

/** Maps plaintext paths to their server paths and back. Tags are recomputed;
 * only notes created without the path key need their server name remembered. */
export class PathIndex {
	private store?: WireStore;
	private readonly plainByWire = new Map<string, string>();
	private readonly opaque = new Map<string, string>();
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

	/** The plaintext path of a server path this device has synced, if any. */
	async plainFor(wire: string): Promise<string | undefined> {
		const known = this.plainByWire.get(wire) ?? this.store?.pathOfWire(wire);
		if (known || this.scanned || !this.store) return known;
		// Deletes carry no metadata. Tags of synced files are rebuilt once, on demand.
		this.scanned = true;
		for (const path of this.store.getAllPaths()) {
			const tag = await this.tags.wire(path).catch(() => null);
			if (tag && !this.plainByWire.has(tag)) this.plainByWire.set(tag, path);
		}
		return this.plainByWire.get(wire);
	}
}
