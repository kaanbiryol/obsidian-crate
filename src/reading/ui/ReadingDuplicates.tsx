import React from 'react';
import { Button } from '@/ui/shared/Button';
import type { ReadingItem } from '../core/model';
import { duplicateReadingGroups } from '../core/duplicates';

export function ReadingDuplicates({ items, onOpen, onEnrich, busy }: {
	items: ReadingItem[]; onOpen: (item: ReadingItem) => void;
	onEnrich?: (target: ReadingItem, source: ReadingItem) => void; busy: boolean;
}) {
	const groups = duplicateReadingGroups(items);
	if (!groups.length) return null;
	return <details className="crate-reading__notice"><summary>Review {groups.length} duplicate {groups.length === 1 ? 'source' : 'sources'}</summary>
		<p>These notes save the same source. Open each to compare. In Obsidian, move any extra note outside Reading after keeping the content you want.</p>
		{groups.map(group => <section key={group[0]!.crate_reading_id}><ul>{group.map(item => <li key={item.crate_reading_id}>
			<Button variant="ghost" disabled={busy} onClick={() => onOpen(item)}>{item.title}</Button><small>{item.path || 'Saving…'}</small>
			{onEnrich && item.path && item.capture_method === 'url' && group.filter(clip => clip.path && clip.capture_method === 'web-clipper').map(clip => <Button key={clip.crate_reading_id} variant="outline" disabled={busy} onClick={() => onEnrich(item, clip)}>Fill empty bookmark from {clip.title}</Button>)}
		</li>)}</ul></section>)}
		{onEnrich && <p>Filling an empty bookmark preserves its state and notes. The original clip stays in your vault.</p>}
	</details>;
}
