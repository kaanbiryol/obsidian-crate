// Live editing of reminders in a note: date chips, typed and stored
// descriptions, and the hidden comments that store them. Runs the real editor
// extensions with CodeMirror's standard keymap, as Obsidian does, and checks
// after every step that no stored syntax shows and no comment breaks.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit } from '@playwright/test';

const css = compileString(`
  @use "src/styles/plugin/reminder-date";
  @use "src/styles/plugin/reminder-description";
`, { loadPaths: [process.cwd()] }).css;

const { outputFiles } = await build({
	stdin: { loader: 'ts', resolveDir: process.cwd(), contents: `
		// A page set from a string is not a secure context; Obsidian has crypto.randomUUID for new reminder IDs.
		if (!crypto.randomUUID) crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, digit =>
			(Number(digit) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(digit) / 4)))).toString(16));
		// Obsidian's DOM helpers, which the widgets use.
		const make = (tag, options = {}) => {
			const element = document.createElement(tag);
			if (options.cls) element.className = [options.cls].flat().join(' ');
			if (options.text) element.textContent = options.text;
			for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value));
			return element;
		};
		window.createSpan = options => make('span', options);
		window.createDiv = options => make('div', options);
		HTMLElement.prototype.createDiv = function (options) { const element = make('div', options); this.append(element); return element; };
		HTMLElement.prototype.createSpan = function (options) { const element = make('span', options); this.append(element); return element; };
		HTMLElement.prototype.setCssProps = function (props) { for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value); };

		import { EditorState } from '@codemirror/state';
		import { EditorView, drawSelection, keymap } from '@codemirror/view';
		import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
		import { createReminderLineLeaveExtension } from './src/reminders/editor/reminder-line-leave';
		import { createReminderMarkerHiding } from './src/reminders/editor/reminder-marker-hiding';
		import { createReminderDateChips } from './src/reminders/editor/editor-date-chips';
		import { normalizeReminderScheduleLine } from './src/reminders/core/normalizeReminderSchedule';
		import { readDescriptionBlock } from './src/reminders/core/reminderDescription';

		window.opened = [];
		window.saveLine = line => normalizeReminderScheduleLine(line);
		window.mount = (doc, anchor) => {
			window.view?.destroy();
			window.opened = [];
			const open = id => { window.opened.push(id); return true; };
			window.view = new EditorView({
				parent: document.getElementById('editor'),
				state: EditorState.create({ doc, selection: { anchor }, extensions: [
					history(), drawSelection(), EditorView.lineWrapping, keymap.of([...defaultKeymap, ...historyKeymap]),
					createReminderLineLeaveExtension(() => true),
					createReminderMarkerHiding(() => true, open),
					createReminderDateChips(() => true, open),
				] }),
			});
			window.view.focus();
		};
		window.doc = () => window.view.state.doc.toString();
		window.head = () => window.view.state.selection.main.head;
		window.place = anchor => { window.view.focus(); window.view.dispatch({ selection: { anchor }, userEvent: 'select' }); };
		/** Each line as shown, widgets included, with a description's bar as '|' and its line breaks as ' / '. */
		window.visible = () => [...window.view.contentDOM.children].map(element => {
			const copy = element.cloneNode(true);
			for (const bar of copy.querySelectorAll('.crate-reminder-description-marker')) bar.textContent = ' | ';
			return copy.textContent.replace(/\\u00a0/g, ' ').replace(/\\n/g, ' / ').replace(/ +/g, ' ').trimEnd();
		});
		/** Description comments that no longer read. */
		window.brokenDescriptions = () => {
			const lines = window.doc().split('\\n');
			return lines.flatMap((line, index) => {
				if (!line.includes('crate-desc:')) return [];
				if (!line.startsWith('<!-- crate-desc:')) return [line];
				try { readDescriptionBlock(lines, index - 1); return []; } catch { return [line]; }
			});
		};
		window.coordsAtLineEnd = number => {
			const line = window.view.state.doc.line(number);
			const box = window.view.coordsAtPos(line.to, -1);
			return { x: box.right + 40, y: (box.top + box.bottom) / 2 };
		};
	` },
	bundle: true, write: false, format: 'iife', platform: 'browser',
	alias: { obsidian: resolve('src/test/mocks/obsidian.ts') },
	define: { 'process.env.NODE_ENV': '"production"' },
});

