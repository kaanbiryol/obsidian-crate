import { test, expect, type Locator } from '@playwright/test';

// Only the public editor API, browser editing operations and Markdown output
// are part of this contract. No implementation names, node classes or model APIs.
async function range(editor: Locator, anchor: number, focus = anchor) {
  await editor.evaluate((element, offsets) => {
    (element as HTMLElement).focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const point = (offset: number): [Node, number] => {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      throw new Error('Requested selection outside editor');
    };
    const [a, ao] = point(offsets.anchor);
    const [f, fo] = point(offsets.focus);
    document.getSelection()!.setBaseAndExtent(a, ao, f, fo);
    document.dispatchEvent(new Event('selectionchange'));
  }, { anchor, focus });
}
async function expectCaret(editor: Locator, offset: number) {
  await expect.poll(() => editor.evaluate(element => {
    const selection = element.ownerDocument.getSelection() as (Selection & {
      getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
    }) | null;
    if (!selection?.rangeCount) return -1;
    let selected: AbstractRange | undefined = selection.getRangeAt(0);
    const root = element.getRootNode();
    // WebKit retargets ordinary selection access to the shadow host.
    if (root instanceof ShadowRoot && selection.getComposedRanges) {
      selected = selection.getComposedRanges({ shadowRoots: [root] })[0] ?? selected;
    }
    if (!selected || !element.contains(selected.endContainer)) return -1;
    const prefix = element.ownerDocument.createRange();
    prefix.setStart(element, 0);
    prefix.setEnd(selected.endContainer, selected.endOffset);
    return prefix.toString().length;
  })).toBe(offset);
}
async function paste(editor: Locator, text: string) {
  await editor.evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    data.setData('text/html', '<b>Unexpected HTML</b><img src=x onerror="window.injected=true">');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}
