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
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } });
    const path = 'Reminders/Projects/café: <img src=x>.md';
    const issues = [
      { path, scope: 'reminders', message: 'Invalid reminder description encoding on line 42' },
      { path: 'Notes/locked.md', message: 'EACCES: permission denied' },
      { path: 'Assets/large.pdf', message: 'Skipped local file larger than 25MB' },
      { message: 'Request timed out' },
      { path: 'Reminders/' + 'long-folder-name/'.repeat(14) + 'note.md', message: 'Duplicate reminder identity' },
    ];
    renderSyncIssues(document.querySelector('.crate-sync-error-message'), issues, {
      fileActions: path => [{ id: 'open', title: 'Open in Obsidian', icon: 'file', run: async () => { window.opened = path; } }],
    });
  `,
} });
const css = compileString("@use 'src/styles/plugin/activity';", { loadPaths: [process.cwd()] }).css;
await mkdir('.generated/activity-errors', { recursive: true });
for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    for (const width of [900, 390]) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: 850 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent(`<!doctype html><html data-theme="${theme}"><style>
          :root { --background-primary: #fff; --background-secondary: #fafafa; --background-modifier-border: #dedee3;
            --background-modifier-error: #c24b5212; --background-modifier-error-hover: #c24b5220;
            --text-normal: #25252a; --text-muted: #66666e; --text-error: #ba4249; --interactive-accent: #5e5e68;
            --font-ui-small: 13px; --font-ui-smaller: 12px; --font-interface: -apple-system, sans-serif; }
          [data-theme="dark"] { --background-primary: #1c1c1f; --background-secondary: #202024; --background-modifier-border: #44444a;
            --text-normal: #e3e3e8; --text-muted: #b0b0b8; --text-error: #ec9298; }
          * { box-sizing: border-box; } body { margin: 0; padding: 24px; background: var(--background-secondary); color: var(--text-normal); font: 14px/1.45 var(--font-interface); }
          button { font: inherit; color: inherit; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 6px 12px; }
          .crate-activity-modal { background: var(--background-primary); max-width: 850px; height: 740px; margin: auto; padding: 16px; border-radius: 16px; }
          .fixture-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
          .crate-activity-body { padding: 16px; } h2 { font-size: 19px; margin: 0; }
          @media(max-width: 500px) { body { padding: 8px; } .crate-activity-modal { padding: 8px; } }
          ${css}
        </style><body><div class="crate-activity-modal">
          <div class="fixture-header"><h2>Sync activity</h2><button>Sync vault</button></div>
          <div class="crate-sync-error-notice"><div class="crate-sync-error-copy">
            <div class="crate-sync-error-title">Sync needs attention</div><div class="crate-sync-error-message"></div>
          </div></div>
          <div class="crate-activity-tab-bar">Pending &nbsp; Conflicts &nbsp; History</div>
          <div class="crate-activity-body">Your pending changes remain available here.</div>
        </div></body></html>`);
        await page.addScriptTag({ content: outputFiles[0].text });
        await expect(page.locator('.crate-sync-issue-path').first()).toHaveText('Reminders/Projects/café: <img src=x>.md');
        await expect(page.locator('.crate-sync-issue-summary').first()).toContainText('line 42');
        await expect(page.locator('img')).toHaveCount(0);
        await page.getByRole('button', { name: 'Open file:' }).first().click();
        assert.equal(await page.evaluate(() => window.opened), 'Reminders/Projects/café: <img src=x>.md');
        await page.getByRole('button', { name: 'Copy error details:' }).first().click();
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
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  } finally { await browser.close(); }
}
console.log('Sync error review passed in Chromium and WebKit at desktop/mobile sizes and light/dark themes.');
