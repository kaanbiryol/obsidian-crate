import { chromium, webkit, expect, test, type Browser, type Page, type Locator } from '@playwright/test';


async function selectRange(editor: Locator, anchor: number, focus: number) {
  await editor.evaluate((element, offsets) => {
    (element as HTMLElement).focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const resolve = (offset: number): [Text, number] => {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      throw new Error('Selection outside document');
    };
    const [a, ao] = resolve(offsets.anchor);
    const [f, fo] = resolve(offsets.focus);
    document.getSelection()!.setBaseAndExtent(a, ao, f, fo);
    document.dispatchEvent(new Event('selectionchange'));
  }, { anchor, focus });
}

for (const browserName of ['chromium', 'webkit'] as const) {
  for (const host of ['pwa', 'plugin']) {
    test.describe(`${browserName} / ${host} Lexical trial`, () => {
      let browser: Browser;
      let page: Page;
      test.beforeEach(async () => {
        browser = await ({ chromium, webkit })[browserName].launch();
        page = await browser.newPage({ baseURL: 'http://127.0.0.1:8790', viewport: { width: 390, height: 844 }, hasTouch: true });
      });
      test.afterEach(async () => { await browser?.close(); });

      async function load(value: string) {
        await page.goto(`/?scene=lexical&host=${host}&theme=dark`);
        await page.getByRole('textbox', { name: 'Sample reminder' }).fill(value);
        await page.getByRole('button', { name: 'Load reminder' }).click();
        const editor = page.getByRole('textbox', { name: 'Lexical reminder', exact: true });
        const output = page.getByTestId('lexical-value');
        await expect(output).toHaveJSProperty('textContent', value);
        return { editor, output };
      }

      test('keeps the project after a time while typing a word starting with p', async () => {
        const initial = 'tomorrow 12:00 #Work ';
        const { editor, output } = await load(initial);
        await selectRange(editor, initial.length, initial.length);
        let expected = initial;
        for (const letter of 'pizza ') {
          await page.keyboard.type(letter);
          expected += letter;
          await expect(output).toHaveJSProperty('textContent', expected);
          await expect(editor.locator('.rich-text-chip-project')).toHaveText('#Work');
          await expect(editor.locator('.rich-text-chip-date')).toHaveText('tomorrow 12:00');
        }
      });

      test('reveals Markdown at the caret, edits destinations and renders again on blur', async () => {
        const { editor, output } = await load('Check [this article](https://example.com) !');
        await expect(editor.locator('a')).toHaveText('this article');
        await selectRange(editor, 9, 9);
        await expect(editor).toHaveText('Check [this article](https://example.com) !');
        await expect(output).toHaveText('Check [this article](https://example.com) !');
        await selectRange(editor, 29, 40);
        await page.keyboard.insertText('example.org');
        await expect(output).toHaveText('Check [this article](https://example.org) !');
        await selectRange(editor, 0, 0);
        await expect(editor.locator('a')).toHaveText('this article');
        await selectRange(editor, 9, 9);
        await expect(editor).toHaveText('Check [this article](https://example.org) !');
        await page.getByRole('textbox', { name: 'Sample reminder' }).focus();
        await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.org');
      });

      test('preserves bare URLs while rendering and editing them', async () => {
        const original = 'Visit https://example.com/path#Work now';
        const { editor, output } = await load(original);
        await expect(editor.locator('a')).toHaveText('https://example.com/path#Work');
        await selectRange(editor, 12, 12);
        await expect(editor.locator('a')).toHaveCount(0);
        await page.getByRole('textbox', { name: 'Sample reminder' }).focus();
        await expect(editor.locator('a')).toHaveCount(1);
        await expect(output).toHaveText(original);
      });

      test('description links render without interpreting reminder metadata', async () => {
        await page.goto(`/?scene=editor&host=${host}&theme=dark`);
        const description = page.getByRole('textbox', { name: 'Reminder description' });
        const title = page.getByRole('textbox', { name: 'Reminder title' });
        const value = 'Tomorrow #Work ! #Home ! [article](https://example.com) https://example.org';
        await description.fill(value);
        await title.focus();
        await expect(description.locator('a')).toHaveCount(2);
        await expect(description.locator('.rich-text-chip')).toHaveCount(0);
        await selectRange(description, 28, 28);
        await expect(description).toContainText('[article](https://example.com)');
        await expect(description).toContainText('Tomorrow #Work ! #Home !');
      });

      test('modifier-click opens a rendered link without entering Markdown editing', async () => {
        const { editor, output } = await load('Check [docs](https://example.com) now');
        await page.evaluate(() => {
          window.open = (url) => { document.body.dataset.openedLink = String(url); return null; };
        });
        await editor.locator('a').click({ modifiers: ['ControlOrMeta'] });
        await expect(page.locator('body')).toHaveAttribute('data-opened-link', 'https://example.com/');
        await expect(output).toHaveText('Check [docs](https://example.com) now');
      });

      for (const backward of [false, true]) {
        test(`replaces a ${backward ? 'backward' : 'forward'} selection across a link and chip, then restores it with undo`, async () => {
          const original = 'Start [docs](https://example.com) #Work end';
          const { editor, output } = await load(original);
          // Visible offsets deliberately span three different Lexical nodes.
          await selectRange(editor, backward ? 16 : 6, backward ? 6 : 16);
          // One native text insertion is one history operation. Per-key typing
          // intentionally creates a separate history entry after replacing a range.
          await page.keyboard.insertText('replacement');
          await expect(output).toHaveText('Start replacement end');
          await page.keyboard.press('ControlOrMeta+z');
          await expect(output).toHaveText(original);
          await page.keyboard.press('ControlOrMeta+Shift+z');
          await expect(output).toHaveText('Start replacement end');
        });
      }

      test('deletes a whole link without leaving hidden Markdown and undoes the deletion', async () => {
        const original = 'A [docs](https://example.com) B';
        const { editor, output } = await load(original);
        await selectRange(editor, 2, 6);
        await page.keyboard.press('Backspace');
        await expect(output).toHaveText('A  B');
        await expect(editor.locator('a')).toHaveCount(0);
        await page.keyboard.press('ControlOrMeta+z');
        await expect(output).toHaveText(original);
        await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com');
      });

      test('splits and rejoins lines with Enter, Shift+Enter and Backspace', async () => {
        const { editor, output } = await load('alphaomega');
        await selectRange(editor, 5, 5);
        await page.keyboard.press('Enter');
        await expect(output).toHaveJSProperty('textContent', 'alpha\nomega');
        await page.keyboard.press('Backspace');
        await expect(output).toHaveText('alphaomega');
        await page.keyboard.press('Shift+Enter');
        await expect(output).toHaveJSProperty('textContent', 'alpha\nomega');
        await page.keyboard.type('middle');
        await expect(output).toHaveJSProperty('textContent', 'alpha\nmiddleomega');
      });

      test('normalizes clipboard line endings and supports replacing the entire document', async () => {
        const { editor, output } = await load('Old #Work !');
        await editor.focus();
        await editor.press('ControlOrMeta+a');
        await editor.evaluate(element => {
          const data = new DataTransfer();
          data.setData('text/plain', 'first\r\nsecond\rthird 👩🏽‍💻');
          element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        });
        await expect(output).toHaveJSProperty('textContent', 'first\nsecond\nthird 👩🏽‍💻');
        await editor.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
        await expect(output).toHaveText('');
        await page.keyboard.type('New reminder');
        await expect(output).toHaveText('New reminder');
      });

      test('retains independent history across external loads and clears redo after a new edit', async () => {
        const { editor, output } = await load('First');
        await page.getByRole('textbox', { name: 'Sample reminder' }).fill('Second');
        await page.getByRole('button', { name: 'Load reminder' }).click();
        await editor.focus();
        await editor.press('ControlOrMeta+z');
        await expect(output).toHaveText('First');
        await editor.press('ControlOrMeta+Shift+z');
        await expect(output).toHaveText('Second');
        await editor.press('ControlOrMeta+z');
        await selectRange(editor, 5, 5);
        await page.keyboard.type(' changed');
        await expect(output).toHaveText('First changed');
        await editor.press('ControlOrMeta+Shift+z');
        await expect(output).toHaveText('First changed');
      });

      test('respects read-only changes and remounts without stale history or duplicate input', async () => {
        const { editor, output } = await load('Existing #Work');
        await page.getByRole('checkbox', { name: 'Read only' }).check();
        await expect(editor).toHaveAttribute('contenteditable', 'false');
        await expect(editor).toHaveAttribute('aria-readonly', 'true');
        await editor.click();
        await page.keyboard.type('ignored');
        await expect(output).toHaveText('Existing #Work');
        await page.getByRole('checkbox', { name: 'Read only' }).uncheck();
        for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Remount editor' }).click();
        await selectRange(editor, 14, 14);
        await page.keyboard.type(' edited');
        await expect(output).toHaveText('Existing #Work edited');
        await editor.press('ControlOrMeta+z');
        await expect(output).toHaveText('Existing #Work');
      });

      test('round-trips Markdown and keeps chip text editable', async () => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`/?scene=lexical&host=${host}&theme=dark`);
        const editor = page.getByRole('textbox', { name: 'Lexical reminder', exact: true });
        const output = page.getByTestId('lexical-value');
        await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/notes');
        await expect(editor.locator('.rich-text-chip-project')).toHaveText('#Crate Demo');
        await expect(editor.locator('.rich-text-chip-priority')).toHaveText('!');
        await expect(output).toHaveText('Review [the notes](https://example.com/notes) #Crate Demo ! tomorrow');

        await editor.locator('a').evaluate(element => {
          const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
          (element.closest('[contenteditable]') as HTMLElement).focus();
          document.getSelection()!.setBaseAndExtent(text, 4, text, 4);
        });
        await page.keyboard.type('updated ');
        await expect(output).toHaveText('Review [the updated notes](https://example.com/notes) #Crate Demo ! tomorrow');

        await page.getByRole('textbox', { name: 'Sample reminder' }).fill('Review #Work');
        await page.getByRole('button', { name: 'Load reminder' }).click();
        await expect(editor).toHaveText('Review #Work');
        await editor.click();
        await page.keyboard.press('ControlOrMeta+ArrowRight');
        await page.keyboard.press('Backspace');
        await expect(output).toHaveText('Review #Wor');
        await page.keyboard.type('k !');
        await expect(output).toHaveText('Review #Work !');
        await expect(editor.locator('.rich-text-chip-project')).toHaveText('#Work');
        await expect(editor.locator('.rich-text-chip-priority')).toHaveText('!');
        expect(errors).toEqual([]);
      });

      test('preserves selection through formatting, undo and redo', async () => {
        await page.goto(`/?scene=lexical&host=${host}&theme=dark`);
        const editor = page.getByRole('textbox', { name: 'Lexical reminder', exact: true });
        const output = page.getByTestId('lexical-value');
        await page.getByRole('textbox', { name: 'Sample reminder' }).fill('Hello world');
        await page.getByRole('button', { name: 'Load reminder' }).click();
        await expect(editor).toHaveText('Hello world');
        await editor.click();
        await page.keyboard.press('ControlOrMeta+ArrowLeft');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.type('#Work ');
        await expect(output).toHaveText('He#Work llo world');
        await page.keyboard.press('ControlOrMeta+z');
        // Formatting boundaries can split a typing run into several history entries.
        await expect(output).not.toHaveText('He#Work llo world');
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(output).toHaveText('He#Work llo world');
        await page.keyboard.type('X');
        await expect(output).toHaveText('He#Work Xllo world');
      });

      test('pastes plain text safely and retains newlines and Unicode', async () => {
        await page.goto(`/?scene=lexical&host=${host}&theme=dark`);
        const editor = page.getByRole('textbox', { name: 'Lexical reminder', exact: true });
        const output = page.getByTestId('lexical-value');
        await page.getByRole('textbox', { name: 'Sample reminder' }).fill('');
        await page.getByRole('button', { name: 'Load reminder' }).click();
        await editor.click();
        const text = 'Plan 👩🏽‍💻 café\n第二行 #Work !\n<script>alert(1)</script>';
        await editor.evaluate((element, text) => {
          const data = new DataTransfer();
          data.setData('text/plain', text);
          data.setData('text/html', '<b>Unexpected HTML</b>');
          element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        }, text);
        await expect(output).toHaveJSProperty('textContent', text);
        await expect(editor.locator('script, b')).toHaveCount(0);
        await expect(editor.locator('.rich-text-chip-project')).toHaveText('#Work');
        await page.keyboard.press('ControlOrMeta+z');
        await expect(output).toHaveText('');
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(output).toHaveJSProperty('textContent', text);
      });
    });
  }
}
