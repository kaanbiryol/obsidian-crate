import { expect, it } from 'vitest';
import fc from 'fast-check';
import { parse } from 'yaml';
import { mergeMarkdownContent } from './markdown-merge';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const merge = (base: string, local: string, remote: string) => mergeMarkdownContent(bytes(base), bytes(local), bytes(remote));
const conflict = (base: string, local: string, remote: string) => {
	for (const [left, right] of [[local, remote], [remote, local]]) expect(merge(base, left!, right!)).toEqual({ success: false, reason: 'overlap' });
};

it('preserves competing valid YAML when both authors introduce fences', () => {
	const left = 'enabled: true\nname: example', right = 'name: example\nenabled: false';
	expect(() => { parse(left); }).not.toThrow(); expect(() => { parse(right); }).not.toThrow();
	conflict('name: example\n', `\`\`\`yaml\n${left}\n\`\`\`\n`, `\`\`\`yaml\n${right}\n\`\`\`\n`);
});

it.each(['', '> ', '>>', '    ', '\t'])('protects newly wrapped code and competing interior edits (%j)', prefix => {
	for (const marker of ['```', '~~~~']) for (const eol of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
		const text = (lines: string[]) => bom + lines.map(line => prefix + line).join(eol) + eol;
		const base = text(['name: example', 'end: value']);
		const local = text([marker + 'yaml', 'enabled: true', 'name: example', 'end: value', marker]);
		const remote = text(['name: example', 'enabled: false', 'end: value']);
		conflict(base, local, remote);
		for (const [a, b] of [[base, local], [local, base], [local, local]]) expect(merge(base, a!, b!)).toMatchObject({ success: true, text: local });
	}
});

it.each([
	['remove', '```yaml\na: 1\nb: 2\n```\n', 'a: 1\nb: 2\n', '```yaml\na: 3\nb: 2\n```\n'],
	['move', 'a: 1\n```yaml\nb: 2\n```\n', '```yaml\na: 1\nb: 2\n```\n', 'a: 3\n```yaml\nb: 2\n```\n'],
	['unclosed', 'a: 1\nb: 2\n', '```yaml\na: 1\nb: 2\n', 'a: 3\nb: 2\n'],
	['indent', 'a: 1\nb: 2\n', '    a: 1\n    b: 2\n', 'a: 3\nb: 2\n'],
	['indented code', '    a: 1\n    b: 2\n', '    a: 3\n    b: 2\n', '    a: 1\n    b: 4\n'],
	['quoted indent', '>     a: 1\n>     b: 2\n', '>     a: 3\n>     b: 2\n', '>     a: 1\n>     b: 4\n'],
])('rejects a competing structural transition: %s', (_label, base, local, remote) => conflict(base, local, remote));

it('allows new code with unrelated prose and independent whole inserted blocks', () => {
	const base = 'Intro\n\nname: example\n\nAfter\n';
	const local = base.replace('name: example', '```yaml\nname: example\n```');
	const remote = base.replace('Intro', 'Edited intro');
	for (const [a, b] of [[local, remote], [remote, local]]) expect(merge(base, a!, b!)).toMatchObject({ success: true, text: local.replace('Intro', 'Edited intro') });
	const a = '```yaml\na: 1\n```\n', b = '~~~yaml\nb: 2\n~~~\n';
	const result = merge('Intro\n', `Intro\n${a}`, `Intro\n${b}`);
	expect(result.success).toBe(true);
	if (result.success) { expect(result.text).toContain(a); expect(result.text).toContain(b); }
});

it('keeps prose after a closed fence independent of an interior edit', () => {
	const base = '```yaml\na: 1\n```\n';
	expect(merge(base, base.replace('a: 1', 'a: 2'), base + 'New paragraph\n'))
		.toMatchObject({ success: true, text: base.replace('a: 1', 'a: 2') + 'New paragraph\n' });
});

it('does not absorb another edit after a fence leaves its quote container', () => {
	conflict('    b: 2\n', '    b: 2\nintro\n', '> ```\n```\n> ```\n');
});

it('does not turn changed paragraph continuation into unauthored indented code', () => {
	conflict('intro\n\ta: 1\n', '\ta: 1\n', 'intro\n    b: 2\n');
});

it('does not turn newly introduced code into prose when another edit removes its paragraph boundary', () => {
	conflict('intro\n\na: 1\n', 'intro\n\n    a: 1\n', 'intro\na: 1\n');
});

it('allows deliberately removing a code wrapper on one side', () => {
	const base = '```yaml\na: 1\n```\n', plain = 'a: 1\n';
	for (const [left, right] of [[base, plain], [plain, base], [plain, plain]]) {
		expect(merge(base, left!, right!)).toMatchObject({ success: true, text: plain });
	}
});

it('bounds structural parsing before decoding oversized notes', () => {
	const large = 'x'.repeat(1024 * 1024 + 1);
	expect(merge(large, large + 'a', large + 'b')).toEqual({ success: false, reason: 'too-large' });
});

it('never synthesizes a wrapped YAML document across generated concurrent changes', () => {
	fc.assert(fc.property(fc.integer(), fc.integer(), fc.constantFrom('```', '~~~~'), fc.constantFrom('', '> ', '  > '), (a, b, fence, prefix) => {
		const block = (body: string[]) => [fence + 'yaml', ...body, fence].map(line => prefix + line).join('\n') + '\n';
		conflict(`${prefix}name: example\n`, block([`enabled: ${a}`, 'name: example']), block(['name: example', `enabled: ${b}`]));
	}), { numRuns: 200 });
});
