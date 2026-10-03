import React, { useId, useState } from 'react';
import type { ReadingItem } from '../core/model';
import type { ReadingHighlight } from '../core/highlights';
import { Button } from '../../ui/shared/Button';
import { ThemeIcon } from '../../ui/shared/ThemeIcon';
import { HighlightList } from './HighlightList';
import { groupReadingHighlights, readingTitle } from './reading-presentation';

type Entry = { item: ReadingItem; highlight: ReadingHighlight };

export function HighlightGroups({ entries, onView, disabled }: {
	entries: Entry[];
	onView: (item: ReadingItem, highlight: ReadingHighlight) => void;
	disabled: boolean;
}) {
	return <div className="crate-highlight-groups">{groupReadingHighlights(entries).map((group, index) => <HighlightGroup initiallyOpen={index === 0} key={group.item.crate_reading_id} entries={group.entries} onView={onView} disabled={disabled} />)}</div>;
}

function HighlightGroup({ entries, onView, disabled, initiallyOpen }: React.ComponentProps<typeof HighlightGroups> & { initiallyOpen: boolean }) {
	const [open, setOpen] = useState(initiallyOpen);
	const id = useId();
	const { item, highlight } = entries[0]!;
	const date = highlight.createdAt ?? item.saved_at;
	return <section className="crate-highlight-group" data-open={open || undefined}>
		<Button className="crate-highlight-group__header" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
			<span className="crate-highlight-group__copy"><strong>{readingTitle(item)}</strong><span>{entries.length} {entries.length === 1 ? 'highlight' : 'highlights'} · <time dateTime={date}>{new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time></span></span>
			<ThemeIcon id={open ? 'chevron-down' : 'chevron-right'} size="s" aria-hidden="true" />
		</Button>
		<div id={id} hidden={!open} className="crate-highlight-group__body">{open && <HighlightList entries={entries} hideSource onView={onView} disabled={disabled} />}</div>
	</section>;
}
