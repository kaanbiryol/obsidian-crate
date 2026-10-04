import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

const site = path.resolve(fileURLToPath(new URL('../../site/', import.meta.url)));
const docs = path.join(site, 'docs');
const origin = 'https://crate.kaanbiryol.com';
const failures = [];
const cache = new Map();

function visit(node, callback) {
  callback(node);
  node.childNodes?.forEach((child) => visit(child, callback));
  if (node.content) visit(node.content, callback);
}

async function readPage(filename) {
  if (!cache.has(filename)) {
    const tree = parse(await readFile(filename, 'utf8'));
    const ids = new Set();
    const links = [];
    visit(tree, (node) => {
      const attrs = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
      if (attrs.id) ids.add(attrs.id);
      if (attrs.href && attrs.rel !== 'canonical') links.push(attrs.href);
      if (attrs.src) links.push(attrs.src);
      if (attrs.poster) links.push(attrs.poster);
    });
    cache.set(filename, { ids, links });
  }
  return cache.get(filename);
}

async function localFile(url) {
  const filename = path.resolve(site, `.${decodeURIComponent(url.pathname)}`);
  if (filename !== site && !filename.startsWith(`${site}${path.sep}`)) throw new Error('Path outside site');
  const entry = await stat(filename);
  return entry.isDirectory() ? path.join(filename, 'index.html') : filename;
}

const files = (await readdir(docs, { recursive: true }))
  .filter((name) => name.endsWith('.html'))
  .map((name) => path.join(docs, name));
if (!files.length) throw new Error('No built documentation pages found. Run the docs build first.');
const pages = [...files, path.join(site, 'index.html'), path.join(site, 'website-options/canvas/index.html')];
let checked = 0;
for (const filename of pages) {
  const route = `/${path.relative(site, filename).split(path.sep).join('/').replace(/index\.html$/, '')}`;
  const { links } = await readPage(filename);
  for (const href of links) {
    const url = new URL(href, `${origin}${route}`);
    if (url.origin !== origin) continue;
    // Existing landing-page links are outside this build's scope, except new docs links.
    if (!filename.startsWith(`${docs}${path.sep}`) && !url.pathname.startsWith('/docs/')) continue;
    try {
      const target = await localFile(url);
      await stat(target);
      if (url.hash && target.endsWith('.html')) {
        const { ids } = await readPage(target);
        const id = decodeURIComponent(url.hash.slice(1));
        if (!ids.has(id)) throw new Error(`Missing anchor #${id}`);
      }
      checked++;
    } catch (error) {
      failures.push(`${route} → ${href}: ${error.message}`);
    }
  }
}
await stat(path.join(docs, 'pagefind/pagefind.js'));
if (failures.length) throw new Error(`${failures.length} broken documentation links:\n${failures.slice(0, 25).join('\n')}`);
console.log(`Checked ${files.length} documentation pages, ${checked} local links/assets, and the Pagefind search bundle.`);
