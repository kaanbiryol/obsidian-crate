import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webkit } from '@playwright/test';

// Check the built plugin stylesheet against the Obsidian iOS host rules behind
// two device-only bugs. iOS clipped fixed sheets to a transformed `.modal`'s
// empty, scrolling `.modal-content`; desktop WebKit does not reproduce that
// clipping, so the check asserts the content box no longer scrolls. Mobile
// sidebars paint --background-secondary while Crate painted --background-primary.
const css = await readFile(process.env.CRATE_PLUGIN_CSS_PATH ?? 'dist/styles.css', 'utf8');
const hostCss = `
  body { margin: 0; --background-primary: #000; --background-secondary: #1e1e1e; }
  .is-mobile .modal-container .modal .modal-content { display: flex; overflow: auto; }
  /* Obsidian's open transition keeps a transform even over Crate's !important rule. */
  #crate-test-modal { transform: translateY(0px) !important; }
  .workspace-drawer { position: fixed; inset: 0 auto 0 0; width: 320px; background: var(--background-secondary); }
`;

const browser = await webkit.launch();
try {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true });
  await page.setContent(`<!doctype html><html><head><style>${hostCss}</style><style>${css}</style></head><body class="theme-dark is-mobile is-phone"></body></html>`);

  const editorShell = await page.evaluate(() => {
    const container = document.body.appendChild(document.createElement('div'));
    container.className = 'modal-container mod-dim';
    const modal = container.appendChild(document.createElement('div'));
    modal.id = 'crate-test-modal';
    modal.className = 'modal crate-reminder-editor-modal is-mobile';
    const content = modal.appendChild(document.createElement('div'));
    content.className = 'modal-content crate-reminder-editor-modal__content crate-reminders-ui';
    return getComputedStyle(content).overflow;
  });
  assert.equal(editorShell, 'visible', 'Obsidian modal content does not scroll around a Crate sheet');

  const sidebar = await page.evaluate(() => {
    const drawer = document.body.appendChild(document.createElement('div'));
    drawer.className = 'workspace-drawer';
    const view = drawer.appendChild(document.createElement('div'));
    view.className = 'view-content crate-reminders-view-container';
    const shadow = view.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.surface { height: 40px; background: var(--background-primary); }');
    shadow.adoptedStyleSheets = [sheet];
    const surface = shadow.appendChild(document.createElement('div'));
    surface.className = 'surface';
    return getComputedStyle(surface).backgroundColor;
  });
  assert.equal(sidebar, 'rgb(30, 30, 30)', 'Crate views in a mobile sidebar use the sidebar background');
  console.log('Plugin mobile shell checks passed.');
} finally {
  await browser.close();
}
