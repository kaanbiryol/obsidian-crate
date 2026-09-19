import { chromium, webkit, expect, test, type Browser, type Page } from '@playwright/test';
import { clearEditor, pasteText, selectRange, settleEditor } from './editor-helpers';

const url = 'https://example.com/article';
const markdown = `[${url}](${url})`;

for (const browserName of ['chromium', 'webkit'] as const) {
  for (const host of ['pwa', 'plugin']) {
    test.describe(`${browserName} / ${host} page titles`, () => {
      let browser: Browser;
      let page: Page;
      test.beforeAll(async () => { browser = await ({ chromium, webkit })[browserName].launch(); });
      test.beforeEach(async () => { page = await browser.newPage({ baseURL: 'http://127.0.0.1:8790', viewport: { width: 390, height: 844 }, hasTouch: true }); });
      test.afterEach(async () => { await page.close(); });
      test.afterAll(async () => { await browser.close(); });

      async function load(value = '') {
        await page.goto(`/?scene=lexical&host=${host}&theme=dark&titles`);
        await page.getByRole('textbox', { name: 'Sample reminder' }).fill(value);
        await page.getByRole('button', { name: 'Load reminder' }).click();
        const editor = page.getByRole('textbox', { name: 'Lexical reminder', exact: true });
        const output = page.getByTestId('lexical-value');
        await expect(output).toHaveText(value);
        await editor.focus();
        return { editor, output };
      }

      async function deferredTitle() {
        let release!: (title: string | null) => void;
        const gate = new Promise<string | null>(resolve => { release = resolve; });
        await page.route('**/__test/page-title', async route => { await route.fulfill({ json: { title: await gate } }); });
        const requested = page.waitForRequest('**/__test/page-title');
        return {
          requested,
          async finish(title = 'Fetched article') {
            const response = page.waitForResponse('**/__test/page-title');
            release(title);
            await (await response).finished();
            await settleEditor(page);
          },
        };
      }

      for (const action of ['external load', 'remount', 'read only', 'composition']) {
        test(`ignores pending results after ${action}`, async () => {
          const { editor, output } = await load();
          const pending = await deferredTitle();
          await pasteText(editor, url); await pending.requested;
          if (action === 'external load') {
            await page.getByRole('textbox', { name: 'Sample reminder' }).fill('A different reminder');
            await page.getByRole('button', { name: 'Load reminder' }).click();
          } else if (action === 'remount') await page.getByRole('button', { name: 'Remount editor' }).click();
          else if (action === 'read only') {
            const checkbox = page.getByRole('checkbox', { name: 'Read only' });
            await checkbox.focus(); await checkbox.check();
          }
          else await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
          await pending.finish();
          await expect(output).toHaveText(action === 'external load' ? 'A different reminder' : markdown);
        });
      }

      test('does not steal focus when a lookup completes after blur', async () => {
        const { editor, output } = await load(); const pending = await deferredTitle();
        await pasteText(editor, url); await pending.requested;
        const other = page.getByRole('textbox', { name: 'Sample reminder' }); await other.focus();
        await pending.finish();
        await expect(other).toBeFocused();
        await expect(output).toHaveText('[Fetched article](https://example.com/article)');
        await expect(editor.locator('a')).toHaveText('Fetched article');
      });

      test('preserves the caret after replacing a URL in the middle of a reminder', async () => {
        const { editor, output } = await load('Before  after'); const pending = await deferredTitle();
        await selectRange(editor, 7, 7); await pasteText(editor, url); await pending.requested; await pending.finish();
        await page.keyboard.insertText(' next');
        await expect(output).toHaveText('Before [Fetched article](https://example.com/article) next after');
      });

      test('does not resurrect a lookup after undo followed by redo', async () => {
        const { editor, output } = await load(); const pending = await deferredTitle();
        await pasteText(editor, url); await pending.requested;
        await editor.press('ControlOrMeta+z');
        await expect(output).toHaveText('');
        await settleEditor(page);
        await editor.press('ControlOrMeta+Shift+z');
        await expect(output).toHaveText(markdown); await pending.finish();
        await expect(output).toHaveText(markdown);
      });

      test('out-of-order results never replace the wrong pasted link', async () => {
        const { editor, output } = await load();
        let first!: () => void; const firstGate = new Promise<void>(resolve => { first = resolve; });
        await page.route('**/__test/page-title', async route => {
          const firstUrl = (route.request().postDataJSON() as { url?: unknown }).url === url;
          if (firstUrl) await firstGate;
          await route.fulfill({ json: { title: firstUrl ? 'Stale first title' : 'Second article' } });
        });
        const firstRequest = page.waitForRequest('**/__test/page-title');
        await pasteText(editor, url); await firstRequest;
        await page.keyboard.insertText(' '); await pasteText(editor, 'https://example.org/second');
        await expect(output).toHaveText(`${markdown} [Second article](https://example.org/second)`);
        const response = page.waitForResponse('**/__test/page-title'); first(); await (await response).finished(); await settleEditor(page);
        await expect(output).toHaveText(`${markdown} [Second article](https://example.org/second)`);
      });

      for (const [name, title, expected] of [
        ['entities and whitespace', ' \n A &quot;title&quot; &#x1F600; &amp; café\t ', 'A "title" 😀 & café'],
        ['markup and Markdown delimiters', '<img src=x onerror=alert(1)> [x] \\ $&', '<img src=x onerror=alert(1)> ［x］ ＼ $&'],
        ['encoded markup', '&lt;script&gt;alert(1)&lt;/script&gt;', '<script>alert(1)</script>'],
        ['metadata words', '#Work ! tomorrow', '#Work ! tomorrow'],
        ['long titles', 'a'.repeat(400), 'a'.repeat(256)],
        ['Unicode boundary', 'a'.repeat(255) + '😀', 'a'.repeat(255) + '😀'],
      ]) {
        test(`renders ${name} as a safe link label`, async () => {
          const { editor, output } = await load();
          await page.route('**/__test/page-title', route => route.fulfill({ json: { title } }));
          await pasteText(editor, url);
          await expect(output).toHaveText(`[${expected}](${url})`);
          await page.getByRole('textbox', { name: 'Sample reminder' }).focus();
          await expect(editor.locator('a')).toHaveText(expected!);
          await expect(editor.locator('a')).toHaveAttribute('href', url);
          await expect(editor.locator('script, img, .rich-text-chip')).toHaveCount(0);
        });
      }

      for (const failure of ['null title', 'empty title', 'whitespace title', 'non-string title', 'invalid JSON', 'HTTP error', 'network error']) {
        test(`retains the URL on ${failure} and remains editable`, async () => {
          const { editor, output } = await load();
          const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
          await page.route('**/__test/page-title', route => {
            if (failure === 'network error') return route.abort('failed');
            if (failure === 'HTTP error') return route.fulfill({ status: 503, body: 'Unavailable' });
            if (failure === 'invalid JSON') return route.fulfill({ body: '{' });
            return route.fulfill({ json: { title: failure === 'null title' ? null : failure === 'empty title' ? '' : failure === 'non-string title' ? 42 : ' \n &nbsp; ' } });
          });
          const finished = failure === 'network error' ? page.waitForEvent('requestfailed', request => request.url().endsWith('/__test/page-title'))
            : page.waitForResponse('**/__test/page-title').then(response => response.finished());
          await pasteText(editor, url); await finished; await settleEditor(page);
          await expect(output).toHaveText(markdown);
          await page.keyboard.insertText(' more'); await expect(output).toHaveText(`${markdown} more`);
          expect(errors).toEqual([]);
        });
      }

      test('does not fetch titles for ordinary text, existing Markdown, or unsupported URLs', async () => {
        let requests = 0;
        await page.route('**/__test/page-title', route => { requests++; return route.fulfill({ json: { title: 'Unexpected' } }); });
        const { editor, output } = await load();
        for (const text of ['Read https://example.com tomorrow', '[Existing](https://example.com)', 'https://example.com\nhttps://example.org', 'mailto:user@example.com', 'javascript:alert(1)']) {
          await editor.press('ControlOrMeta+a'); await editor.press('Backspace'); await pasteText(editor, text); await settleEditor(page);
          await expect(output).toHaveJSProperty('textContent', text);
        }
        expect(requests).toBe(0);
      });

      test('read-only editors reject synthetic paste without fetching', async () => {
        const { editor, output } = await load('Keep this');
        let requests = 0; await page.route('**/__test/page-title', route => { requests++; return route.fulfill({ json: { title: 'Unexpected' } }); });
        await page.getByRole('checkbox', { name: 'Read only' }).check();
        await pasteText(editor, url); await settleEditor(page);
        await expect(output).toHaveText('Keep this'); expect(requests).toBe(0);
      });

      async function editorFields() {
        await page.goto(`/?scene=editor&host=${host}&theme=dark&titles`);
        const description = page.getByRole('textbox', { name: 'Reminder description' });
        const title = page.getByRole('textbox', { name: 'Reminder title' });
        return { title, description };
      }

      test('fetches automatically before and after reload without a setting', async () => {
        await page.route('**/__test/page-title', route => route.fulfill({ json: { title: 'Automatic title' } }));
        const { description } = await editorFields();
        await expect(page.getByRole('checkbox', { name: 'Fetch page titles' })).toHaveCount(0);
        await clearEditor(description); await pasteText(description, url);
        await expect(description).toHaveText(`[Automatic title](${url})`);
        await page.reload();
        await clearEditor(description); await pasteText(description, url);
        await expect(description).toHaveText(`[Automatic title](${url})`);
      });

      test('fetches automatically when browser storage is unavailable', async () => {
        await page.addInitScript(() => {
          Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
          Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
        });
        const { description } = await editorFields();
        await page.route('**/__test/page-title', route => route.fulfill({ json: { title: 'Works without storage' } }));
        await clearEditor(description); await pasteText(description, url);
        await expect(description).toHaveText(`[Works without storage](${url})`);
      });

      test('resolves title and description lookups independently', async () => {
        const { title, description } = await editorFields();
        let first!: () => void; const gate = new Promise<void>(resolve => { first = resolve; });
        await page.route('**/__test/page-title', async route => {
          const firstUrl = (route.request().postDataJSON() as { url?: unknown }).url === url;
          if (firstUrl) await gate;
          await route.fulfill({ json: { title: firstUrl ? 'Title article' : 'Description article' } });
        });
        await clearEditor(title); const requested = page.waitForRequest('**/__test/page-title');
        await pasteText(title, url); await requested;
        await clearEditor(description); await pasteText(description, 'https://example.org');
        await expect(description).toHaveText('[Description article](https://example.org)');
        const response = page.waitForResponse('**/__test/page-title'); first(); await (await response).finished(); await settleEditor(page);
        await expect(title.locator('a')).toHaveText('Title article');
        await expect(title.locator('a')).toHaveAttribute('href', url);
        await title.focus(); await expect(description.locator('a')).toHaveText('Description article');
      });
    });
  }
}