const theme = `
	body { margin: 0; background: #1e1e1e; color: #ddd; font: 16px/1.5 sans-serif; }
	#editor { width: 640px; margin: 16px; }
	:root { --text-muted: #999; --text-faint: #666; --text-error: #e55; --text-accent: #a8f; --text-normal: #ddd;
		--background-modifier-hover: rgba(255,255,255,.08); --background-modifier-border: #333; --font-smaller: .875em;
		--radius-s: 4px; --size-2-1: 2px; --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px;
		--blockquote-border-thickness: 2px; --blockquote-border-color: #a8f; --list-indent: 2em; }
`;

/** Saved lines for a fixed clock: Saturday 14 November 2026, 12:00 in Amsterdam. */
const NOW = new Date('2026-11-14T12:00:00+01:00');
const NOTE = [
	'# Errands',
	'- [ ] Buy milk 2026-11-20 <!-- crate-id:a -->',
	'- [ ] Call Mia 2026-11-15T11:00:00.000Z <!-- crate-id:b -->',
	'- [x] Done thing 2026-11-01 <!-- crate-id:c -->',
	'- [ ] Overdue 2026-11-10 <!-- crate-id:d -->',
	'    - [ ] Nested 2026-11-21 <!-- crate-id:e -->',
	'- [ ] Described <!-- crate-id:f -->',
	'<!-- crate-desc:one line -->',
	'- [ ] Multi 2026-11-22 <!-- crate-id:g -->',
	'<!-- crate-desc:first',
	'second -->',
	'- [ ] Encoded <!-- crate-id:h -->',
	'<!-- crate-desc:v1:a%20%2D%2D%20b -->',
	'- [ ] Plain task without date <!-- crate-id:i -->',
	'Outro',
].join('\n');

const HIDDEN = /crate-|<!--|-->|\d{4}-\d{2}-\d{2}T|\.000Z/;

/** Fails when stored syntax shows or a description comment breaks. */
async function checkClean(page, step) {
	const lines = await page.evaluate(() => window.visible());
	const shown = lines.find(line => HIDDEN.test(line));
	assert.equal(shown, undefined, `${step}: stored syntax shows in ${JSON.stringify(shown)}\n${lines.join('\n')}`);
	assert.deepEqual(await page.evaluate(() => window.brokenDescriptions()), [], `${step}: a description comment broke\n${await page.evaluate(() => window.doc())}`);
}

const settle = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
const outro = page => page.evaluate(() => window.place(window.view.state.doc.length));

