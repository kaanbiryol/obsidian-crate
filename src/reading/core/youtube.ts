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
