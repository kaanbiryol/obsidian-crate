import { isMap, isScalar, parseDocument, visit } from 'yaml';
import { MAX_READING_BYTES } from './model';

export function readReadingFrontmatter(markdown: string) {
	if (new TextEncoder().encode(markdown).byteLength > MAX_READING_BYTES) throw new Error('Reading note is larger than 1 MB.');
	const opening = /^(?:\uFEFF)?---\r?\n/.exec(markdown);
	if (!opening) return null;
	const offset = opening[0].length;
	const closing = /^(?:---|\.\.\.)\s*$/m.exec(markdown.slice(offset));
	if (!closing || closing.index > 64 * 1024) throw new Error('Missing or oversized reading properties.');
	const yaml = markdown.slice(offset, offset + closing.index);
	const document = parseDocument(yaml, { strict: true, uniqueKeys: true });
	if (document.errors.length || document.warnings.length || !isMap(document.contents) || document.contents.flow) throw new Error('Reading properties must be a valid YAML mapping.');
	visit(document, {
		Alias() { throw new Error('Aliases are not supported in reading properties.'); },
		Node(_key, node) { if (node.anchor || node.tag) throw new Error('Anchors and custom types are not supported in reading properties.'); },
	});
	const value: unknown = document.toJS({ maxAliasCount: 0 });
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reading properties.');
	const closeEnd = offset + closing.index + closing[0].length;
	return { document, value: value as Record<string, unknown>, offset, end: offset + closing.index,
		body: markdown.slice(closeEnd).replace(/^\r?\n/, ''), newline: opening[0].endsWith('\r\n') ? '\r\n' : '\n' };
}

/** Replace owned entries only; unknown YAML and everything after the delimiter stay byte-for-byte. */
export function patchReadingFrontmatter(markdown: string, changes: Record<string, unknown>): string {
	const parsed = readReadingFrontmatter(markdown);
	if (!parsed || !isMap(parsed.document.contents)) throw new Error('Reading properties are missing.');
	const edits: { start: number; end: number; text: string }[] = [];
	const remaining = new Map(Object.entries(changes));
	for (const pair of parsed.document.contents.items) {
		if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !remaining.has(pair.key.value)) continue;
		const key = pair.key.value;
		const keyRange = pair.key.range;
		const valueRange = pair.value && typeof pair.value === 'object' && 'range' in pair.value ? pair.value.range : undefined;
		if (!keyRange || !valueRange) throw new Error(`Cannot safely update ${key}.`);
		const start = parsed.offset + keyRange[0];
		const end = parsed.offset + valueRange[2];
		edits.push({ start, end, text: `${key}: ${JSON.stringify(remaining.get(key))}${parsed.newline}` });
		remaining.delete(key);
	}
	const firstKey = parsed.document.contents.items[0]?.key;
	const firstOffset = isScalar(firstKey) ? firstKey.range?.[0] : undefined;
	const beforeFirstKey = firstOffset === undefined ? '' : markdown.slice(parsed.offset, parsed.offset + firstOffset);
	const indentation = /(?:^|\n)([ \t]*)$/.exec(beforeFirstKey)?.[1] ?? '';
	if (remaining.size) edits.push({ start: parsed.end, end: parsed.end,
		text: [...remaining].map(([key, value]) => `${indentation}${key}: ${JSON.stringify(value)}${parsed.newline}`).join('') });
	let result = markdown;
	for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	readReadingFrontmatter(result); // Reject a patch if unusual YAML layout made it ambiguous.
	return result;
}
