import React, { useState } from 'react';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';

export function ReadingVideoThumbnail({ id, large = false }: { id: string; large?: boolean }) {
	const [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false);
	return <span className="crate-reading-video__thumbnail" data-large={large} aria-hidden="true">
		{!failed && <img src={`https://i.ytimg.com/vi/${id}/${large ? 'hqdefault' : 'mqdefault'}.jpg`} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" data-loaded={loaded} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
		<span className="crate-reading-video__play"><ThemeIcon id="play" size={large ? 'l' : 's'} aria-hidden="true" /></span>
	</span>;
}

export function ReadingVideo({ id, source }: { id: string; source: string }) {
	return <div className="crate-reading-video">
		<a className="crate-reading-video__watch" href={source} target="_blank" rel="noopener noreferrer">
			<ReadingVideoThumbnail key={id} id={id} large />
			<span className="crate-reading-video__label">Watch on YouTube<ThemeIcon id="arrow-up-right" size="s" aria-hidden="true" /></span>
		</a>
		<p className="crate-reading-video__hint">An internet connection is needed to watch.</p>
	</div>;
}