const errors = new WeakMap<object, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
async function open(page: import('@playwright/test').Page, host: unknown, value: string, autoFocus = false) {
  if (host !== 'pwa' && host !== 'plugin') throw new Error('Unknown test host');
  await page.goto(`/?host=${host}&value=${encodeURIComponent(value)}&autofocus=${autoFocus}`);
  const editor = page.getByRole('textbox', { name: 'Reminder', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('value')).toHaveJSProperty('textContent', value);
  return { editor, output: page.getByTestId('value') };
}

for (const value of ['', 'Plain reminder', '  padded text  ', 'first\nsecond\n第三行 👩🏽‍💻', 'Review [docs](https://example.com) #Work ! tomorrow']) {
  test(`loads and remounts exact Markdown ${JSON.stringify(value)}`, async ({ page }, info) => {
    const { editor, output } = await open(page, info.project.metadata.host, value);
    await page.getByRole('button', { name: 'Remount', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(output).toHaveJSProperty('textContent', value);
    if (value.includes('[docs]')) await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com');
    await page.getByRole('button', { name: 'Focus end', exact: true }).click();
    await page.keyboard.insertText('X');
    await expect(output).toHaveJSProperty('textContent', value + 'X');
  });
}
test('inserts at the start, middle and end without losing caret position', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'abcdef');
  await range(editor, 3); await page.keyboard.type('XY');
  await expect(output).toHaveText('abcXYdef');
  await range(editor, 0); await page.keyboard.type('start ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.type(' end');
  await expect(output).toHaveText('start abcXYdef end');
});
for (const backward of [false, true]) {
  test(`replaces ${backward ? 'backward' : 'forward'} selection across link and project`, async ({ page }, info) => {
    const value = 'Start [docs](https://example.com) #Work end';
    const { editor, output } = await open(page, info.project.metadata.host, value);
    await range(editor, backward ? 16 : 6, backward ? 6 : 16);
    await page.keyboard.insertText('replacement');
    await expect(output).toHaveText('Start replacement end');
    await editor.press('ControlOrMeta+z'); await expect(output).toHaveText(value);
    await editor.press('ControlOrMeta+Shift+z'); await expect(output).toHaveText('Start replacement end');
  });
}
test('edits a link label without changing its URL', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Read [docs](https://example.com) now');
  await range(editor, 7); await page.keyboard.type('NEW');
  await expect(output).toHaveText('Read [doNEWcs](https://example.com) now');
  // The active link exposes Markdown; blur restores its rendered anchor.
  await page.getByRole('button', { name: 'Blur editor', exact: true }).click();
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com');
});
test('deletes an entire link and restores it with undo', async ({ page }, info) => {
  const value = 'A [docs](https://example.com) B';
  const { editor, output } = await open(page, info.project.metadata.host, value);
  await range(editor, 2, 6); await page.keyboard.press('Backspace');
  await expect(output).toHaveText('A  B'); await expect(editor.locator('a')).toHaveCount(0);
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveText(value);
});
test('edits inside a project marker as ordinary text', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Plan #Work');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.press('Backspace'); await expect(output).toHaveText('Plan #Wor');
  await page.keyboard.type('k !'); await expect(output).toHaveText('Plan #Work !');
  await range(editor, 5, 10); await page.keyboard.insertText('today');
  await expect(output).toHaveText('Plan today !');
});
test('pastes multiline Unicode as text and round-trips paste history', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Replace me');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  const text = '👩🏽‍💻 café e\u0301\n第二行 #Work !\n<script>literal</script>';
  await paste(editor, text); await expect(output).toHaveJSProperty('textContent', text);
  await expect(editor.locator('b, img, script')).toHaveCount(0);
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('Replace me');
  await editor.press('ControlOrMeta+Shift+z'); await expect(output).toHaveJSProperty('textContent', text);
});
test('normalizes duplicate markers on paste', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Old');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await paste(editor, 'Read [docs](https://example.com) #Crate Demo #Work ! !');
  await expect(output).toHaveText('Read [docs](https://example.com) #Work !');
});
test('inserts and rejoins a newline', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'alphaomega');
  await range(editor, 5); await page.keyboard.press('Enter');
  await expect(output).toHaveJSProperty('textContent', 'alpha\nomega');
  await page.keyboard.press('Backspace'); await expect(output).toHaveText('alphaomega');
});
test('keeps project suggestions closed on focus and opens them when editing the project', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Buy coffee #Work', true);
  await expect(editor).toBeFocused();
  await expect(page.getByTestId('query')).toHaveText('(none)');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await expectCaret(editor, 'Buy coffee #Work'.length);
  await expect(page.getByTestId('query')).toHaveText('(none)');
  await expect(output).toHaveText('Buy coffee #Work');
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('query')).toHaveText('Wor');
  await page.keyboard.type('k ');
  await expect(page.getByTestId('query')).toHaveText('(none)');
});
test('reports autocomplete after a Markdown link and accepts a host keyboard action', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Read [docs](https://example.com) ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.type('#Wo'); await expect(page.getByTestId('query')).toHaveText('Wo');
  await page.keyboard.press('Tab');
  await expect(output).toHaveJSProperty('textContent', 'Read [docs](https://example.com) #Work ');
  // The original API restores selection asynchronously; wait for the actual caret.
  await expectCaret(editor, 'Read docs #Work '.length);
  await page.keyboard.type('next');
  await expect(output).toHaveText('Read [docs](https://example.com) #Work next');
});
test('external value preserves an active caret', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'abcdef');
  await page.getByRole('textbox', { name: 'External value' }).fill('uvwxyz');
  await range(editor, 3); await page.getByRole('button', { name: 'Apply external value', exact: true }).click();
  await expect(output).toHaveText('uvwxyz');
  await expectCaret(editor, 3);
  await page.keyboard.type('X'); await expect(output).toHaveText('uvwXxyz');
});
test('honors an explicit pending caret on external replacement', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('textbox', { name: 'External value' }).fill('Replacement');
  await editor.focus(); await page.getByRole('button', { name: 'Apply at offset two', exact: true }).click();
  await expect(output).toHaveText('Replacement');
  await expectCaret(editor, 2);
  await page.keyboard.type('X'); await expect(output).toHaveText('ReXplacement');
});
test('read-only toggling prevents edits and re-enables input', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('checkbox', { name: 'Read only' }).check();
  await expect(editor).toHaveAttribute('contenteditable', 'false'); await editor.click(); await page.keyboard.type('ignored');
  await expect(output).toHaveText('Original');
  await page.getByRole('checkbox', { name: 'Read only' }).uncheck();
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.type(' edited');
  await expect(output).toHaveText('Original edited');
});
test('focus request and host Escape handling work without editing content', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('button', { name: 'Request focus', exact: true }).click(); await expect(editor).toBeFocused();
  await page.keyboard.type('X'); await expect(output).toHaveText('OriginalX');
  await page.keyboard.press('Escape'); await expect(editor).not.toBeFocused();
});
test('two editor instances keep values and undo histories isolated', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'First');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.insertText(' one');
  const other = page.getByRole('textbox', { name: 'Other reminder', exact: true });
  await range(other, 14); await page.keyboard.insertText(' two');
  await other.press('ControlOrMeta+z'); await expect(page.getByTestId('other-value')).toHaveText('Other reminder');
  await expect(output).toHaveText('First one');
  await editor.focus(); await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('First');
});
test('repeated remounts retain value but start a fresh history', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.insertText(' edit');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Remount', exact: true }).click();
  await editor.focus(); await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('Original edit');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.type('X');
  await expect(output).toHaveText('Original editX');
});
test('select-all deletion can be undone back to the complete Markdown document', async ({ page }, info) => {
  const value = 'Read [docs](https://example.com) #Crate Demo !\nSecond line';
  const { editor, output } = await open(page, info.project.metadata.host, value);
  await editor.focus(); await editor.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
  await expect(output).toHaveText('');
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveJSProperty('textContent', value);
});
test('typing Markdown creates an editable link and preserves trailing text', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Read ');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click();
  await page.keyboard.type('[docs](https://example.com) next');
  await expect(output).toHaveText('Read [docs](https://example.com) next');
  await expect(editor.locator('a')).toHaveText('docs');
});
test('updating known projects preserves text and the active caret', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Plan #New Project');
  await range(editor, 2); await page.getByRole('button', { name: 'Add known project', exact: true }).click();
  await expectCaret(editor, 2);
  await page.keyboard.type('X'); await expect(output).toHaveText('PlXan #New Project');
});
test('backspace removes one combined emoji without corrupting nearby text', async ({ page }, info) => {
  const { output } = await open(page, info.project.metadata.host, 'Plan 👩🏽‍💻');
  await page.getByRole('button', { name: 'Focus end', exact: true }).click(); await page.keyboard.press('Backspace');
  await expect(output).toHaveJSProperty('textContent', 'Plan ');
});
test('a long multiline paste preserves all text through undo and redo', async ({ page }, info) => {
  const { editor, output } = await open(page, info.project.metadata.host, 'Original');
  const long = Array.from({ length: 60 }, (_, index) => `Line ${index}: café 日本語 👩🏽‍💻 and ordinary reminder text`).join('\n');
  await page.getByRole('button', { name: 'Select all', exact: true }).click(); await paste(editor, long);
  await expect(output).toHaveJSProperty('textContent', long);
  await editor.press('ControlOrMeta+z'); await expect(output).toHaveText('Original');
  await editor.press('ControlOrMeta+Shift+z'); await expect(output).toHaveJSProperty('textContent', long);
});
