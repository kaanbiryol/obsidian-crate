import { decodeBase64Url } from './encoding';
import type { EncryptionSecret } from './envelope';
import { encodeBase32 } from '../protocol/encrypted-path';
import { getSyncPathIssue, portablePathKey } from '../protocol/portable-path';

/** Derives the key that turns names into tags. Only clients holding the vault key can. */
export async function derivePathTagKey(vaultId: string, secret: EncryptionSecret): Promise<CryptoKey> {
	const raw = decodeBase64Url(secret.secret, 32);
	try {
		const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
		return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(vaultId),
			info: new TextEncoder().encode('crate-e2ee-v1/path-tag') }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
	} finally { raw.fill(0); }
}

const MAX_CACHED_FOLDERS = 4096;

/** Maps plaintext paths to their server form. Each tag covers the case- and
 * Unicode-insensitive name and its parent, so case variants share one server
 * identity and equal names in different folders stay unlinkable. */
export class PathTags {
	// Wire forms of recently used parent folders, by portable path.
	private readonly folders = new Map<string, string>();
	constructor(private readonly key: CryptoKey) {}

	static async fromSecret(vaultId: string, secret: EncryptionSecret): Promise<PathTags> {
		return new PathTags(await derivePathTagKey(vaultId, secret));
	}

	async tag(parent: string, name: string): Promise<string> {
		const portable = portablePathKey(name);
		const mac = await crypto.subtle.sign('HMAC', this.key, new TextEncoder().encode(`crate-path-v1\0${portablePathKey(parent)}\0${portable}`));
		return encodeBase32(new Uint8Array(mac, 0, 16)) + (portable.endsWith('.md') ? '.md' : '');
	}

	async wire(path: string): Promise<string> {
		const segments = path.split('/');
		let parent = '', parentWire = '';
		for (const [index, name] of segments.entries()) {
			const plain = parent ? `${parent}/${name}` : name, folder = index < segments.length - 1;
			let wire = folder ? this.folders.get(portablePathKey(plain)) : undefined;
			if (!wire) {
				wire = `${parentWire ? `${parentWire}/` : ''}${await this.tag(parent, name)}`;
				if (folder) this.remember(portablePathKey(plain), wire);
			}
			parent = plain; parentWire = wire;
		}
		if (getSyncPathIssue(parentWire)) throw new Error('This path is nested too deeply to sync in an encrypted vault.');
		return parentWire;
	}

	private remember(folder: string, wire: string): void {
		if (this.folders.size >= MAX_CACHED_FOLDERS) this.folders.delete(this.folders.keys().next().value!);
		this.folders.set(folder, wire);
	}
}
