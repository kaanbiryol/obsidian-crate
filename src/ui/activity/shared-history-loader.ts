import type { SharedCheckpoint } from '../../protocol/history-checkpoints';

/** Each open Activity view owns one loader; disposed requests cannot publish results. */
export class SharedHistoryLoader {
	private active = true;
	private loading = false;
	private reload = false;
	private snapshot: { ready: boolean; checkpoints?: SharedCheckpoint[] } = { ready: false };

	constructor(
		private readonly load: () => Promise<SharedCheckpoint[]>,
		private readonly onChange: () => void,
	) {}

	getSnapshot(): Readonly<typeof this.snapshot> { return this.snapshot; }

	async refresh(): Promise<void> {
		if (!this.active) return;
		if (this.loading) { this.reload = true; return; }
		this.loading = true;
		try {
			const checkpoints = await this.load();
			if (this.active) this.snapshot = { ready: true, checkpoints };
		} catch {
			// Reveal local history on the first failure, preserving any previously loaded history.
		} finally {
			this.loading = false;
			if (this.active) {
				this.snapshot = { ...this.snapshot, ready: true };
				this.onChange();
				if (this.reload) { this.reload = false; void this.refresh(); }
			}
		}
	}

	dispose(): void { this.active = false; }
}
