import type { WorkerApiHttpClient } from './http';
import type { EncryptedFiles } from '../encryption/encrypted-files';
import { readServerEncryption } from '../encryption/conversion';

export class LinksWorkerApi {
	constructor(private readonly http: WorkerApiHttpClient) {}
	private encryption?: EncryptedFiles;
	setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; }

	async fetchPageTitle(url: string): Promise<string | null> {
		if (this.encryption) return null;
		if (await readServerEncryption(this.http, 7000)) return null;
		const result = await this.http.requestJson<{ title?: unknown }>('/links/title', {
			method: 'POST', body: JSON.stringify({ url }),
		}, 7000);
		return typeof result.title === 'string' ? result.title : null;
	}
}
