/** Compact relative time, as in "Synced 5m ago": "just now", "5m ago", "3h ago" or "2d ago". */
export function formatTimeAgo(time: number, now = Date.now()): string {
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** Binary units, like the KiB and MiB limits Crate states elsewhere. */
export function formatSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
