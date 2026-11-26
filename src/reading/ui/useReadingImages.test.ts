import { act } from 'react';
import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { READING_IMAGE_PATH_ATTRIBUTE } from './reading-content';
import { useReadingImages } from './useReadingImages';

it('loads at most four of an article\'s images at once and shows them all', async () => {
	const { document } = parseHTML('<html><body></body></html>');
	const content = document.createDocumentFragment();
	const paths = Array.from({ length: 10 }, (_, n) => `Reading/${n}.png`);
	for (const path of paths) {
		const image = document.createElement('img');
		image.setAttribute(READING_IMAGE_PATH_ATTRIBUTE, path);
		content.append(image);
	}
	const waiting: Array<() => void> = [];
	let loading = 0, most = 0;
	const load = (path: string) => new Promise<string>(resolve => {
		most = Math.max(most, ++loading);
		waiting.push(() => { loading--; resolve(`blob:${path}`); });
	});
	const host = { remote: false, notePath: 'Reading/Article.md', load };
	const hook = renderHook(() => useReadingImages(content, host));
	expect(waiting).toHaveLength(4);
	for (let finished = 0; finished < paths.length; finished++) {
		await act(async () => { waiting.shift()!(); await Promise.resolve(); });
	}
	expect(most).toBe(4);
	expect(waiting).toHaveLength(0);
	expect(Array.from(hook.current.querySelectorAll('img'), image => image.getAttribute('src'))).toEqual(paths.map(path => `blob:${path}`));
});

it('starts no more image loads once the article closes', async () => {
	const { document } = parseHTML('<html><body></body></html>');
	const content = document.createDocumentFragment();
	for (let n = 0; n < 10; n++) {
		const image = document.createElement('img');
		image.setAttribute(READING_IMAGE_PATH_ATTRIBUTE, `Reading/${n}.png`);
		content.append(image);
	}
	const waiting: Array<() => void> = [];
	const load = (path: string) => new Promise<string>(resolve => { waiting.push(() => resolve(`blob:${path}`)); });
	const hook = renderHook(() => useReadingImages(content, { remote: false, notePath: 'Reading/Article.md', load }));
	expect(waiting).toHaveLength(4);
	hook.unmount();
	for (const finish of waiting.splice(0)) await act(async () => { finish(); await Promise.resolve(); });
	expect(waiting).toHaveLength(0);
});
