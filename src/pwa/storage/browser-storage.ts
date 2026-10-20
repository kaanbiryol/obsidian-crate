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
