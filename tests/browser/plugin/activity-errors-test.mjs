import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

// Real error renderer and styles with the host's DOM helpers.
const { outputFiles } = await build({ write: false, bundle: true, format: 'iife', platform: 'browser', stdin: {
  resolveDir: process.cwd(), loader: 'ts', contents: `
    import { renderSyncIssues } from './src/ui/activity/sync-issues';
    HTMLElement.prototype.createEl = function(tag, options = {}) {
      const el = document.createElement(tag);
      if (options.cls) el.className = options.cls;
      if (options.text) el.textContent = options.text;
      for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
      this.append(el); return el;
    };
    HTMLElement.prototype.createDiv = function(options) { return this.createEl('div', options); };
    HTMLElement.prototype.setText = function(text) { this.textContent = text; };
    HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
    HTMLElement.prototype.removeClass = function(...names) { this.classList.remove(...names); };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } });
    const path = 'Reminders/Projects/café: <img src=x>.md';
    const issues = [
      { path, scope: 'reminders', message: 'Invalid reminder description encoding on line 42' },
      { path: 'Notes/locked.md', message: 'EACCES: permission denied' },
      { path: 'Assets/large.pdf', message: 'Skipped local file larger than 25MB' },
      { message: 'Request timed out' },
      { path: 'Reminders/' + 'long-folder-name/'.repeat(14) + 'note.md', message: 'Duplicate reminder identity' },
    ];
    window.mountSingle = () => {
      const container = document.querySelector('.crate-sync-error-message');
      container.replaceChildren();
      renderSyncIssues(container, [{message:'Unsupported reminder description encoding'}]);
    };
    renderSyncIssues(document.querySelector('.crate-sync-error-message'), issues, {
      fileActions: path => [{ id: 'open', title: 'Open in Obsidian', icon: 'file', run: async () => { window.opened = path; } }],
    });
  `,
} });
const css = compileString("@use 'src/styles/plugin/activity'; @use 'src/ui/shared/styles/tokens'; .crate-reminders-ui { @include tokens.styles; }", { loadPaths: [process.cwd()] }).css;
await mkdir('.generated/activity-errors', { recursive: true });
for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    for (const width of [900, 390]) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: 850 }, isMobile: width === 390, hasTouch: width === 390 });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent(`<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
          :root { --background-primary: #fff; --background-secondary: #fafafa; --background-modifier-border: #dedee3;
            --background-modifier-error: #c24b5212; --background-modifier-error-hover: #c24b5220;
            --text-normal: #25252a; --text-muted: #66666e; --text-error: #ba4249; --interactive-accent: #5e5e68;
            --font-ui-small: 13px; --font-ui-smaller: 12px; --font-interface: -apple-system, sans-serif; --background-modifier-hover: #8882; --font-semibold: 600; }
          [data-theme="dark"] { --background-primary: #1c1c1f; --background-secondary: #202024; --background-modifier-border: #44444a;
            --text-normal: #e3e3e8; --text-muted: #b0b0b8; --text-error: #ec9298; }
          * { box-sizing: border-box; } body { margin: 0; padding: 24px; background: var(--background-secondary); color: var(--text-normal); font: 14px/1.45 var(--font-interface); }
          button { font: inherit; color: inherit; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 6px 12px; }
          .crate-reminders-ui { max-width: 850px; margin: auto; }
          .crate-activity-modal { background: var(--background-primary); max-width: 850px; height: 740px; margin: auto; padding: 16px; border-radius: 16px; }
          .fixture-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
          .crate-activity-body { padding: 16px; } h2 { font-size: 19px; margin: 0; }
          @media(max-width: 500px) { body { padding: 8px; } .crate-activity-modal { padding: 8px; } }
          ${css}
        </style><body><div class="crate-reminders-ui"><div class="crate-activity-modal">
          <div class="fixture-header"><h2>Sync activity</h2><button>Sync vault</button></div>
          <div class="crate-sync-error-notice"><div class="crate-sync-error-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m10.3 3.9-8.5 14.7a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></svg></div><div class="crate-sync-error-copy">
            <div class="crate-sync-error-title">Sync needs attention</div><div class="crate-sync-error-message"></div>
          </div></div>
          <div class="crate-activity-tab-bar">Pending &nbsp; Conflicts &nbsp; History</div>
          <div class="crate-activity-body">Your pending changes remain available here.</div>
        </div></div></body></html>`);
        await page.addScriptTag({ content: outputFiles[0].text });
        await expect(page.locator('.crate-sync-issue-path').first()).toHaveText('Reminders/Projects/café: <img src=x>.md');
        await expect(page.locator('.crate-sync-issue-summary').first()).toContainText('line 42');
        await expect(page.locator('img')).toHaveCount(0);
        await page.getByRole('button', { name: 'Open file:' }).first().click();
        assert.equal(await page.evaluate(() => window.opened), 'Reminders/Projects/café: <img src=x>.md');
        const firstDetails = page.locator('.crate-sync-issue-details').first();
        const firstToggle = page.locator('.crate-sync-issue-toggle').first();
        await expect(firstDetails).toBeHidden();
        await firstToggle.focus();
        await page.keyboard.press('Enter');
        await expect(firstDetails).toBeVisible();
        await expect(firstToggle).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Enter');
        await expect(firstDetails).toBeHidden();
        const rowHeight = await page.locator('.crate-sync-issue').first().evaluate(el => el.getBoundingClientRect().height);
        await page.getByRole('button', { name: 'Copy error details:' }).first().click();
        await expect(page.locator('.crate-sync-issue-copy').first()).toHaveText('Copied');
        assert.equal(await page.locator('.crate-sync-issue').first().evaluate(el => el.getBoundingClientRect().height), rowHeight);
        assert.match(await page.evaluate(() => window.copied), /line 42/);
        await page.getByText('Review 2 more issues', { exact: true }).click();
        await expect(page.locator('.crate-sync-issues-more')).toHaveAttribute('open', '');
        await page.getByRole('button', { name: 'Open file:' }).last().click();
        assert.match(await page.evaluate(() => window.opened), /long-folder-name/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok(await page.locator('.crate-activity-body').evaluate(el => el.getBoundingClientRect().height) > 100);
        // Return to the first error for a visual review of the initial state.
        await page.locator('.crate-sync-error-notice').evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: `.generated/activity-errors/${browserType.name()}-${width}-${theme}.png` });
        await page.evaluate(() => window.mountSingle());
        const notice = page.locator('.crate-sync-error-notice');
        const height = await notice.evaluate(el => el.getBoundingClientRect().height);
        assert.ok(height < (width === 390 ? 230 : 165), 'Collapsed single error should stay compact');
        const copy = page.getByRole('button', {name:'Copy error details', exact:true});
        const toggle = page.locator('.crate-sync-issue-toggle');
        assert.ok(Math.abs((await copy.boundingBox()).y - (await toggle.boundingBox()).y) < 1, 'Actions share one row');
        if (width === 390) assert.ok((await copy.boundingBox()).height >= 44, 'Touch actions remain accessible');
        await copy.click();
        assert.equal(await notice.evaluate(el => el.getBoundingClientRect().height), height, 'Copy confirmation does not shift the alert');
        await page.screenshot({path: `.generated/activity-errors/${browserType.name()}-${width}-${theme}-single.png`});
        await toggle.click();
        await expect(page.locator('.crate-sync-issue-details')).toBeVisible();
        await expect(page.locator('.crate-sync-issue-repair')).toContainText('crate-desc');
        await expect(page.locator('.crate-sync-issue-details pre')).toHaveText('Unsupported reminder description encoding');
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  } finally { await browser.close(); }
}
console.log('Sync error review passed in Chromium and WebKit at desktop/mobile sizes and light/dark themes.');
