import React, { useEffect, useState } from 'react';
import { ToggleButton } from '../../ui/shared/ToggleButton';

interface ReadingTagFilterProps {
	/** Every tag in the library, read again whenever the loader changes. */
	load: () => Promise<string[]>;
	selected: string | null;
	onChange: (tag: string | null) => void;
}

/** Every tag in the library as one scrolling row. Choosing a tag filters the list; All clears it. */
export function ReadingTagFilter({ load, selected, onChange }: ReadingTagFilterProps) {
	const [tags, setTags] = useState<string[]>([]);
	useEffect(() => {
		let current = true;
		// A failed read keeps the last tags; the list itself reports connection problems.
		load().then(value => { if (current) setTags(value); }, () => {});
		return () => { current = false; };
	}, [load]);
	const shown = selected && !tags.includes(selected) ? [selected, ...tags] : tags;
	if (!shown.length) return null;
	return <div className="crate-reading-tag-filter" role="group" aria-label="Filter by tag">
		<ToggleButton className="crate-reading-tag-filter__chip" pressed={!selected} onPressedChange={() => onChange(null)}>All</ToggleButton>
		{shown.map(tag => <ToggleButton key={tag} className="crate-reading-tag-filter__chip" aria-label={tag} pressed={tag === selected}
			onPressedChange={pressed => onChange(pressed ? tag : null)}><span aria-hidden="true">#{tag}</span></ToggleButton>)}
	</div>;
}
