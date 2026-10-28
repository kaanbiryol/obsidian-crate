import { Platform } from 'obsidian';

/** A transfer in flight holds several full-size copies of the file (base64, ciphertext,
 * decrypted bytes), so two 25 MiB files at once can exhaust a phone's memory. */
export const MOBILE_LARGE_TRANSFER_BYTES = 8 * 1024 * 1024;

/** On mobile, runs transfers of large files one at a time; smaller files and desktop are not held back. */
export function createLargeTransferGate() {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(size: number | undefined, run: () => Promise<T>): Promise<T> => {
		if (!Platform.isMobile || (size ?? 0) < MOBILE_LARGE_TRANSFER_BYTES) return run();
		const next = tail.then(run);
		tail = next.catch(() => {});
		return next;
	};
}
