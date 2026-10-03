import React, { useState } from 'react';
import { ReadingLibraryPanel, type ReadingLibraryProps } from '@/reading/ui/ReadingLibrary';
import { ReadingReader } from '@/reading/ui/Reader';
import type { ReadingItem } from '@/reading/core/model';
import { ReadingDialog } from '@/reading/ui/ReadingDialog';
import { SaveLinkDialog } from '@/reading/ui/SaveLinkDialog';
import { SaveLinkForm } from '@/reading/ui/SaveLinkForm';

const initial: ReadingItem[] = [{
	crate_reading_version: 1, crate_reading_id: '67de6c50-c70c-4c85-93f2-a048d9f33b1a',
	title: 'The pleasure of reading slowly', source_url: 'https://example.com/essays/reading',
	saved_at: '2026-09-21T10:00:00.000Z', reading_status: 'inbox', favorite: false, tags: ['essays', 'reading'],
	extraction_status: 'ready', capture_method: 'web-clipper', path: 'Reading/Essay.md', author: 'Alex Reader',
}, {
	crate_reading_version: 1, crate_reading_id: '93142f91-1b7c-4c68-bbdc-17ec70d34c75',
	title: 'A field guide to finding your next favorite place', source_url: 'https://journal.example.org/places',
	saved_at: '2026-09-20T11:00:00.000Z', reading_status: 'inbox', favorite: true, tags: [],
	extraction_status: 'pending', capture_method: 'url', path: 'Reading/Place.md',
}];
initial.push(...[
	['Good design is as little design as possible', 'https://design.example.org/less', 'design'],
	['The art of paying attention', 'https://essays.example.org/attention', 'essays'],
	['A small guide to doing less, better', 'https://journal.example.org/less', 'ideas'],
	['On walking without a destination', 'https://outside.example.org/walking', 'life'],
].map(([title, source_url, tag], index): ReadingItem => ({ ...initial[0]!, title: title!, source_url: source_url!, tags: [tag!], author: undefined,
	crate_reading_id: `5a2786df-f5da-4937-b9c3-83db99c88cc${index}`, saved_at: `2026-09-${index < 2 ? '20' : '18'}T0${9 - index}:00:00.000Z`, path: `Reading/Article-${index}.md`, favorite: index === 1,
})));
const videos: ReadingItem[] = [
	{ ...initial[0]!, title: 'A day at the museum', author: 'The curious channel', source_url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=42s', capture_method: 'url' },
	{ ...initial[1]!, title: 'youtu.be', source_url: 'https://youtu.be/aqz-KE-bpKQ?t=30', extraction_status: 'unavailable', favorite: false },
	{ ...initial[2]!, title: 'youtube.com', source_url: 'https://youtube.com/shorts/ScMzIvxBSi4', extraction_status: 'pending', capture_method: 'url' },
];
const body = `A good article deserves more than a passing glance. Save something that catches your attention, and return when you have a little time.

## Make room for the interesting things

There is no finish line. Read at your own pace, keep what you love, and let the rest go.

- A collection of thoughtful essays
- Ideas to come back to
- Notes that stay yours

> Leave yourself a little space to think.

Here is a [relative link](/more), and a code sample:

\`\`\`js
const reading = ['one good thing', 'another'];
\`\`\`

| Source | Status |
| --- | --- |
| Web clipper | Saved |

<img src="https://tracking.invalid/pixel" onerror="window.__readingAttack = true">
<script>window.__readingAttack = true;</script>
<iframe src="https://tracking.invalid/embed"></iframe>
<svg onload="window.__readingAttack = true"></svg>
[Unsafe link](javascript:alert(1))
<a href="https://user:password@example.com/private">Embedded credentials</a>
<form action="https://tracking.invalid"><input autofocus name="name"></form>
`;

export function ReadingFixture({ onAdd, renderNavigation, renderLibraryContent, listStyle }: { listStyle?: ReadingLibraryProps['listStyle']; onAdd: () => void; renderNavigation?: ReadingLibraryProps['renderNavigation']; renderLibraryContent?: ReadingLibraryProps['renderLibraryContent'] }) {
	const videoFixture = new URLSearchParams(location.search).has('reading-video');
	const immediateReaderReturn = new URLSearchParams(location.search).has('reading-back');
	const [items, setItems] = useState(() => videoFixture ? videos : new URLSearchParams(location.search).has('highlight-library') ? initial.slice(0, 3).map((item, index) => ({ ...item, highlights: [{ start: 0, end: 14, text: 'A good article', note: index === 0 ? 'Revisit this idea' : undefined, createdAt: `2026-09-${23 - index}T10:00:00Z` }] })) : new URLSearchParams(location.search).has('empty') ? [] : new URLSearchParams(location.search).has('many') ? Array.from({ length: 250 }, (_, i) => ({ ...initial[i % initial.length]!, title: `Saved essay ${i + 1}`, crate_reading_id: `67de6c50-c70c-4c85-93f2-${i.toString().padStart(12, '0')}` })) : new URLSearchParams(location.search).has('vault-note') ? [{ ...initial[0]!, title: 'A vault note', source_url: '' }] : initial);
	const [article, setArticle] = useState<ReadingItem | null>(() => new URLSearchParams(location.search).has('reader') ? initial[0]! : null);
	const [adding, setAdding] = useState(false), [url, setUrl] = useState('');
	const update = async (item: ReadingItem, changes: Partial<ReadingItem>) => {
		if (new URLSearchParams(location.search).has('reader-delayed-update')) {
			await new Promise<void>((resolve, reject) => window.addEventListener('reading-settle-update', event => {
				if ((event as CustomEvent).detail === 'fail') reject(new Error('Could not save article.')); else resolve();
			}, { once: true }));
		}
		setItems(items => items.map(current => current.crate_reading_id === item.crate_reading_id ? { ...current, ...changes } : current)); setArticle(current => current?.crate_reading_id === item.crate_reading_id ? { ...current, ...changes } : current); };
	return <><ReadingLibraryPanel listStyle={listStyle} renderNavigation={renderNavigation} renderLibraryContent={renderLibraryContent} snapshot={{ items, issues: [], loading: false, error: null }} onAdd={() => { onAdd(); setAdding(true); }}
		onOpen={async item => { setArticle(item); }} onRefresh={async () => {}}
		activeId={article?.crate_reading_id} readerMotion={immediateReaderReturn ? 'none' : renderNavigation ? 'slide' : undefined} reader={article && <ReadingReader floatingHighlights item={article} markdown={videoFixture ? (article.extraction_status === 'ready' ? 'My notes: revisit the sculpture gallery.' : '') : body + (article.source_url ? '' : '\n[absolute link](https://example.com/more)')} status={videoFixture ? "Details available offline" : "Available offline"} onBack={() => setArticle(null)} onUpdate={changes => update(article, changes)} onEdit={() => {}} />} />
		{adding && (new URLSearchParams(location.search).get('host') === 'plugin' ? <SaveLinkDialog variant={innerWidth > 600 ? 'centered' : 'bottom-sheet'} url={url} onUrl={setUrl} saving={false} onClose={() => setAdding(false)} onSave={() => setAdding(false)} /> : <ReadingDialog title="Save a link" onClose={() => setAdding(false)}><SaveLinkForm url={url} onUrl={setUrl} onSave={() => setAdding(false)} onCancel={() => setAdding(false)} saving={false} /></ReadingDialog>)}
	</>;
}
