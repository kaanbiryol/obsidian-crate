import type { EncryptedFileDescriptor } from '../../../encryption/file-format';
import { decodeBase64Url, encodeBase64Url } from '../../../encryption/encoding';

/** The stored form of a file descriptor in the `descriptor` column of `files`, `changelog`
 * and `file_versions`. A packed column keeps the descriptor's IDs as 16 bytes each and,
 * after them, its metadata envelope, so an encrypted `files` row stays within its page
 * instead of taking an overflow page of its own. Descriptors pack to about 280 to 410 bytes.
 *
 * Packing is exact: a descriptor is packed only when unpacking rebuilds every byte of it,
 * and is stored as its JSON otherwise. Both forms read back the same. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PACKED_PREFIX = '1.';

const packId = (id: string) => encodeBase64Url(Uint8Array.from(id.replace(/-/g, '').match(/../g)!, byte => parseInt(byte, 16)));
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));
// Manifest and changelog pages unpack thousands of IDs per request, so this avoids
// a string per byte.
const unpackId = (value: string) => {
	const bytes = decodeBase64Url(value, 16);
	if (bytes.length !== 16) throw new Error('Invalid stored encryption descriptor');
	let id = '';
	for (let index = 0; index < 16; index++) id += (index === 4 || index === 6 || index === 8 || index === 10 ? '-' : '') + HEX[bytes[index]!]!;
	return id;
};

export function packDescriptor(descriptor: EncryptedFileDescriptor): string {
	const json = JSON.stringify(descriptor);
	const ids = [descriptor.vaultId, descriptor.objectId, descriptor.keyId];
	if (!ids.every(id => UUID.test(id))) return json;
	const packed = PACKED_PREFIX + [...ids.map(packId), descriptor.metadata].join('.');
	// Fall back to the JSON for anything the packed form would not rebuild exactly.
	try { return JSON.stringify(unpackDescriptor(packed)) === json ? packed : json; } catch { return json; }
}

export function unpackDescriptor(value: string): EncryptedFileDescriptor {
	if (value.startsWith('{')) return JSON.parse(value) as EncryptedFileDescriptor;
	const parts = value.startsWith(PACKED_PREFIX) ? value.slice(PACKED_PREFIX.length).split('.') : [];
	if (parts.length !== 4) throw new Error('Invalid stored encryption descriptor');
	const [vaultId, objectId, keyId] = parts.slice(0, 3).map(unpackId) as [string, string, string];
	return { version: 1, vaultId, scopeId: 'vault', objectId, keyId, metadata: parts[3]! };
}
