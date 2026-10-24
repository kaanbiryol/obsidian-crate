import type { WorkerApiHttpClient } from './http';
import type { EncryptedFiles } from '../encryption/encrypted-files';
import { readServerEncryption } from '../encryption/conversion';

export class LinksWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}
	private encryption?: EncryptedFiles;
	setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; }

	/** The server fetches the title without storing the link, also for encrypted vaults.
	 * A device that has not unlocked an encrypted vault skips the lookup. */
	async fetchPageTitle(url: string): Promise<string | null> {
		if (!this.encryption && await readServerEncryption(this.http, 7000)) return null;
		const result = await this.http.requestJson<{ title?: unknown }>('/links/title', {
			method: 'POST', body: JSON.stringify({ url }),
		}, 7000);
		return typeof result.title === 'string' ? result.title : null;
	}
}
