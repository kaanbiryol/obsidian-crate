import type { EncryptedFileDescriptor } from '../../../encryption/file-format';
import { decodeBase64Url, encodeBase64Url } from '../../../encryption/encoding';

/** The stored form of a file descriptor in the `descriptor` column of `files`, `changelog`
 * and `file_versions`. A packed column keeps the descriptor's IDs as 16 bytes each and,
 * after them, its metadata envelope, so an encrypted `files` row stays within its page
 * instead of taking an overflow page of its own. Version 2 descriptors pack to about 280
 * to 410 bytes. A version 1 envelope's protected header holds only the descriptor's own IDs and
 * fixed values, so it is left out and rebuilt: about 515 bytes instead of 960.
 *
 * Packing is exact: a descriptor is packed only when unpacking rebuilds every byte of it,
 * and is stored as its JSON otherwise. All forms read back the same. The version 1 header
 * below is frozen with packed format 1: rows already packed must keep rebuilding the
 * header their envelope was sealed with. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Each packed format: its descriptor version and the envelope parts after the three IDs. */
const FORMATS = { '1.': { version: 1, parts: 4 }, '2.': { version: 2, parts: 1 } } as const;

const metadataHeader = (descriptor: Pick<EncryptedFileDescriptor, 'vaultId' | 'objectId' | 'keyId'>) => encodeBase64Url(new TextEncoder().encode(JSON.stringify({
	alg: 'A256KW', enc: 'A256GCM', typ: 'crate-e2ee+jwe', v: 1, kid: descriptor.keyId,
	vault: descriptor.vaultId, scope: 'vault', object: descriptor.objectId, purpose: 'file-metadata',
})));
const packId = (id: string) => encodeBase64Url(Uint8Array.from(id.replace(/-/g, '').match(/../g)!, byte => parseInt(byte, 16)));
const unpackId = (value: string) => {
	const hex = Array.from(decodeBase64Url(value, 16), byte => byte.toString(16).padStart(2, '0')).join('');
	if (hex.length !== 32) throw new Error('Invalid stored encryption descriptor');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function packDescriptor(descriptor: EncryptedFileDescriptor): string {
	const json = JSON.stringify(descriptor);
	const ids = [descriptor.vaultId, descriptor.objectId, descriptor.keyId];
	const envelope = descriptor.version === 1 ? descriptor.metadata.split('.').slice(1) : [descriptor.metadata];
	if (!ids.every(id => UUID.test(id)) || envelope.length !== FORMATS[`${descriptor.version}.`].parts) return json;
	const packed = `${descriptor.version}.` + [...ids.map(packId), ...envelope].join('.');
	// Fall back to the JSON for anything the packed form would not rebuild exactly.
	try { return JSON.stringify(unpackDescriptor(packed)) === json ? packed : json; } catch { return json; }
}

export function unpackDescriptor(value: string): EncryptedFileDescriptor {
	if (value.startsWith('{')) return JSON.parse(value) as EncryptedFileDescriptor;
	const format = FORMATS[value.slice(0, 2) as keyof typeof FORMATS];
	const parts = format ? value.slice(2).split('.') : [];
	if (!format || parts.length !== 3 + format.parts) throw new Error('Invalid stored encryption descriptor');
	const [vaultId, objectId, keyId] = parts.slice(0, 3).map(unpackId) as [string, string, string];
	const envelope = parts.slice(3);
	const metadata = format.version === 1 ? [metadataHeader({ vaultId, objectId, keyId }), ...envelope].join('.') : envelope[0]!;
	return { version: format.version, vaultId, scopeId: 'vault', objectId, keyId, metadata };
}
