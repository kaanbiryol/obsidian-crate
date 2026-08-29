export interface BatchFile {
	path: string;
	content: string;
	hash?: string;
	size?: number;
	contentType?: string;
	expectedHash?: unknown;
}

export interface BatchDeleteFile {
	path?: unknown;
	expectedHash?: unknown;
}
