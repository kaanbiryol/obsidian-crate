import { expect, it } from 'vitest';
import { transcriptSegments, transcriptMoment, timestampSeconds } from './transcript';
import { readingDocument } from './markdown';
import { readingUrlIdentity } from './model';
import { youtubeStartTime } from './youtube';

it('recognizes Clipper paragraphs and preserves Markdown highlight offsets', () => {
	const markdown = '# Transcript\n\n**0:32** · First passage.\n\n**1:02:03** · A ==saved== passage.\n';
	const text = readingDocument(markdown).text;
	const segments = transcriptSegments(markdown);
	expect(segments.map(segment => segment.seconds)).toEqual([32, 3723]);
	const start = text.indexOf('saved');
	expect(transcriptMoment(segments, start, start + 5)).toBe(3723);
	expect(transcriptMoment(segments, 0, 1)).toBeUndefined();
});

it('recognizes timestamp links but ignores scripts and rejects reordered timing', () => {
	expect(transcriptSegments('[0:42](https://youtube.com/watch?v=jNQXAC9IVRw&t=42) Hello there.\n\n<script>hidden</script>\n\n**1:00** · Next.').map(segment => segment.seconds)).toEqual([42, 60]);
	expect(transcriptSegments('**0:42** · First\n\n**0:03** · Second')).toEqual([]);
	expect(timestampSeconds('1:99')).toBeNull();
});

it('deduplicates video variants while preserving article query identity', () => {
	const expected = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
	for (const url of ['https://youtu.be/jNQXAC9IVRw?t=42', 'https://m.youtube.com/shorts/jNQXAC9IVRw', `${expected}&list=abc#t=10`]) expect(readingUrlIdentity(url)).toBe(expected);
	expect(readingUrlIdentity('https://example.com/?id=1')).not.toBe(readingUrlIdentity('https://example.com/?id=2'));
	expect(youtubeStartTime('https://youtu.be/jNQXAC9IVRw?t=1h2m3s')).toBe(3723);
	expect(youtubeStartTime('https://youtu.be/jNQXAC9IVRw?t=-10')).toBe(0);
});
