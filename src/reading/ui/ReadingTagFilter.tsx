import React, { useMemo, useState } from 'react';
import { ToggleButton } from '../../ui/shared/ToggleButton';
import { Button } from '../../ui/shared/Button';
import { TextField } from '../../ui/shared/TextField';
import { ThemeIcon } from '../../ui/shared/ThemeIcon';
import { IconButton } from '../../ui/shared/IconButton';
import type { ReadingTag } from '../core/reading-presentation';
import { ReadingDialog } from './ReadingDialog';

/** Tags shown in the row before **More** opens the full list. */
const READING_TAG_ROW_LIMIT = 6;

interface ReadingTagFilterProps {
	/** The section's tags, most used first. */
	tags: ReadingTag[];
	selected: string | null;
	onChange: (tag: string | null) => void;
}

/** The most used tags as one row, the selected tag first; **More** lists and searches every tag.
 * Choosing a tag filters the list; All clears it. */
export function ReadingTagFilter({ tags, selected, onChange }: ReadingTagFilterProps) {
	const [open, setOpen] = useState(false);
	if (!tags.length && !selected) return null;
	const top = tags.slice(0, READING_TAG_ROW_LIMIT).map(tag => tag.name);
	const shown = selected && !top.includes(selected) ? [selected, ...top] : top;
	const hidden = tags.length - top.length;
	return <div className="crate-reading-tag-filter" role="group" aria-label="Filter by tag">
		<ToggleButton className="crate-reading-tag-filter__chip" pressed={!selected} onPressedChange={() => onChange(null)}>All</ToggleButton>
		{shown.map(tag => <ToggleButton key={tag} className="crate-reading-tag-filter__chip" aria-label={tag} pressed={tag === selected}
			onPressedChange={pressed => onChange(pressed ? tag : null)}><span aria-hidden="true">#{tag}</span></ToggleButton>)}
		{hidden > 0 && <Button className="crate-reading-tag-filter__chip crate-reading-tag-filter__more" aria-haspopup="dialog" aria-label={`All tags, ${hidden} more`}
			onClick={() => setOpen(true)}>More<ThemeIcon id="chevron-down" size="xs" aria-hidden="true" /></Button>}
		{open && <ReadingDialog title="Tags" fullHeight onClose={() => setOpen(false)}>
			{close => <ReadingTagList tags={tags} selected={selected} onChange={tag => { onChange(tag); close(); }} />}
		</ReadingDialog>}
	</div>;
}

/** Every tag, searchable, with its note count when known. */
function ReadingTagList({ tags, selected, onChange }: ReadingTagFilterProps) {
	const [search, setSearch] = useState('');
	const matched = useMemo(() => {
		const term = search.trim().replace(/^#+/, '').toLocaleLowerCase();
		return term ? tags.filter(tag => tag.name.toLocaleLowerCase().includes(term)) : tags;
	}, [tags, search]);
	return <div className="crate-reading-tag-list">
		<TextField fieldClassName="crate-reading-tag-list__search" label="Search tags" hideLabel type="search" placeholder="Search tags" data-initial-focus
			autoCapitalize="none" autoComplete="off" spellCheck={false} leadingIcon={<ThemeIcon id="search" size="m" aria-hidden="true" />}
			value={search} onChange={event => setSearch(event.target.value)}
			trailingAction={search && <IconButton size="large" icon="x" label="Clear search" onClick={() => setSearch('')} />} />
		{matched.length
			? <ul className="crate-reading-tag-list__items" aria-label="Tags">
				{matched.map(tag => <li key={tag.name}>
					<Button className="crate-reading-tag-list__item" aria-pressed={tag.name === selected} onClick={() => onChange(tag.name === selected ? null : tag.name)}>
						<span className="crate-reading-tag-list__name">#{tag.name}</span>
						<span className="crate-reading-tag-list__count" aria-label={`${tag.count} ${tag.count === 1 ? 'note' : 'notes'}`}>{tag.count}</span>
						{tag.name === selected && <ThemeIcon id="check" size="s" aria-hidden="true" />}
					</Button>
				</li>)}
			</ul>
			: <p className="crate-reading-tag-list__empty">No matching tags</p>}
	</div>;
}
