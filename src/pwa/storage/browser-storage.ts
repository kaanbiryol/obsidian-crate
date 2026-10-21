export type BrowserStorageStatus = 'persistent' | 'best-effort' | 'unavailable';

export async function browserStorageStatus(request = false): Promise<BrowserStorageStatus> {
	try {
		const storage = navigator.storage;
		if (!storage?.persisted) return 'unavailable';
		if (await storage.persisted()) return 'persistent';
		if (request && storage.persist && await storage.persist()) return 'persistent';
		return 'best-effort';
	} catch { return 'unavailable'; }
}

/**
 * Installed apps ask once at launch, where browsers grant persistence without a prompt.
 * Browser tabs never ask unprompted; Settings offers the request while unsynced work is at risk.
 */
export function protectInstalledAppStorage(standalone: boolean): Promise<BrowserStorageStatus> | null {
	return standalone ? browserStorageStatus(true) : null;
}
