import { describe, expect, it, vi } from 'vitest';
import { DOMParser, parseHTML } from 'linkedom';
import { applyLocalArticle, assembleReadingArticle, managedArticle } from './article';
import { ARTICLE_END, ARTICLE_START, MAX_READING_BYTES, MAX_READING_TITLE_LENGTH } from './model';
import { createReadingNote, parseReadingNote } from './notes';
import { patchReadingFrontmatter, readReadingFrontmatter } from './frontmatter';

const note = () => createReadingNote({
	id: 'c700b5b4-006c-4d2a-8efb-a99b838d9224', url: 'https://example.com/article', savedAt: '2026-10-01T12:00:00Z',
});

describe('Reading article assembly', () => {
	it.each(['capture', 'extraction', 'local'] as const)('preserves unowned bytes while enriching a %s', kind => {
		const source = '\uFEFF' + note().replace('tags: []', "tags: [kept]\ncustom: { keep: 'spacing' } # comment")
			.replace(/\n/g, '\r\n') + '\r\nMy personal notes.\r\n';
		const article = { markdown: '# Extracted\n\nArticle text.', title: 'Article', author: 'Writer',
			faviconUrl: 'https://example.com/favicon.ico', transcript: { source: 'youtube' as const, language: 'en' } };
		const { content, title } = assembleReadingArticle(source, parseReadingNote(source)!, {
			kind, article, block: managedArticle(source)!,
		});
		expect(title).toBe('Article');
		expect(parseReadingNote(content)).toMatchObject({ title: 'Article', author: 'Writer', tags: ['kept'],
			favicon_url: 'https://example.com/favicon.ico', transcript_source: 'youtube', transcript_language: 'en', extraction_status: 'ready' });
		expect(content.startsWith('\uFEFF---\r\n')).toBe(true);
		expect(content).toContain("custom: { keep: 'spacing' } # comment\r\n");
		expect(content.slice(content.indexOf(ARTICLE_START))).toBe(
			`${ARTICLE_START}\n\n# Extracted\n\nArticle text.\n\n${ARTICLE_END}\r\n\r\nMy personal notes.\r\n`,
		);
		expect(content).toContain('transcript_source: "youtube"\r\ntranscript_language: "en"\r\nauthor: "Writer"\r\nfavicon_url: "https://example.com/favicon.ico"\r\n---');
	});

	it.each(['capture', 'extraction', 'local'] as const)('retains an authored title and applies the %s author/icon policy', kind => {
		const source = patchReadingFrontmatter(note(), { title: 'My title', author: 'My author', favicon_url: 'https://example.com/mine.ico' });
		const { content, title } = assembleReadingArticle(source, parseReadingNote(source)!, { kind, block: managedArticle(source)!,
			article: { markdown: 'Article', title: 'Extracted title', author: 'Extracted author', faviconUrl: 'https://example.com/new.ico' } });
		expect(title).toBe('My title');
		expect(parseReadingNote(content)).toMatchObject({ title: 'My title',
			author: kind === 'capture' ? 'Extracted author' : 'My author',
			favicon_url: kind === 'capture' ? 'https://example.com/new.ico' : 'https://example.com/mine.ico' });
	});

	it.each(['capture', 'extraction', 'local'] as const)('preserves the existing %s handling of blank and padded titles', kind => {
		const source = note(), metadata = parseReadingNote(source)!, block = managedArticle(source)!;
		for (const title of ['', '   ', '  An article  ']) {
			const result = assembleReadingArticle(source, metadata, { kind, block, article: { markdown: 'Article', title } });
			const expected = title === '' || kind === 'capture' && title.trim() === '' ? 'example.com' : title;
			expect(result.title).toBe(expected);
			expect(readReadingFrontmatter(result.content)?.value.title).toBe(expected);
		}
	});

	it.each(['capture', 'extraction'] as const)('keeps existing body and metadata when a %s has no article', kind => {
		const source = patchReadingFrontmatter(note(), { transcript_source: 'youtube', transcript_language: 'de', resolved_url: 'https://example.com/previous' })
			.replace('title: "example.com"', "title: 'example.com' # original spelling")
			.replace(ARTICLE_END, `Existing managed text.\n${ARTICLE_END}`) + '\nPersonal text.\n';
		const { content } = assembleReadingArticle(source, parseReadingNote(source)!, {
			kind, block: managedArticle(source)!, article: null, resolvedUrl: 'https://example.com/new',
		});
		const expected = source.replace('extraction_status: "pending"', 'extraction_status: "unavailable"');
		expect(content).toBe(kind === 'capture' ? expected.replace("title: 'example.com' # original spelling", 'title: "example.com"') : expected);
		expect(parseReadingNote(content)).toMatchObject({ transcript_source: 'youtube', transcript_language: 'de', resolved_url: 'https://example.com/previous' });
	});

	it.each(['capture', 'extraction'] as const)('stores resolved URLs and retains transcript language for a %s', kind => {
		const source = patchReadingFrontmatter(note(), { transcript_source: 'youtube', transcript_language: 'de' });
		const { content } = assembleReadingArticle(source, parseReadingNote(source)!, { kind, block: managedArticle(source)!,
			article: { markdown: 'Transcript', transcript: { source: 'youtube' } }, resolvedUrl: 'https://example.com/final' });
		expect(parseReadingNote(content)).toMatchObject({ transcript_source: 'youtube', transcript_language: 'de', resolved_url: 'https://example.com/final' });
	});

	it('marks an empty video ready in every publication', () => {
		const source = note(), metadata = parseReadingNote(source)!;
		const article = { markdown: '', title: 'Video' };
		const local = applyLocalArticle(source, { ...metadata, path: 'Reading/Video.md' }, article);
		expect(parseReadingNote(local)?.extraction_status).toBe('ready');
		for (const kind of ['capture', 'extraction'] as const) {
			const { content } = assembleReadingArticle(source, metadata, { kind, block: managedArticle(source)!, article });
			expect(parseReadingNote(content)?.extraction_status).toBe('ready');
		}
	});

	it('keeps size validation at the existing publication boundary', () => {
		const source = note(), metadata = parseReadingNote(source)!, block = managedArticle(source)!;
		const article = { markdown: 'é'.repeat(MAX_READING_BYTES / 2) };
		expect(() => assembleReadingArticle(source, metadata, { kind: 'extraction', article, block })).toThrow('Reading note is larger than 1 MB.');
		expect(() => applyLocalArticle(source, { ...metadata, path: 'Reading/Article.md' }, article)).toThrow('Reading note is larger than 1 MB.');
		// Capture extraction bounds article size before assembly; its initial note is
		// patched before inserting text. Keep that boundary unchanged in this refactor.
		const captured = assembleReadingArticle(source, metadata, { kind: 'capture', article });
		expect(new TextEncoder().encode(captured.content).byteLength).toBeGreaterThan(MAX_READING_BYTES);
	});

	it.each(['capture', 'extraction', 'local'] as const)('breaks plugin code from the page in a %s', kind => {
		const source = note(), block = managedArticle(source)!;
		const markdown = [
			'Templater \\<%\\* await app.vault.delete(file) %\\> and `<% tp.date.now() %>`',
			'',
			'Inline `$= dv.current()` and <code>$=dv.pages()</code>',
			'',
			'```dataviewjs',
			'dv.paragraph("<% tp.file.title %>")',
			'```',
			'',
			'> ```JS-Engine title="x"',
			'> return 1',
			'> ```',
			'',
			'- Item',
			'\t```tasks',
			'\tfilter by function true',
			'\t```',
		].join('\n');
		const article = { markdown, title: '<%* tR += app.vault.getName() %>', author: '<% tp.user.name() %>' };
		const { content, title } = kind === 'local'
			? { content: applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, article), title: undefined }
			: assembleReadingArticle(source, parseReadingNote(source)!, { kind, article, block });
		expect(content).not.toContain('<%');
		expect(content).not.toContain('$=');
		expect(content).not.toMatch(/^[\t >]*`{3,}\s*(?:dataviewjs|js-engine|tasks)/im);
		expect(managedArticle(content)!.text).toBe(`\n\n${[
			'Templater \\<\u200B%\\* await app.vault.delete(file) %\\> and `<\u200B% tp.date.now() %>`',
			'',
			'Inline `$\u200B= dv.current()` and <code>\u200B$\u200B=dv.pages()</code>',
			'',
			'```',
			'dv.paragraph("<\u200B% tp.file.title %>")',
			'```',
			'',
			'> ``` title="x"',
			'> return 1',
			'> ```',
			'',
			'- Item',
			'\t```',
			'\tfilter by function true',
			'\t```',
		].join('\n')}\n\n`);
		expect(parseReadingNote(content)).toMatchObject({ title: '<\u200B%* tR += app.vault.getName() %>', author: '<\u200B% tp.user.name() %>' });
		if (title !== undefined) expect(title).toBe('<\u200B%* tR += app.vault.getName() %>');
	});

	it.each(['capture', 'extraction', 'local'] as const)('saves a maximum-length title and author with Templater tags in a %s', kind => {
		const source = note(), block = managedArticle(source)!;
		const long = '<% ' + 'a'.repeat(MAX_READING_TITLE_LENGTH - 3), saved = `<\u200B% ${'a'.repeat(MAX_READING_TITLE_LENGTH - 4)}`;
		const article = { markdown: 'Article text.', title: long, author: long };
		const content = kind === 'local'
			? applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, article)
			: assembleReadingArticle(source, parseReadingNote(source)!, { kind, article, block }).content;
		expect(parseReadingNote(content)).toMatchObject({ title: saved, author: saved });
	});

	it('keeps ordinary code blocks and drops executable languages even from fence examples', () => {
		const source = note(), metadata = parseReadingNote(source)!;
		const kept = [
			'```ts',
			'const total = items.reduce((sum, item) => sum + item.price, 0);',
			'```',
			'',
			'~~~python',
			'print("tilde")',
			'~~~',
		];
		// No Markdown reading decides which fence is real, so examples lose the language too.
		const example = (language: string) => [
			'````markdown',
			'```' + language,
			'dv.paragraph("example")',
			'```',
			'````',
			'',
			'```` ```' + language + ' ```` starts a Dataview block, and `dv.view()` loads a script.',
		];
		const content = applyLocalArticle(source, { ...metadata, path: 'Reading/Article.md' }, { markdown: [...kept, '', ...example('dataviewjs')].join('\n') });
		expect(managedArticle(content)!.text).toBe(`\n\n${[...kept, '', ...example('')].join('\n')}\n\n`);
	});

	it('breaks every Dataview inline JavaScript prefix, in code or prose', () => {
		const source = note(), metadata = parseReadingNote(source)!;
		const markdown = [
			'Prices: a $= b, `x $= y` and \\`$= escaped\\`.',
			'',
			'```js',
			'a $= b',
			'$= later lines',
			'```',
			'',
			'Run `$= dv.pages()`, `` $=dv.current() `` or <code class="x>y">$= dv.view()</code>.',
			'',
			'-     $= dv.pages()',
		].join('\n');
		const content = applyLocalArticle(source, { ...metadata, path: 'Reading/Article.md' }, { markdown });
		expect(managedArticle(content)!.text).toBe(`\n\n${markdown.split('$=').join('$\u200B=').replace('<code class="x>y">', '<code class="x>y">\u200B')}\n\n`);
	});

	it('breaks raw HTML code whose prefix is split across elements', () => {
		const source = note(), metadata = parseReadingNote(source)!;
		const markdown = 'A note<sup><code><b>$</b>=dv.el("p", "x")</code></sup> and <CODE\ntitle="a"><i>$</i>=dv.el("p", "y")</CODE>.';
		const text = managedArticle(applyLocalArticle(source, { ...metadata, path: 'Reading/Article.md' }, { markdown }))!.text;
		expect(text).toContain('<code>\u200B<b>$</b>=');
		expect(text).toContain('<CODE\ntitle="a">\u200B<i>$</i>=');
	});

	it('breaks plugin code in Markdown converted by Defuddle', async () => {
		vi.stubGlobal('window', { DOMParser });
		try {
			// Defuddle's Markdown converter detects the DOM parser when it loads.
			const { articleMarkdown } = await import('../extraction/markdown');
			const html = `<p>Run &lt;%* await app.vault.adapter.remove("a") %&gt; or <code>$= dv.current()</code>.</p>
				<pre><code class="language-dataviewjs">dv.paragraph("x")</code></pre>
				<pre><code data-lang="js-engine">return 1</code></pre>
				<pre><code class="language-ts">const value = 1;</code></pre>`;
			const markdown = articleMarkdown(parseHTML(`<html><body>${html}</body></html>`).document.body, 'https://example.com/article');
			const source = note();
			const text = managedArticle(applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, { markdown }))!.text;
			expect(text).not.toContain('<%');
			expect(text).not.toContain('$=');
			expect(text).toContain('```\ndv.paragraph("x")\n```');
			expect(text).toContain('```\nreturn 1\n```');
			expect(text).toContain('```ts\nconst value = 1;\n```');
		} finally { vi.unstubAllGlobals(); }
	});

	it('breaks plugin code languages that Markdown decodes from escapes or entities', async () => {
		vi.stubGlobal('window', { DOMParser });
		try {
			const { articleMarkdown } = await import('../extraction/markdown');
			// Markdown decodes backslash escapes and character references in a fence's language,
			// so `js\-engine` reads as `js-engine` and `dataview&#106;s` as `dataviewjs`.
			const html = `<pre><code data-lang="js\\-engine">return 1</code></pre>
				<pre><code data-lang="dataview&amp;amp;#106;s">dv.el("p", "x")</code></pre>
				<pre><code data-lang="dataview&amp;amp;amp;#106;s">dv.el("p", "y")</code></pre>`;
			const markdown = articleMarkdown(parseHTML(`<html><body>${html}</body></html>`).document.body, 'https://example.com/article');
			const source = note();
			const text = managedArticle(applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, { markdown }))!.text;
			expect(text).not.toMatch(/^[\t >]*`{3,}[ \t]*[^\s`]*[\\&]/m);
			expect(text).toContain('```\nreturn 1\n```');
		} finally { vi.unstubAllGlobals(); }
	});

	it('breaks plugin code that Defuddle keeps as raw HTML', async () => {
		vi.stubGlobal('window', { DOMParser });
		try {
			const { articleMarkdown } = await import('../extraction/markdown');
			// Defuddle keeps `sup` and complex tables as raw HTML, which Markdown does not parse,
			// so a fence line inside one must not change how later lines are treated.
			const html = `<p>A note<sup><code><b>$</b>=dv.el("p", "inline")</code></sup>.</p>
				<table><tr><th colspan="2">Shell</th></tr><tr><td><pre>example\n\`\`\`\nfence</pre></td><td>b</td></tr></table>
				<p>Between.</p>
				<pre><code data-lang="dataviewjs">dv.el("p", "fenced")</code></pre>
				<pre><code data-lang="datacorejsx">return 1</code></pre>`;
			const markdown = articleMarkdown(parseHTML(`<html><body>${html}</body></html>`).document.body, 'https://example.com/article');
			const source = note();
			const text = managedArticle(applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, { markdown }))!.text;
			expect(text).not.toMatch(/^[\t >]*`{3,}\s*(?:dataviewjs|datacorejsx)/im);
			expect(text).toContain('<code>​<b>$</b>=');
			expect(text).toContain('```\ndv.el("p", "fenced")\n```');
		} finally { vi.unstubAllGlobals(); }
	});

	it('breaks plugin code in list items and after them in Markdown converted by Defuddle', async () => {
		vi.stubGlobal('window', { DOMParser });
		try {
			const { articleMarkdown } = await import('../extraction/markdown');
			// A list item's code block keeps its fence on the marker line, and its indented
			// closing fence must not hide the executable blocks that follow it.
			const html = `<ul><li><pre><code class="language-dataviewjs">dv.paragraph("listed")</code></pre></li></ul>
				<ol><li><pre><code class="language-text">first</code></pre></li></ol>
				<pre><code class="language-tasks">filter by function true</code></pre>
				<pre><code class="language-js-engine">return 1</code></pre>
				<p>Then <code>$= dv.current()</code>.</p>`;
			const markdown = articleMarkdown(parseHTML(`<html><body>${html}</body></html>`).document.body, 'https://example.com/article');
			const source = note();
			const text = managedArticle(applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, { markdown }))!.text;
			expect(text).not.toMatch(/(?:`{3,}|~{3,})[ \t]*(?:dataviewjs|js-engine|tasks)/i);
			expect(text).not.toContain('$=');
			expect(text).toContain('dv.paragraph("listed")');
			expect(text).toContain('filter by function true');
		} finally { vi.unstubAllGlobals(); }
	});

	it('leaves no executable fence when an info string repeats the language', () => {
		const source = note();
		const markdown = '```dataviewjs dataviewjs\ndv.paragraph(1)\n```\n\n~~~ Tasks\tjs-engine\nreturn 1\n~~~';
		const text = managedArticle(applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, { markdown }))!.text;
		expect(text).toBe('\n\n```\ndv.paragraph(1)\n```\n\n~~~\nreturn 1\n~~~\n\n');
	});

	it('checks local source eligibility before assembling an oversized article', () => {
		const source = note().replace(ARTICLE_END, `My authored article.\n${ARTICLE_END}`);
		expect(() => applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, {
			markdown: 'x'.repeat(MAX_READING_BYTES),
		})).toThrow('The reading note changed. Its current contents have been kept.');
	});
});
