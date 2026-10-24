import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChangelog, changelogPage, releaseNotes, siteChrome } from './build-changelog.mjs';

const homepage = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const chrome = siteChrome(homepage);
const release = (tag, publishedAt, body, extra = {}) => ({ tag_name: tag, published_at: publishedAt, body, prerelease: true, draft: false,
  html_url: `https://github.com/kaanbiryol/obsidian-crate/releases/tag/${tag}`, ...extra });

test('lists published releases newest first and leaves out drafts', () => {
  const page = changelogPage([
    release('0.1.0', '2026-09-11T22:40:30Z', 'First beta.'),
    release('0.3.0', '2026-10-01T10:00:00Z', 'Unpublished.', { draft: true }),
    release('0.2.0', '2026-09-16T08:43:51Z', 'Second beta.', { prerelease: false }),
  ], chrome);
  assert.ok(page.indexOf('id="0.2.0"') < page.indexOf('id="0.1.0"'));
  assert.doesNotMatch(page, /0\.3\.0|Unpublished/);
  assert.match(page, /<time datetime="2026-09-16">September 16, 2026<\/time>/);
  assert.equal(page.match(/changelog-badge--latest/g).length, 1);
  assert.ok(page.indexOf('changelog-badge--latest') < page.indexOf('id="0.1.0"'));
  assert.equal(page.match(/<span class="changelog-badge">Beta<\/span>/g).length, 1);
});

test('turns the full changelog line into a compare link and marks empty notes', () => {
  const compare = 'https://github.com/kaanbiryol/obsidian-crate/compare/0.7.0...0.8.0';
  for (const body of [`**Full Changelog**: ${compare}`, `Notes.\n\n**Full changelog:** ${compare}\n`]) {
    assert.equal(releaseNotes(body).compare, compare);
    assert.doesNotMatch(releaseNotes(body).html, /Full changelog/i);
  }
  const page = changelogPage([release('0.8.0', '2026-10-20T20:05:30Z', `**Full Changelog**: ${compare}`)], chrome);
  assert.match(page, /No notes were written for this release\./);
  assert.match(page, new RegExp(`href="${compare.replaceAll('.', '\\.')}">Compare changes`));
});

test('renders notes as Markdown without passing through HTML or unsafe links', () => {
  const { html } = releaseNotes('## What’s new\n\n- **Bold** [docs](https://crate.kaanbiryol.com/docs/)\n- <script>alert(1)</script> <img src=x onerror=alert(1)>\n- [bad](javascript:alert(1)) ![shot](https://example.com/a.png)\n\n### Detail');
  assert.match(html, /<h3>What’s new<\/h3>/);
  assert.match(html, /<h4>Detail<\/h4>/);
  assert.match(html, /<strong>Bold<\/strong> <a href="https:\/\/crate\.kaanbiryol\.com\/docs\/">docs<\/a>/);
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\.png">shot<\/a>/);
});

test('reuses the homepage header and footer with links back to the homepage', () => {
  assert.match(chrome.header, /<a href="\/#sync">Sync<\/a>/);
  assert.match(chrome.header, /class="wordmark" href="\/"/);
  assert.doesNotMatch(chrome.header + chrome.footer, /href="#/);
  assert.match(chrome.footer, /href="\/changelog\/" aria-current="page"/);
  assert.match(chrome.styles, /home\.css/);
  assert.match(chrome.script, /canvas\.js/);
  assert.throws(() => siteChrome('<html></html>'), /no longer has the/);
});

test('writes the same page for the same releases', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'crate-changelog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const getReleases = async () => [release('0.1.0', '2026-09-11T22:40:30Z', 'First beta.')];
  const first = await buildChangelog(directory, { getReleases });
  assert.equal(await readFile(join(directory, 'index.html'), 'utf8'), first);
  assert.equal(await buildChangelog(directory, { getReleases }), first);
});
