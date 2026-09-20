import assert from 'node:assert/strict';
import { compileString } from 'sass';
import { chromium, webkit } from '@playwright/test';

const css = compileString("@use 'src/styles/plugin/activity'; @use 'src/styles/plugin/history-browser';", { loadPaths: [process.cwd()] }).css;
// Keep the production panel ancestry, including display:contents tabs and
// History's toolbar/content wrapper. Measure the visible group, not its box.
for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
        for (const [width, height] of [[1280, 900], [390, 844], [390, 400]]) {
            const page = await browser.newPage({ viewport: { width, height } });
            for (const tab of ['pending', 'conflicts', 'history']) {
                const empty = '<div class="crate-activity-empty-state"><div class="crate-empty-icon"></div><div class="crate-empty-text"><span class="crate-empty-title">No activity</span><span class="crate-empty-desc">There are no files requiring attention.</span></div></div>';
                await page.setContent(`<style>${css}
                    * { box-sizing: border-box; } body { margin: 0; }
                    .crate-modal-header-host { height: 50px; }
                    .crate-activity-tab-bar { height: 40px; }
                </style><div class="crate-reminders-ui"><div class="crate-activity-surface ${width < 700 ? 'is-bottom-sheet' : 'is-centered'}"><div class="crate-activity-modal">
                    <div class="crate-modal-header-host">Sync activity</div><div class="crate-activity-body"><div class="crate-activity-tabs-host"><div class="crate-activity-tabs-layout">
                    <div class="crate-activity-tab-bar">Pending Conflicts History</div>
                    ${['pending', 'conflicts', 'history'].map(name => `<div class="crate-activity-panel" ${name === tab ? '' : 'hidden'}>${name === 'history' ? `<div class="crate-history-timeline-toolbar"><button>Browse vault history</button></div><div class="crate-history-timeline-content">${empty}</div>` : empty}</div>`).join('')}
                    </div></div></div></div></div></div>`);
                const geometry = await page.evaluate(() => {
                    const panel = document.querySelector('.crate-activity-panel:not([hidden])');
                    const area = (panel.querySelector('.crate-history-timeline-content') ?? panel).getBoundingClientRect();
                    const icon = panel.querySelector('.crate-empty-icon').getBoundingClientRect();
                    const text = panel.querySelector('.crate-empty-text').getBoundingClientRect();
                    return {
                        x: (icon.left + icon.right) / 2 - (area.left + area.right) / 2,
                        y: (icon.top + text.bottom) / 2 - (area.top + area.bottom) / 2,
                        overflow: panel.scrollHeight - panel.clientHeight,
                        hidden: [...document.querySelectorAll('.crate-activity-panel[hidden]')].every(el => el.getBoundingClientRect().height === 0),
                    };
                });
                const label = `${engine.name()} ${width}x${height} ${tab}`;
                assert.ok(Math.abs(geometry.x) <= 1, `${label}: horizontal offset ${geometry.x}`);
                assert.ok(Math.abs(geometry.y) <= 1, `${label}: vertical offset ${geometry.y}`);
                assert.ok(geometry.overflow <= 1, `${label}: unnecessary scrolling`);
                assert.ok(geometry.hidden, `${label}: inactive panels visible`);
            }
            await page.close();
        }
    } finally {
        await browser.close();
    }
}
console.log('Activity empty states centered in Chromium and WebKit at desktop, mobile, and short viewport sizes.');
