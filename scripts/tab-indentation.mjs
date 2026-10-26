/** Leading spaces on each line, or 0 when the line does not start with spaces before code. */
const leadingSpaces = text => /^( +)\S/.exec(text)?.[1].length ?? 0;

/** Spaces per indent level: the shallowest code line's indent, as 4 or 2. */
function indentWidth(levels) {
	const shallowest = Math.min(...levels);
	return shallowest % 4 === 0 ? 4 : 2;
}

/**
 * Source files indent with tabs, as .editorconfig sets. Lines inside a template
 * literal are part of its value and keep their spaces. Fewer spaces than one
 * indent level are alignment, as in JSDoc continuation lines, and stay.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
	meta: {
		type: 'layout', fixable: 'whitespace', schema: [],
		messages: { spaces: 'Indent with tabs.' },
	},
	create(context) {
		return {
			Program() {
				const { sourceCode } = context;
				const templateLines = new Set();
				for (const token of sourceCode.ast.tokens) {
					if (token.type !== 'Template') continue;
					for (let line = token.loc.start.line + 1; line <= token.loc.end.line; line++) templateLines.add(line);
				}
				const indented = sourceCode.lines.flatMap((text, index) => {
					const spaces = templateLines.has(index + 1) ? 0 : leadingSpaces(text);
					return spaces ? [{ line: index + 1, spaces, comment: text[spaces] === '*' }] : [];
				});
				const levels = indented.filter(entry => !entry.comment).map(entry => entry.spaces);
				const width = levels.length ? indentWidth(levels) : 2;
				for (const { line, spaces } of indented) {
					if (spaces < width) continue;
					const start = sourceCode.getIndexFromLoc({ line, column: 0 });
					context.report({
						loc: { start: { line, column: 0 }, end: { line, column: spaces } },
						messageId: 'spaces',
						fix: fixer => fixer.replaceTextRange([start, start + spaces], '\t'.repeat(Math.floor(spaces / width)) + ' '.repeat(spaces % width)),
					});
				}
			},
		};
	},
};
