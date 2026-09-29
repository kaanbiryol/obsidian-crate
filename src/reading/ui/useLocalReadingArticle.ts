import { useCallback, useEffect, useRef, useState } from 'react';
import { Notice } from 'obsidian';
import type { ReadingLibrary } from '../data/library';
import type { ReadingChanges, ReadingItem } from '../core/model';
import type { ReadingHighlight } from '../core/highlights';

type Article = Awaited<ReturnType<ReadingLibrary['read']>>;
interface OpenedArticle { library: ReadingLibrary; article: Article; highlight?: ReadingHighlight }

/** Navigation and library replacement invalidate every pending reader publication. */
export function useLocalReadingArticle(library: ReadingLibrary, items: ReadingItem[]) {
	const [opened, setOpened] = useState<OpenedArticle | null>(null);
	const navigation = useRef(0);
	const article = opened?.library === library ? opened.article : null;
	const item = article && (items.find(item => item.crate_reading_id === article.item.crate_reading_id) ?? article.item);
	useEffect(() => {
		const requests = navigation;
		requests.current++;
		setOpened(null);
		return () => { requests.current++; };
	}, [library]);

	const open = useCallback(async (item: ReadingItem, highlight?: ReadingHighlight) => {
		const request = ++navigation.current;
		try {
			const article = await library.read(item);
			if (request === navigation.current) setOpened({ library, article, highlight });
		} catch (error) { if (request === navigation.current) throw error; }
	}, [library]);
	const close = useCallback(() => {
		navigation.current++;
		setOpened(null);
	}, []);

	useEffect(() => {
		if (!item || !article || (item.extraction_status === article.item.extraction_status && JSON.stringify(item.highlights) === JSON.stringify(article.item.highlights))) return;
		let active = true;
		const request = navigation.current;
		void library.read(item).then(article => {
			if (active && request === navigation.current) setOpened(current => current && { ...current, article });
		}).catch(() => {
			if (active && request === navigation.current) new Notice('Reopen the article to read its latest text and highlights.');
		});
		return () => { active = false; };
	}, [article, item, library]);

	const update = async (changes: ReadingChanges) => {
		if (!item) return;
		const request = navigation.current;
		try {
			await library.update(item, changes);
			if (request !== navigation.current) return;
			const article = await library.read({ ...item, ...changes });
			if (request === navigation.current) setOpened(current => current && { ...current, article });
		} catch (error) { if (request === navigation.current) throw error; }
	};
	return { article, item, focusHighlight: article ? opened?.highlight : undefined, open, close, update };
}
