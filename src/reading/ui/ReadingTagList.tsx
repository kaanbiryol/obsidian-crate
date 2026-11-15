import React, { useEffect, useState } from 'react';
import { Button } from '../../ui/shared/Button';
import { EmptyState } from '../../ui/shared/EmptyState';
import { LoadingIndicator } from '@/ui/shared/LoadingIndicator';
import { TextField } from '../../ui/shared/TextField';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { ReadingDialog } from './ReadingDialog';

interface ReadingTagListProps {
	/** Every tag in the library, read once when the sheet opens. */
	load: () => Promise<string[]>;
	onSelect: (tag: string) => void;
	onClose: () => void;
}

/** Every tag in the library, searched on the device. Selecting one shows its articles. */
export function ReadingTagList({ load, onSelect, onClose }: ReadingTagListProps) {
	const [tags, setTags] = useState<string[] | null>(null), [error, setError] = useState<string | null>(null), [query, setQuery] = useState('');
	useEffect(() => {
		let current = true;
		load().then(value => { if (current) setTags(value); }, (cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : 'Tags are unavailable. Retry when connected.'); });
		return () => { current = false; };
	}, [load]);
	const search = query.trim().toLocaleLowerCase();
	const shown = tags?.filter(tag => tag.toLocaleLowerCase().includes(search)) ?? [];
	return <ReadingDialog title="Tags" fullHeight onClose={onClose}>{close => <div className="crate-reading-tag-list">
		<TextField fieldClassName="crate-reading-tag-list__search" label="Search tags" hideLabel type="search" placeholder="Search tags"
			leadingIcon={<ThemeIcon id="search" size="m" aria-hidden="true" />} value={query} onChange={event => setQuery(event.target.value)} />
		{error ? <p className="crate-reading__notice" role="alert">{error}</p>
			: !tags ? <LoadingIndicator label="Loading tags" />
			: shown.length ? <ul className="crate-reading-tag-list__tags">{shown.map(tag => <li key={tag}>
				<Button className="crate-reading-tag-list__tag" onClick={() => { onSelect(tag); close(); }}>
					<ThemeIcon id="hash" size="s" aria-hidden="true" /><span>{tag}</span>
				</Button>
			</li>)}</ul>
			: <EmptyState className="crate-reading__empty" icon="hash" title={tags.length ? 'No matching tags' : 'No tags yet'}
				description={tags.length ? 'Try another name.' : 'Add tags to an article to find them here.'} />}
	</div>}</ReadingDialog>;
}
