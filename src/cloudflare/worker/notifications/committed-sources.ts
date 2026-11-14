import { sha256Hex } from '../../../platform/sha256';

/** Bytes of reminder notes that commits in this isolate published, so the coordinator's next
 * projection pass, which usually runs in the same object, can skip reading them back from
 * R2. A storage key names one immutable revision, and a reader still checks the bytes
 * against the committed hash, so a stale or failed commit can only cost an R2 read. */
const recent = new Map<string, ArrayBuffer>();
const MAX_ENTRIES = 16;
const MAX_BYTES = 4 * 1024 * 1024;
let bytes = 0;

export function rememberCommittedSource(storageKey: string, content: string | ArrayBuffer): void {
	const buffer = typeof content === 'string' ? new TextEncoder().encode(content).buffer : content;
	if (buffer.byteLength > MAX_BYTES / 4 || recent.has(storageKey)) return;
	recent.set(storageKey, buffer);
	bytes += buffer.byteLength;
	for (const [key, value] of recent) {
		if (recent.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
		recent.delete(key);
		bytes -= value.byteLength;
	}
}

/** The bytes of `file` if a commit here published exactly them; each entry is used once. */
export async function takeCommittedSource(file: { storageKey: string; hash: string }): Promise<ArrayBuffer | null> {
	const content = recent.get(file.storageKey);
	if (!content) return null;
	recent.delete(file.storageKey);
	bytes -= content.byteLength;
	return await sha256Hex(content) === file.hash ? content : null;
}
