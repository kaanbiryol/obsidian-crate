import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { referencePages } from './reference.mjs';

const output = new URL('../src/content/docs/reference/', import.meta.url);
const publicDirectory = new URL('../public/', import.meta.url);
await mkdir(publicDirectory, { recursive: true });
await copyFile(new URL('../../site/assets/logo.png', import.meta.url), new URL('logo.png', publicDirectory));
await mkdir(output, { recursive: true });
const expected = new Set(referencePages.map(({ slug }) => `${slug}.md`));
for (const file of await readdir(output)) {
  if (file.endsWith('.md') && !expected.has(file)) await unlink(new URL(file, output));
}
for (const { slug, title, description } of referencePages) {
  const source = await readFile(new URL(`../../docs/${slug}.md`, import.meta.url), 'utf8');
  if (!source.startsWith('# ')) throw new Error(`Expected a title in docs/${slug}.md`);
  const body = source.replace(/^# .+\r?\n(?:\r?\n)?/, '');
  const editUrl = `https://github.com/kaanbiryol/obsidian-crate/edit/master/docs/${slug}.md`;
  const page = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\neditUrl: ${JSON.stringify(editUrl)}\n---\n\n${body}`;
  await writeFile(new URL(`${slug}.md`, output), page);
}
console.log(`Prepared ${referencePages.length} reference pages from docs/.`);