for (const engine of [chromium, webkit]) {
	const browser = await engine.launch();
	try {
		const context = await browser.newContext({ timezoneId: 'Europe/Amsterdam', locale: 'en-US', viewport: { width: 800, height: 900 } });
		const page = await context.newPage();
		await page.clock.setFixedTime(NOW);
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.setContent(`<style>${theme}\n${css}</style><div id="editor" class="markdown-source-view mod-cm6"></div>`);
		await page.addScriptTag({ content: outputFiles[0].text });
		const name = engine.name();
		const mount = (doc = NOTE, anchor = doc.length) => page.evaluate(([doc, anchor]) => window.mount(doc, anchor), [doc, anchor]);
		const doc = () => page.evaluate(() => window.doc());
		const visible = () => page.evaluate(() => window.visible());

		// Rendering with the cursor away from every reminder.
		await mount();
		assert.deepEqual(await visible(), [
			'# Errands',
			'- [ ] Buy milk Nov 20',
			'- [ ] Call Mia Tomorrow, 12:00',
			'- [x] Done thing Nov 1',
			'- [ ] Overdue Nov 10',
			' - [ ] Nested Nov 21',
			'- [ ] Described',
			'one line',
			'- [ ] Multi Nov 22',
			'first / second',
			'- [ ] Encoded',
			'a -- b',
			'- [ ] Plain task without date',
			'Outro',
		], `${name}: rendering`);
		await checkClean(page, `${name}: rendering`);

		// Moving through the whole note by character, by line and back never changes it.
		for (const [keys, label] of [[['ArrowRight'], 'right'], [['ArrowDown'], 'down'], [['ArrowLeft'], 'left'], [['ArrowUp'], 'up'], [['End', 'ArrowDown', 'Home'], 'line ends']]) {
			await mount(NOTE, label === 'left' || label === 'up' ? NOTE.length : 0);
			for (let step = 0; step < (label === 'right' || label === 'left' ? 360 : 40); step++) {
				for (const key of keys) await page.keyboard.press(key);
				await checkClean(page, `${name}: moving ${label}, step ${step}`);
			}
			await outro(page);
			await settle(page);
			assert.equal(await doc(), NOTE, `${name}: moving ${label} changed the note`);
		}

		// Clicking at the end of every line, then away, never changes it.
		await mount();
		for (let number = 1; number <= NOTE.split('\n').length; number++) {
			const { x, y } = await page.evaluate(number => window.coordsAtLineEnd(number), number);
			if (y < 0) continue;
			await page.mouse.click(x, y);
			await settle(page);
			await checkClean(page, `${name}: click at the end of line ${number}`);
		}
		await outro(page);
		await settle(page);
		assert.equal(await doc(), NOTE, `${name}: clicking changed the note`);

		// The cursor on a reminder shows its description on the line, after its bar.
		await mount();
		await page.evaluate(() => window.place(window.doc().indexOf('Described') + 3));
		assert.ok((await visible()).includes('- [ ] Described | one line'), `${name}: description on its reminder's line: ${JSON.stringify(await visible())}`);
		await checkClean(page, `${name}: description on its reminder's line`);
		// An encoded description stays a block; it is edited in the sheet.
		await page.evaluate(() => window.place(window.doc().indexOf('Encoded') + 3));
		assert.ok((await visible()).includes('a -- b'), `${name}: encoded description stays a block`);

		// Editing a stored description with the keyboard.
		await page.evaluate(() => window.place(window.doc().indexOf('Described') + 3));
		await page.keyboard.press('End');
		await page.keyboard.type(' more');
		// Comment markers cannot be typed into it.
		await page.keyboard.type('-->');
		await page.keyboard.type('<!--');
		await checkClean(page, `${name}: typing into a description`);
		await outro(page);
		await settle(page);
		// Each keystroke that would complete a comment marker is kept out; the rest is typed.
		assert.ok((await doc()).includes('\n<!-- crate-desc:one line more--<!- -->\n'), `${name}: edited description\n${await doc()}`);
		assert.deepEqual(await page.evaluate(() => window.brokenDescriptions()), []);

		// Backspace through a whole description, then into the title, never breaks a comment.
		await mount();
		await page.evaluate(() => window.place(window.doc().indexOf('Described') + 3));
		await page.keyboard.press('End');
		for (let step = 0; step < 40; step++) {
			await page.keyboard.press('Backspace');
			await checkClean(page, `${name}: backspace in a description, step ${step}`);
		}
		await outro(page);
		await settle(page);
		await checkClean(page, `${name}: after backspacing a description`);

		// Enter at the end of a description starts a new task; inside, it breaks the line.
		await mount();
		await page.evaluate(() => window.place(window.doc().indexOf('Described') + 3));
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Next task');
		await checkClean(page, `${name}: Enter at the end of a description`);
		assert.match(await doc(), /<!-- crate-desc:one line -->\n- \[ \] Next task/, `${name}: Enter starts a new task\n${await doc()}`);

		// A date chip turns into a phrase when the cursor reaches it, and saves the edit on leaving.
		await mount();
		const buy = await page.evaluate(() => window.coordsAtLineEnd(2));
		await page.mouse.click(buy.x, buy.y);
		await settle(page);
		assert.equal(await page.evaluate(() => window.view.state.doc.line(2).text), '- [ ] Buy milk Nov 20 <!-- crate-id:a -->', `${name}: phrase for a date`);
		for (let step = 0; step < 2; step++) await page.keyboard.press('Backspace');
		await page.keyboard.type('25');
		await page.keyboard.press('ArrowDown');
		await settle(page);
		assert.equal(await page.evaluate(() => window.view.state.doc.line(2).text), '- [ ] Buy milk 2026-11-25 <!-- crate-id:a -->', `${name}: edited date saved`);
		assert.ok((await visible()).includes('- [ ] Buy milk Nov 25'), `${name}: edited date shows as a chip`);
		await checkClean(page, `${name}: after editing a date`);
		// A time keeps local time: 12:00 tomorrow is the phrase, not the stored UTC time.
		const call = await page.evaluate(() => window.coordsAtLineEnd(3));
		await page.mouse.click(call.x, call.y);
		await settle(page);
		assert.equal(await page.evaluate(() => window.view.state.doc.line(3).text), '- [ ] Call Mia tomorrow 12:00 <!-- crate-id:b -->', `${name}: phrase for a time`);
		// The phrase shows with the date it will save as.
		assert.ok((await visible()).includes('- [ ] Call Mia tomorrow 12:00Tomorrow, 12:00'), `${name}: hint for a time`);
		await outro(page);
		await settle(page);
		assert.match(await doc(), /Call Mia 2026-11-15T11:00:00\.000Z <!-- crate-id:b -->/, `${name}: unchanged time restored`);

		// Writing a new reminder with a date and a description in one line.
		await mount();
		await page.keyboard.press('Enter');
		await page.keyboard.type('- [ ] Eat food tomorrow 12:00 // bring plates // and cups');
		await checkClean(page, `${name}: typing a reminder with a description`);
		assert.ok((await visible()).some(line => line.startsWith('- [ ] Eat food Tomorrow, 12:00')), `${name}: date shows as a chip while describing`);
		await page.keyboard.press('ArrowUp');
		await settle(page);
		assert.match(await doc(), /\n- \[ \] Eat food 2026-11-15T11:00:00\.000Z <!-- crate-id:[0-9a-f-]{36} -->\n<!-- crate-desc:bring plates\nand cups -->$/, `${name}: new reminder saved\n${await doc()}`);
		await checkClean(page, `${name}: after writing a reminder`);

		// Undo and redo through everything above never shows stored syntax or breaks a comment.
		for (let step = 0; step < 30; step++) {
			await page.keyboard.press('ControlOrMeta+z');
			await checkClean(page, `${name}: undo ${step}`);
		}
		for (let step = 0; step < 30; step++) {
			await page.keyboard.press('ControlOrMeta+Shift+z');
			await checkClean(page, `${name}: redo ${step}`);
		}

		// Deleting across lines, reminders and descriptions never leaves part of a comment.
		for (const [from, lines] of [[2, 2], [6, 3], [7, 2], [9, 4], [8, 1]]) {
			await mount();
			await page.evaluate(number => window.place(window.view.state.doc.line(number).from + 3), from);
			for (let line = 0; line < lines; line++) await page.keyboard.press('Shift+ArrowDown');
			await page.keyboard.press('Backspace');
			await checkClean(page, `${name}: deleting ${lines} lines from line ${from}`);
			await outro(page);
			await settle(page);
			await checkClean(page, `${name}: after deleting ${lines} lines from line ${from}`);
		}

		// Tapping a stored description and a saved date opens the reminder.
		await mount();
		await page.getByText('one line', { exact: true }).click();
		const chip = page.locator('.crate-reminder-date', { hasText: 'Nov 20' });
		await chip.click();
		assert.deepEqual(await page.evaluate(() => window.opened), ['f', 'a'], `${name}: taps open their reminders`);
		assert.equal(await doc(), NOTE, `${name}: taps change nothing`);

		assert.deepEqual(errors, [], `${name}: page errors`);
		await context.close();
	} finally {
		await browser.close();
	}
}
console.log('Reminder live editing browser test passed.');
