import type { PathTags } from '../../encryption/path-tags';
import { portablePathKey } from '../../protocol/portable-path';
import { insertBeforeExtension } from '../local/file-discovery';

/** Where the local manifest keeps the server path of notes with a random server name. */
export interface WireStore {
	wireOf(path: string): string | undefined;
	noteWire(path: string, wire: string): void;
	getAllPaths(): string[];
}

/** A distinct local name for a server file whose claimed name is taken: the start of
 * its server name is added to the name. */
function distinctLocalName(path: string, wire: string): string {
	const name = wire.lastIndexOf('/') + 1;
	return insertBeforeExtension(path, ` - ${wire.slice(name, name + 8)}`);
}

/** Gives each decrypted server file a unique plaintext path, in the order they should
 * be recorded. Files stored at their name's own tag claim it first; a later file
 * claiming the same name gets a distinct local name from its server path. */
export function assignPlainPaths(entries: ReadonlyArray<{ path: string; wire: string }>, tagged: readonly boolean[]): Array<{ index: number; path: string }> {
	const claimed = new Set<string>();
	const order = entries.map((_, index) => index).sort((a, b) => Number(tagged[b]) - Number(tagged[a]));
	return order.map(index => {
		const { wire } = entries[index]!;
		let { path } = entries[index]!;
		if (claimed.has(portablePathKey(path))) {
			path = distinctLocalName(path, wire);
		}
		claimed.add(portablePathKey(path));
		return { index, path };
	});
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
