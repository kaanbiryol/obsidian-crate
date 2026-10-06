/** Build-independent inputs supplied by the Worker after the shell version is known. */
export interface ServiceWorkerConfig {
	version: string;
	chunkUrls: readonly string[];
}
