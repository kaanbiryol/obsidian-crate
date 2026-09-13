import { computeHash } from './hasher';

export class PlannedContent {
    private entries = new Map<string, { content: ArrayBuffer; hash: string }>();
    private bytes = 0;
    constructor(private readonly budget = 4 * 1024 * 1024) {}

    remember(path: string, content: ArrayBuffer, hash: string): void {
        // Retain the first files, which are prepared first; never retain the whole vault.
        if (this.entries.has(path) || this.entries.size >= 4096 || this.bytes + content.byteLength > this.budget) return;
        this.entries.set(path, { content, hash });
        this.bytes += content.byteLength;
    }

    async hash(path: string, content: ArrayBuffer): Promise<string> {
        const prior = this.entries.get(path);
        if (prior) {
            this.entries.delete(path);
            this.bytes -= prior.content.byteLength;
            if (prior.content.byteLength === content.byteLength) {
                const left = new Uint8Array(prior.content);
                const right = new Uint8Array(content);
                let equal = true;
                for (let index = 0; index < left.length; index++) {
                    if (left[index] !== right[index]) { equal = false; break; }
                }
                if (equal) return prior.hash;
            }
        }
        return computeHash(content);
    }

    clear(): void { this.entries.clear(); this.bytes = 0; }
}
