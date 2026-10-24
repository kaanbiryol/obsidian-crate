import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Marked } from 'marked';
import { releases } from './shortcut-release.mjs';

const site = 'https://crate.kaanbiryol.com';
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const safeUrl = href => /^(https?:|mailto:)/i.test(href ?? '') ? href : undefined;
// GitHub's generated notes end with this line; the page shows it as a compare link.
const fullChangelog = /^\s*\*\*Full changelog:?\*\*:?\s*(https:\/\/github\.com\/\S+?\/compare\/\S+)\s*$/im;

const notes = new Marked({ gfm: true, renderer: {
  // Release notes sit under each version's h2.
  heading({ tokens, depth }) {
    const level = depth <= 2 ? 3 : 4;
    return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
  },
  // Notes are Markdown only: raw HTML is shown as text, never rendered.
  html({ text }) { return escape(text); },
  link({ href, title, tokens }) {
    const url = safeUrl(href);
    const text = this.parser.parseInline(tokens);
    return url ? `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ''}>${text}</a>` : text;
  },
  // The site serves only its own images, so images in notes become links.
  image({ href, text }) {
    const url = safeUrl(href);
    return url ? `<a href="${escape(url)}">${escape(text || 'Image')}</a>` : escape(text);
  },
} });

export function releaseNotes(body) {
  const compare = body?.match(fullChangelog)?.[1];
  const markdown = (body ?? '').replace(fullChangelog, '').trim();
  return { compare, html: markdown ? notes.parse(markdown) : '' };
}

/** The changelog reuses the homepage's assets, header and footer so the two never drift apart. */
export function siteChrome(homepage) {
  const pick = (pattern, label) => {
    const match = homepage.match(pattern);
    if (!match) throw new Error(`site/index.html no longer has the ${label} the changelog reuses.`);
    return match[0];
  };
  const toHomepage = html => html.replaceAll('href="#main"', 'href="/"').replaceAll('href="#', 'href="/#');
  return {
    styles: [...homepage.matchAll(/<link rel="stylesheet" href="[^"]+">/g)].map(match => match[0]).join('\n  '),
    script: pick(/<script src="\/assets\/canvas\.js[^"]*" defer><\/script>/, 'navigation script'),
    header: toHomepage(pick(/<div class="canvas-header">[\s\S]*?<\/header><\/div>/, 'header')),
    footer: toHomepage(pick(/<footer class="site-footer[\s\S]*?<\/footer>/, 'footer'))
      .replace('href="/changelog/"', 'href="/changelog/" aria-current="page"'),
  };
}

function entry(release, latest) {
  const tag = escape(release.tag_name);
  const { compare, html } = releaseNotes(release.body);
  const badges = [latest && '<span class="changelog-badge changelog-badge--latest">Latest</span>',
    release.prerelease && '<span class="changelog-badge">Beta</span>'].filter(Boolean).join('');
  return `<article class="changelog-entry" id="${tag}" aria-labelledby="release-${tag}">
<div class="changelog-date"><time datetime="${release.published_at.slice(0, 10)}">${dateFormat.format(new Date(release.published_at))}</time></div>
<div class="changelog-content">
<header class="changelog-heading"><h2 id="release-${tag}"><a href="#${tag}">${tag}</a></h2>${badges}</header>
<div class="changelog-notes">${html || '<p class="changelog-empty">No notes were written for this release.</p>'}</div>
<p class="changelog-links"><a href="${escape(release.html_url)}">Release and downloads <span aria-hidden="true">↗</span></a>${compare ? `<a href="${escape(compare)}">Compare changes <span aria-hidden="true">↗</span></a>` : ''}</p>
</div>
</article>`;
}

/** Published releases, newest first. Output depends only on its inputs, so unchanged releases deploy nothing. */
export function changelogPage(items, chrome) {
  const published = items.filter(release => !release.draft && release.published_at)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="description" content="New features, improvements, and fixes in every Crate release.">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'">
  <meta name="theme-color" content="#0c0c0f">
  <link rel="canonical" href="${site}/changelog/">
  <meta property="og:title" content="Crate changelog">
  <meta property="og:description" content="New features, improvements, and fixes in every Crate release.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${site}/changelog/">
  <meta property="og:image" content="${site}/assets/og.png">
  <title>Changelog - Crate</title>
  <link rel="icon" href="/assets/logo.png">
  ${chrome.styles}
  <link rel="stylesheet" href="/assets/changelog.css">
  ${chrome.script}
</head>
<body class="changelog-page">
<a class="skip-link" href="#main">Skip to content</a>
${chrome.header}
<main id="main">
<section class="changelog-hero changelog-column wrap" aria-labelledby="changelog-title">
<p class="feature-label">Changelog</p>
<h1 id="changelog-title">What’s new in Crate.</h1>
<p class="body-copy">New features, improvements, and fixes in every release.</p>
<p class="changelog-hero-links"><a class="section-guide" href="/#setup">Install the beta <span aria-hidden="true">→</span></a></p>
</section>
<div class="changelog-list changelog-column wrap">
${published.length ? published.map((release, index) => entry(release, index === 0)).join('\n') : '<p class="changelog-empty">No releases have been published yet.</p>'}
</div>
</main>
${chrome.footer}
</body>
</html>
`;
}

export async function buildChangelog(destination, { getReleases = releases, homepage = 'site/index.html' } = {}) {
  const page = changelogPage(await getReleases(), siteChrome(await readFile(homepage, 'utf8')));
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'index.html'), page);
  return page;
}

if (import.meta.main) {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length) throw new Error('Usage: node scripts/build-changelog.mjs <destination>');
  await buildChangelog(destination);
  console.log(`Changelog written to ${destination}`);
}
