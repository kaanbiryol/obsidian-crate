import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { gzipSync } from 'node:zlib';
import { readingExtractionPlugin } from './reading-extraction-build.mjs';
import { marked } from 'marked';
import { parseHTML } from 'linkedom';


// Bundle with the production Worker's module-resolution settings. Loading the
// dependency through Vite's CJS shim tests a different Turndown browser build.
test('Defuddle extracts documents in the deployed workerd runtime without network access', { timeout: 60000 }, async t => {
	const bundle = await build({ stdin: { contents: `
		import { extractReadingDocument } from './tests/reading-extraction/extract-document';
		import { articleMarkdown } from './src/cloudflare/worker/reading/extraction/markdown';
		import { parseHTML } from 'linkedom';
		import { createMarkdownContent } from 'defuddle/full';
		export default { async fetch(request) {
			try {
				const params = new URL(request.url).searchParams, html = await request.text(), source = params.get('source') || 'https://example.com/story';
				if (params.get('convert') === 'upstream') return Response.json({ markdown: createMarkdownContent(html, source) });
				return Response.json(params.has('convert') ? { markdown: articleMarkdown(parseHTML('<html><body>' + html + '</body></html>').document.body, source) } : await extractReadingDocument(html, source));
			}
			catch (error) { return Response.json({ error: error.message }, {status:422}); }
		} };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'neutral',
		mainFields: ['module', 'main'], conditions: ['worker', 'browser', 'import'], minify: true,
		plugins: [readingExtractionPlugin()],
	});
	const output = bundle.outputFiles[0];
	assert.ok(!output.text.includes('Problematic content:'), 'Defuddle source-content diagnostics must be removed');
	t.diagnostic(`Extraction probe: ${output.contents.length} bytes raw; ${gzipSync(output.contents).length} gzip (production extractor).`);
	let outbound = 0;
	const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: output.text, compatibilityDate: '2026-08-18',
		outboundService: () => { outbound++; return new Response('Network forbidden', { status: 403 }); } }));
	try {
		const extract = async (body, source = 'https://example.com/story', convert = false) => {
			const response = await runtime.dispatchFetch(`https://probe.invalid/?source=${encodeURIComponent(source)}${convert ? '&convert=' + convert : ''}`, { method: 'POST', body });
			return { status: response.status, result: await response.json() };
		};
		const started = performance.now();
		const article = await extract(`<html><head><title>A small article</title><link rel="icon" href="/assets/favicon.png"></head><body><article>
		<h1>A small article</h1><p>Here is an article with useful content, enough context, and a <a href="/next">relative link</a>.</p>
		<h2>日本語の見出し</h2><p>日本語の記事を保存します。 Über die Straße lesen.</p><ul><li>First point</li><li>Second point</li></ul>
		<pre><code>const answer = 42;</code></pre><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Answer</td><td>42</td></tr></tbody></table>
		<p>A footnote<sup><a href="#fn1">1</a></sup></p><p id="fn1">The original source.</p>
		<script>fetch('https://tracking.test')</script><iframe src="https://tracking.test"></iframe>
		</article></body></html>`);
		assert.equal(article.status, 200);
		assert.equal(article.result.title, 'A small article');
		assert.equal(article.result.faviconUrl, 'https://example.com/assets/favicon.png');
		for (const text of ['[relative link](https://example.com/next)', '日本語', 'Über', 'First point', 'const answer = 42;', '| Name', 'The original source.']) assert.ok(article.result.markdown.includes(text), `${text}\n${article.result.markdown}`);
		assert.match(article.result.markdown, /- +First point/);
		assert.ok(!article.result.markdown.includes('tracking.test'));
		t.diagnostic(`First extraction including runtime initialization: ${(performance.now() - started).toFixed(0)} ms wall time; this is not a Cloudflare CPU measurement.`);
		const empty = await extract('<html><head></head><body></body></html>', 'https://x.com/person/status/123');
		assert.equal(empty.status, 422);
		const malformed = await extract('<html><head><title>Broken</title></head><body><article><h1>Broken</h1><p>A readable paragraph despite missing closing tags.<p>Another paragraph.');
		assert.equal(malformed.status, 200);
		assert.ok(malformed.result.markdown.includes('readable paragraph'));
		await t.test('HTML indentation, card links, and empty media links do not become empty paragraphs', async () => {
			const converted = await extract(`<section>
                <p>Read <a href="/next">
                    this <strong>useful</strong> article
                </a> today.</p>
                <a href="/avatar"><img src="https://tracking.test/pixel" /></a>
                <div><div> </div></div>
                <a href="/card"><div><h3>Linked heading</h3><p>Card description.</p></div></a>
                <p>After the card.</p>
            </section>`, undefined, true);
			assert.equal(converted.status, 200);
			assert.match(converted.result.markdown, /Read \[this \*\*useful\*\* article\]\(https:\/\/example.com\/next\) today\./);
			assert.doesNotMatch(converted.result.markdown, /\[\]\(|tracking.test|\n[ \t]+\n[ \t]+\n/);
			const list = await extract('<ul><li><h3>First</h3><p>Some detail.</p></li><li><h3>Second</h3><p>More detail.</p></li></ul>', undefined, true);
			assert.match(list.result.markdown, /- ### First/);
			assert.match(list.result.markdown, /- ### Second/);
			assert.doesNotMatch(list.result.markdown, /\n[ \t]+\n[ \t]+\n/);
		});
		await t.test('lists, tables, and code retain their meaning', async () => {
			const code = 'const text = `a`;\n\n  keepIndent();\nnext();';
			const converted = await extract(`<ol start="3"><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol>
                <pre><code class="language-js">${code}</code></pre>
                <p>Use <code>a\u0060b</code> inline.<br>New line.</p>
                <table><tr><th>Key</th><th>Value</th></tr><tr><td>a|b</td><td><a href="/cell">Link</a></td></tr></table>`, undefined, true);
			assert.equal(converted.status, 200);
			assert.match(converted.result.markdown, /^3\. +First\n[ \t]+- +Nested\n4\. +Second/);
			assert.ok(converted.result.markdown.includes('```js\n' + code + '\n```'));
			assert.ok(converted.result.markdown.includes('``a`b``'));
			assert.ok(converted.result.markdown.includes('| a\\|b | [Link](https://example.com/cell) |'));
			const fenced = await extract('<pre><code>before\n```\nafter</code></pre>', undefined, true);
			assert.equal(marked.lexer(fenced.result.markdown).find(token => token.type === 'code')?.text, 'before\n```\nafter');
		});
		await t.test('formatting comes unchanged from Defuddle, including its extended Markdown rules', async () => {
			const html = `<p><del>Outdated</del> and <mark>important</mark>. Keep &lt;video&gt; as literal text.</p>
                <div class="callout" data-callout="note"><div class="callout-title"><div class="callout-title-inner">Remember</div></div><div class="callout-content"><p>A useful detail.</p></div></div>
                <p>Formula: <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>.</p>
                <pre><code class="language-js">const text = \u0060a\u0060;\n\n\n  keepIndent();</code></pre>`;
			const converted = await extract(html, undefined, true);
			const upstream = await extract(html, undefined, 'upstream');
			assert.equal(converted.status, 200);
			assert.equal(converted.result.markdown, upstream.result.markdown);
			for (const text of ['~~Outdated~~', '==important==', '> [!note] Remember', '$x^2$']) assert.ok(converted.result.markdown.includes(text), text);
			const rendered = parseHTML(`<html><body>${marked.parse(converted.result.markdown)}</body></html>`).document;
			assert.ok(rendered.body.textContent.includes('<video>'));
			assert.equal(rendered.querySelector('video'), null);
		});
		await t.test('unsafe links and media never become active Markdown', async () => {
			const converted = await extract('<p><a href="javascript:alert(1)">Keep label</a> <a href="https://name:secret@example.com/">No credentials</a></p><script>private source</script><iframe src="https://tracking.test"></iframe>', undefined, true);
			assert.equal(converted.result.markdown, 'Keep label No credentials');
		});
		await t.test('public X posts exclude login prompts, replies, metrics, and streamed duplicates', async () => {
			const post = `<article><a href="/writer">Writer</a><div dir="auto"><span>A saved post with enough readable words for an article.\nAnother line with <a href="https://example.com/read">a source</a>.</span></div><a data-base-ui-tooltip-trigger href="/writer/status/123">Sep 21</a><div data-engagement-action="reply">987</div></article>`;
			const fixture = `<html><head><meta property="og:title" content="Writer (@writer) on X"></head><body><nav>Log in Sign up</nav>${post}<div hidden id="S:0">${post}<article><div dir="auto">Unrelated reply from somebody else.</div><a data-base-ui-tooltip-trigger href="/other/status/456">Sep 21</a></article></div><footer>Terms of service</footer></body></html>`;
			const extracted = await extract(fixture, 'https://x.com/writer/status/123?s=12');
			assert.equal(extracted.status, 200);
			assert.equal(extracted.result.author, 'Writer (@writer)');
			assert.equal(extracted.result.markdown, 'A saved post with enough readable words for an article.  \nAnother line with [a source](https://example.com/read).');
			assert.equal((await extract(fixture, 'https://x.com/other/status/999')).status, 422);
			assert.equal((await extract('<html><body>Log in to read this post. Sign up to discover what people are talking about.</body></html>', 'https://x.com/writer/status/123')).status, 422);
		});
		await t.test('React IDs cannot force a whole-page fallback; original fragments survive', async () => {
			const extracted = await extract(`<html><head><title>Useful article</title></head><body><nav>Navigation clutter</nav><p>Loading</p><div hidden id="S:0"><article><p>A useful hidden article with enough words to recover the actual body instead of the loading shell. It has a <a href="#note:1">reference</a> and some extra context.</p><p id="note:1">The referenced paragraph explains the example.</p></article></div><footer>Footer clutter</footer></body></html>`);
			assert.equal(extracted.status, 200);
			assert.match(extracted.result.markdown, /useful hidden article/);
			assert.ok(extracted.result.markdown.includes('https://example.com/story#note:1'));
			assert.doesNotMatch(extracted.result.markdown, /Navigation clutter|Footer clutter|crate-extraction-id/);
		});
		assert.equal((await extract('あ'.repeat(750000))).status, 422);
		assert.equal(outbound, 0);
	} finally { await runtime.dispose(); }
});
