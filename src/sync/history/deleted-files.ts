import type { FileVersionQuery, FileVersionsPage, RemoteFileVersion } from '../../protocol/sync-types';

export interface DeletedFileSource {
	listVersions(query: FileVersionQuery): Promise<FileVersionsPage>;
	/** The paths among `paths` that the server holds now. */
	remotePaths(paths: string[]): Promise<ReadonlySet<string>>;
	localExists(path: string): Promise<boolean>;
}

/** One load reads at most this many server pages, so a long run of replaced
 * versions cannot turn a single **Load more** into an unbounded scan. */
const MAX_PAGES_PER_LOAD = 5;
const ROWS_PER_LOAD = 20;

/** Pages through retained versions and keeps files that are deleted now, each path once.
 * The server lists versions newest expiry first, and a deleted file's copy expires a fixed
 * period after its deletion, so a path's first deleted version is its latest deletion. */
export class DeletedFileList {
	private readonly seen = new Set<string>();
	private readonly search: string;
	private readonly needle: string;
	private cursor?: string;
	private more = true;

	constructor(private readonly source: DeletedFileSource, search = '') {
		this.search = search.trim();
		// Encrypted names cannot be searched on the server, so the filter also runs here.
		this.needle = this.search.toLowerCase();
	}

	get hasMore(): boolean { return this.more; }

	async next(): Promise<RemoteFileVersion[]> {
		const found: RemoteFileVersion[] = [];
		for (let pages = 0; this.more && pages < MAX_PAGES_PER_LOAD && found.length < ROWS_PER_LOAD; pages++) {
			const page = await this.source.listVersions({ ...(this.search ? { search: this.search } : {}), ...(this.cursor ? { cursor: this.cursor } : {}) });
			const candidates: RemoteFileVersion[] = [];
			for (const version of page.versions) {
				if (version.reason !== 'deleted' || this.seen.has(version.path) || !version.path.toLowerCase().includes(this.needle)) continue;
				this.seen.add(version.path);
				candidates.push(version);
			}
			if (candidates.length) {
				const [remote, local] = await Promise.all([
					this.source.remotePaths(candidates.map(version => version.path)),
					Promise.all(candidates.map(version => this.source.localExists(version.path))),
				]);
				candidates.forEach((version, index) => { if (!remote.has(version.path) && !local[index]) found.push(version); });
			}
			this.cursor = page.nextCursor;
			this.more = page.hasMore && page.nextCursor !== undefined;
		}
		return found;
	}
}
