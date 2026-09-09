import type { App, TFile } from 'obsidian';
import { decodeMarkdownBytes } from '../core/markdownEncoding';

export class VaultMarkdownChangedError extends Error {
	constructor() { super('This note changed while its reminders were being read. Refresh reminders and try again.'); }
}

/** Validate the bytes before the host can replace malformed UTF-8 with text. */
export async function readVaultMarkdown(app: App, file: TFile): Promise<string> {
	const path = file.path;
	const content = decodeMarkdownBytes(await app.vault.adapter.readBinary(path));
	if (file.path !== path) throw new VaultMarkdownChangedError();
	return content;
}

/**
 * Every reminder rewrite, including normalization and move recovery, enters
 * through this boundary. Never fall back to a lossy Vault.read(). The host only
 * offers atomic text processing: compare with the verified preimage inside its
 * callback, after asynchronous reads, and reject a concurrent replacement.
 */
export async function processVaultMarkdown(
	app: App,
	file: TFile,
	update: (content: string) => string,
): Promise<string> {
	const path = file.path;
	const expected = await readVaultMarkdown(app, file);
	return app.vault.process(file, current => {
		if (file.path !== path || current !== expected) throw new VaultMarkdownChangedError();
		return update(current);
	});
}
