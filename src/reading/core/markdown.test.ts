import { expect, it } from 'vitest';
import { readingDocument } from './markdown';
import { readingLiterals } from './markdown-literals';

it.each([
	'', '$$', 'a $$ b', 'a\n$$', 'a\n   $$', 'a\n    $$', 'a\n\t$$', 'a\r$$', 'a\u2028 $$', 'x$$$\n $$$', 'a $$x$$\n\nb\n  $$\nc',
])('finds math blocks where a line-start search does: %j', source => {
	const mathBlock = readingLiterals.find(extension => extension.name === 'readingMathBlock') as { start(source: string): number };
	expect(mathBlock.start(source)).toBe(source.search(/^ {0,3}\$\$/m));
});

it('maps long notes in roughly linear time', () => {
	const transcript = (minutes: number) => {
		const lines = ['# Transcript', ''];
		for (let second = 0; second < minutes * 60; second += 4) lines.push(`**${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}** · ${second === 40 ? '==so this is where we talk==' : 'so this is where we talk'} about what matters most and why.`, '');
		return [...lines, '$$', 'x^2', '$$', ''].join('\n');
	};
	const small = transcript(60), large = transcript(240);
	const time = (work: () => void) => { const started = performance.now(); work(); return performance.now() - started; };
	// Both measurements do the same work when mapping is linear, so load on a shared machine affects them alike.
	let fourSmall = Infinity, oneLarge = Infinity;
	for (let run = 0; run < 6; run++) {
		const four = time(() => { for (let note = 0; note < 4; note++) readingDocument(small); }), one = time(() => readingDocument(large));
		if (run) { fourSmall = Math.min(fourSmall, four); oneLarge = Math.min(oneLarge, one); }
	}
	// Linear mapping takes about as long for one note four times the size; quadratic mapping about 3x as long.
	expect(oneLarge).toBeLessThan(fourSmall * 2);
}, 30_000);
