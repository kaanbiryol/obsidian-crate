export interface BatchFile {
	operationId?: unknown;
	path: string;
	content: string;
	hash?: string;
	size?: number;
	contentType?: string;
	expectedHash?: unknown;
}

export interface BatchDeleteFile {
	expectedRevision?: unknown;
	path?: unknown;
	expectedHash?: unknown;
}
