import { test } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './tab-indentation.mjs';

RuleTester.describe = (name, run) => test(name, run);
RuleTester.it = (name, run) => test(name, run);
RuleTester.itOnly = (name, run) => test(name, { only: true }, run);
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } } });
const errors = count => Array.from({ length: count }, () => ({ messageId: 'spaces' }));

tester.run('tab-indentation', rule, {
	valid: [
		'function f() {\n\treturn 1;\n}\n',
		// Template literal lines are part of the value.
		'const sql = `\n  SELECT 1\n    FROM files\n`;\n',
		// JSDoc continuation lines align with one space.
		'/**\n * Top level.\n */\nexport const x = 1;\n',
		'function f() {\n\t/**\n\t * Nested.\n\t */\n\treturn 1;\n}\n',
	],
	invalid: [
		{
			code: 'function f() {\n  if (x) {\n    return `\n  kept\n`;\n  }\n}\n',
			output: 'function f() {\n\tif (x) {\n\t\treturn `\n  kept\n`;\n\t}\n}\n',
			errors: errors(3),
		},
		{
			code: 'function f() {\n    /**\n     * Four-space file.\n     */\n    return 1;\n}\n',
			output: 'function f() {\n\t/**\n\t * Four-space file.\n\t */\n\treturn 1;\n}\n',
			errors: errors(4),
		},
		{
			// A space-indented block in a tab-indented file keeps its own width.
			code: 'function f() {\n\tconst a = 1;\n  const b = 2;\n  if (a) {\n    g();\n  }\n}\n',
			output: 'function f() {\n\tconst a = 1;\n\tconst b = 2;\n\tif (a) {\n\t\tg();\n\t}\n}\n',
			errors: errors(4),
		},
		{
			code: 'const view = (\n  <div>\n    text\n  </div>\n);\n',
			output: 'const view = (\n\t<div>\n\t\ttext\n\t</div>\n);\n',
			errors: errors(3),
		},
	],
});
