import { expect, type Locator, type Page } from '@playwright/test';

export async function clearEditor(editor: Locator) {
  // Use native editing commands: WebKit's injected fill selection is unreliable in Shadow DOM.
  await editor.focus();
  await editor.press('ControlOrMeta+a');
  await editor.press('Backspace');
  await expect(editor).toHaveText('');
}

export async function selectRange(editor: Locator, anchor: number, focus: number) {
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

export async function pasteText(editor: Locator, text: string) {
  await editor.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}

export async function settleEditor(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
