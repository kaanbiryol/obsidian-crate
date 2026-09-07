import { describe, expect, it } from 'vitest';
import { markdownTaskContexts } from './markdownTaskContext';

describe('Markdown task context', () => {
	it.each([
		'```md\n- [ ] Example\n```',
		'~~~md\n- [ ] Example\n~~~',
		'````md\n```\n- [ ] Example\n```\n````',
		'  ```md\n  - [ ] Example\n  ```',
		'    - [ ] Example',
		'\t- [ ] Example',
		'<!--\n- [ ] Example\n-->',
		'<pre>\n- [ ] Example\n</pre>',
		'<details>\n- [ ] Example\n</details>',
		'---\n- [ ] Example\n---',
		'- ```md\n  - [ ] Example\n  ```',
		'1. ~~~md\n   - [ ] Example\n   ~~~',
		'- <pre>\n  - [ ] Example\n  </pre>',
		'<details>\n<details>\n- [ ] Inner example\n</details>\n- [ ] Outer example\n</details>',
		'<details>\n<!-- </details> -->\n- [ ] Example\n</details>',
	])('excludes protected checkbox-shaped text: %s', example => {
		const lines = `${example}\n\n- [ ] Real`.split('\n');
		expect([...markdownTaskContexts(lines).keys()]).toEqual([lines.length - 1]);
	});
	it('recognizes nested task lists while excluding indented code and fenced examples inside them', () => {
		const lines = ['- [ ] Parent', '  - [ ] Child', '    - [ ] Grandchild', '          - [ ] Code',
			'  ```md', '  - [ ] Fenced', '  ```', '- [ ] Sibling'];
		expect([...markdownTaskContexts(lines).keys()]).toEqual([0, 1, 2, 7]);
	});
	it('does not terminate a fence with a shorter or different marker', () => {
		const lines = ['````', '~~~', '```', '- [ ] Example', '````', '- [ ] Real'];
		expect([...markdownTaskContexts(lines).keys()]).toEqual([5]);
	});
	it('does not treat an indented code fence as opening a root fence', () => {
		expect([...markdownTaskContexts(['    ```', '    - [ ] Code', '', '- [ ] Real']).keys()]).toEqual([3]);
	});
});
