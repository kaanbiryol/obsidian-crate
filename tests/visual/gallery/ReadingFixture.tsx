import React, { useState } from 'react';
import { ReadingLibraryPanel } from '@/reading/ui/ReadingLibrary';
import { ReadingReader } from '@/reading/ui/Reader';
import type { ReadingItem } from '@/reading/core/model';
import { ReadingDialog } from '@/reading/ui/ReadingDialog';
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

export function ReadingFixture({ onAdd }: { onAdd: () => void }) {
	const immediateReaderReturn = new URLSearchParams(location.search).has('reading-back');
	const [items, setItems] = useState(() => new URLSearchParams(location.search).has('many') ? Array.from({ length: 250 }, (_, i) => ({ ...initial[i % initial.length]!, title: `Saved essay ${i + 1}`, crate_reading_id: `67de6c50-c70c-4c85-93f2-${i.toString().padStart(12, '0')}` })) : initial);
	const [article, setArticle] = useState<ReadingItem | null>(() => new URLSearchParams(location.search).has('reader') ? initial[0]! : null);
	const [adding, setAdding] = useState(false), [url, setUrl] = useState(''), [title, setTitle] = useState('');
	const update = async (item: ReadingItem, changes: Partial<ReadingItem>) => { setItems(items => items.map(current => current.crate_reading_id === item.crate_reading_id ? { ...current, ...changes } : current)); setArticle(current => current?.crate_reading_id === item.crate_reading_id ? { ...current, ...changes } : current); };
	return <><ReadingLibraryPanel snapshot={{ items, issues: [], loading: false, error: null }} onAdd={() => { onAdd(); setAdding(true); }}
		onOpen={async item => { setArticle(item); }} onRefresh={async () => {}}
		onUpdate={update} activeId={article?.crate_reading_id} readerMotion={immediateReaderReturn ? 'none' : undefined} reader={article && <ReadingReader item={article} markdown={body} status="Available offline" onBack={() => setArticle(null)} onUpdate={changes => update(article, changes)} onEdit={() => {}} />} />
		{adding && <ReadingDialog title="Save a link" onClose={() => setAdding(false)}><SaveLinkForm url={url} title={title} onUrl={setUrl} onTitle={setTitle} onSave={() => setAdding(false)} onCancel={() => setAdding(false)} saving={false} /></ReadingDialog>}
	</>;
}
