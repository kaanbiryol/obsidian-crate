/** Recognize video links only; playlists, channels, and lookalike hosts stay ordinary links. */
export function youtubeVideoId(source: string): string | null {
	try {
		const url = new URL(source);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
		let id: string | null = null;
		if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') id = /^\/([\w-]+)\/?$/.exec(url.pathname)?.[1] ?? null;
		else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
			id = /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([\w-]+)\/?$/.exec(url.pathname)?.[1] ?? null;
		} else if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) id = /^\/embed\/([\w-]+)\/?$/.exec(url.pathname)?.[1] ?? null;
		return id && /^[\w-]{11}$/.test(id) ? id : null;
	} catch { return null; }
}

export function youtubeStartTime(source: string): number {
	try {
		const url = new URL(source), raw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? url.hash.replace(/^#t=/, '');
		const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw);
		const seconds = match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : 0;
		return Number.isSafeInteger(seconds) && seconds <= 604800 ? seconds : 0;
	} catch { return 0; }
}

export function youtubeMomentUrl(source: string, seconds: number): string {
	const id = youtubeVideoId(source);
	return id ? `https://www.youtube.com/watch?v=${id}&t=${Math.max(0, Math.floor(seconds))}s` : source;
}
