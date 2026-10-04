import React, { useState } from 'react';
import type { ReadingItem } from '../core/model';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { TextField } from '../../ui/shared/TextField';
import { ThemeIcon } from '../../ui/shared/ThemeIcon';
import { ReadingDialog } from './ReadingDialog';
import { readingTitle } from './reading-presentation';

export function HighlightArticleFilter({ items, value, onChange }: { items: ReadingItem[]; value: string; onChange: (value: string) => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const articles = items.filter(item => item.highlights?.length);
	const selected = articles.find(item => item.crate_reading_id === value);
	const matches = articles.filter(item => `${readingTitle(item)} ${item.author ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	return <div className="crate-highlight-filter">
		<Button variant="outline" className="crate-highlight-filter__trigger" data-filtered={Boolean(selected) || undefined} aria-label={`Filter by article: ${selected ? readingTitle(selected) : 'All articles'}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setQuery(''); setOpen(true); }}><span>{selected ? readingTitle(selected) : 'All articles'}</span><ThemeIcon id="chevron-down" size="xs" aria-hidden="true" /></Button>
		{value && <IconButton icon="x" label="Clear article filter" onClick={() => onChange('')} />}
		{open && <ReadingDialog fullHeight title="Filter by article" onClose={() => setOpen(false)}>{close => <div className="crate-highlight-picker">
			<TextField label="Search articles" hideLabel type="search" placeholder="Search articles" value={query} onChange={event => setQuery(event.target.value)} />
			{[{ id: '', title: 'All articles', count: articles.reduce((total, item) => total + (item.highlights?.length ?? 0), 0) }, ...matches.map(item => ({ id: item.crate_reading_id, title: readingTitle(item), count: item.highlights!.length }))].map(option => <Button key={option.id} className="crate-highlight-picker__option" aria-pressed={value === option.id} onClick={() => { onChange(option.id); close(); }}><span>{option.title}<small>{option.count} {option.count === 1 ? 'highlight' : 'highlights'}</small></span>{value === option.id && <ThemeIcon id="check" size="s" aria-hidden="true" />}</Button>)}
			{matches.length === 0 && <p role="status">No matching articles</p>}
		</div>}</ReadingDialog>}
	</div>;
}
