import { expect, it } from 'vitest';
import { youtubeVideoId } from './youtube';

it.each([
	'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=42s&list=PL123',
	'https://youtu.be/jNQXAC9IVRw?si=share&t=42',
	'https://m.youtube.com/shorts/jNQXAC9IVRw',
	'https://youtube.com/live/jNQXAC9IVRw#t=42',
	'https://music.youtube.com/watch?v=jNQXAC9IVRw',
	'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?start=42',
])('recognizes a video without changing its saved URL: %s', source => {
	expect(youtubeVideoId(source)).toBe('jNQXAC9IVRw');
});

it.each([
	'', 'https://youtube.com/playlist?list=PL123', 'https://youtube.com/@channel',
	'https://youtube.com/watch?v=short', 'https://youtu.be/jNQXAC9IVRw/extra',
	'https://youtube.com.evil.example/watch?v=jNQXAC9IVRw',
	'https://evil.example/?url=https://youtube.com/watch?v=jNQXAC9IVRw',
	'https://user:pass@youtube.com/watch?v=jNQXAC9IVRw',
	'https://youtube.com:8443/watch?v=jNQXAC9IVRw',
	'ftp://youtube.com/watch?v=jNQXAC9IVRw',
])('leaves non-video and unsafe URLs alone: %s', source => {
	expect(youtubeVideoId(source)).toBeNull();
});
