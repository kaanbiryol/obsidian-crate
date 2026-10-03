import { test, expect } from '@playwright/test';

export function registerPluginNavigationTests() {
    for (const width of [320, 1280]) {
      test(`plugin icon emphasis follows the moving highlight at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.clock.install({ time: new Date('2026-09-26T12:00:00Z') });
        await page.goto(`/?host=plugin&scene=navigation&theme=${width === 320 ? 'light' : 'dark'}`);
        const workspace = page.locator('.plugin-workspace-navigation');
        await expect(workspace.locator('.pwa-dock')).toBeVisible();
        // Drive the real Motion spring one frame at a time. A slow CI runner
        // must not skip its whole travel before the first color sample.
        await page.clock.pauseAt(new Date('2026-09-26T12:01:00Z'));
        const sampler = await workspace.evaluateHandle(root => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          const rgb = (color: string) => {
            context.fillStyle = color; context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
          };
          return {
            select: (label: string) => {
              const button = root.querySelector<HTMLElement>(`.plugin-workspace-panel[data-active="true"] .pwa-dock [aria-label="${label}"]`)!;
              button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })); button.click();
            },
            selected: () => root.querySelector('.plugin-workspace-panel[data-active="true"] [aria-current="page"]')!.getAttribute('aria-label')!,
            sample: () => Array.from(root.querySelectorAll('.pwa-dock')).map(dock => {
              const style = getComputedStyle(dock);
              const normal = rgb(style.getPropertyValue('--text-normal')), muted = rgb(style.getPropertyValue('--text-muted'));
              const distance = normal.map((channel, index) => channel - muted[index]!);
              const indicator = dock.querySelector('.pwa-dock__indicator')!;
              return { position: new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width,
                // Canvas rounds to 8-bit channels. Brighter resting icons
                // have a smaller color range, so one step exceeds 4%.
                colorStep: distance.reduce((sum, channel) => sum + Math.abs(channel), 0) / distance.reduce((sum, channel) => sum + channel ** 2, 0),
                emphasis: Array.from(dock.querySelectorAll('.pwa-dock__bar > button')).map(tab => {
                  const color = rgb(getComputedStyle(tab).color);
                  return color.reduce((sum, channel, index) => sum + (channel - muted[index]!) * distance[index]!, 0) / distance.reduce((sum, channel) => sum + channel ** 2, 0);
                }) };
            }),
          };
        });
        const result: { frames: { position: number; emphasis: number[]; colorStep: number }[][]; selected: string[] } = { frames: [], selected: [] };
        for (const [label, duration] of [['Projects', 480], ['Reading', 480], ['Inbox', 45], ['Projects', 45], ['Reminders', 480]] as const) {
          await sampler.evaluate((sampler, label) => sampler.select(label), label);
          for (let time = 0; time < duration; time += 16) {
            await page.clock.runFor(Math.min(16, duration - time));
            result.frames.push(await sampler.evaluate(sampler => sampler.sample()));
          }
          result.selected.push(await sampler.evaluate(sampler => sampler.selected()));
        }
        await sampler.dispose();
        await page.clock.resume();
        expect(result.selected).toEqual(['Projects', 'Reading', 'Inbox', 'Projects', 'Reminders']);
        expect(result.frames.flat().some(frame => frame.emphasis.some(value => value > .1 && value < .9)), 'Icon emphasis should visibly blend during travel').toBe(true);
        for (const frame of result.frames.flat()) for (const [index, emphasis] of frame.emphasis.entries()) {
          expect(Math.abs(emphasis - Math.max(0, 1 - Math.abs(frame.position - index))), `Icon ${index} must follow the painted highlight at ${frame.position}`).toBeLessThanOrEqual(Math.max(.04, frame.colorStep));
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const active = workspace.locator('.plugin-workspace-panel[data-active="true"]');
        await active.getByRole('button', { name: 'Reading', exact: true }).click();
        await expect(active.getByRole('button', { name: 'Reading', exact: true })).toHaveCSS('transition-duration', '0s');
        await expect.poll(() => active.locator('.pwa-dock__indicator').evaluate(indicator => new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width)).toBeCloseTo(3, 2);
      });
      test(`plugin picker selection keeps one closing surface at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(`/?host=plugin&scene=navigation&theme=${width === 320 ? 'light' : 'dark'}`);
        const workspace = page.locator('.plugin-workspace-navigation');
        const active = workspace.locator('.plugin-workspace-panel[data-active="true"]');
        await active.getByRole('button', { name: 'Projects', exact: true }).click();
        for (const label of ['Highlights', 'Favorites', 'Archive']) {
          if (label === 'Archive') await active.getByRole('button', { name: 'Inbox', exact: true }).click();
          await active.locator('[data-dock-group]').press('ArrowDown');
          const menu = page.getByRole('dialog', { name: 'More views' });
          await expect(active.locator('.pwa-dock__tab').first()).toHaveCSS('opacity', '0');
          await expect.poll(() => active.locator('.pwa-dock').evaluate(dock => parseFloat(getComputedStyle(dock).getPropertyValue('--dock-menu-inset')))).toBeLessThan(.2);
          const frames = await menu.evaluate(async (menu, label) => {
            const root = menu.closest('.plugin-workspace-navigation')!;
            const labels = () => Array.from(menu.querySelectorAll('button')).map(button => button.textContent);
            const before = labels();
            Array.from(menu.querySelectorAll('button')).find(button => button.textContent === label)!.click();
            const frames = [], start = performance.now();
            while (performance.now() - start < 600) {
              await new Promise(requestAnimationFrame);
              frames.push({ labels: menu.isConnected ? labels() : before,
                docks: Array.from(root.querySelectorAll('.pwa-dock')).map(dock => ({
                  height: dock.querySelector('.pwa-dock__surface')!.getBoundingClientRect().height,
                  tabs: Number(getComputedStyle(dock.querySelector('.pwa-dock__tab')!).opacity),
                  indicator: Number(getComputedStyle(dock.querySelector('.pwa-dock__indicator')!).opacity),
                })) });
            }
            return { before, frames };
          }, label);
          expect(frames.frames.every(frame => JSON.stringify(frame.labels) === JSON.stringify(frames.before)), 'Closing choices must not be replaced by the displaced tab').toBe(true);
          expect(frames.frames.every(frame => frame.docks.length === 2 && Math.abs(frame.docks[0]!.height - frame.docks[1]!.height) < .5), `Feature surfaces must shrink together: ${JSON.stringify(frames.frames)}`).toBe(true);
          expect(frames.frames.every(frame => frame.docks.every(dock => Math.abs(dock.tabs - dock.indicator) < .01))).toBe(true);
          expect(frames.frames.every(frame => Math.abs(frame.docks[0]!.tabs - frame.docks[1]!.tabs) < .01), 'Both bars must reveal their icons and indicator together').toBe(true);
          expect(frames.frames.some(frame => frame.docks.every(dock => dock.height > 65))).toBe(true);
          await expect(active.locator('.pwa-tab-panel:not([data-leaving]) .view-header-title')).toHaveText(label);
          await expect(active.locator('[data-dock-group]')).toBeFocused();
          await expect(active.locator('.pwa-dock__surface')).toHaveCSS('height', '60px');
        }
        // Reopening during the shrink uses the updated destinations immediately.
        await active.locator('[data-dock-group]').press('ArrowDown');
        await page.getByRole('dialog', { name: 'More views' }).getByRole('button', { name: 'Reading', exact: true }).click();
        await active.locator('[data-dock-group]').dispatchEvent('keydown', { key: 'ArrowDown', bubbles: true });
        const reopened = active.getByRole('dialog', { name: 'More views' });
        await expect(reopened.getByRole('button')).toHaveText(['Favorites', 'Archive', 'Highlights']);
        await reopened.getByRole('button', { name: 'Highlights', exact: true }).click();
        await expect(active.locator('.pwa-tab-panel:not([data-leaving])').getByRole('heading', { name: 'Highlights', exact: true })).toBeVisible();
        await expect(active.locator('.pwa-dock__surface')).toHaveCSS('height', '60px');
        await active.getByRole('button', { name: 'Inbox', exact: true }).click();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        // Applying reduced motion can complete the feature switch and restore
        // focus to Inbox. Wait for that handoff before focusing the menu trigger.
        await expect(workspace).toHaveAttribute('data-reduced-motion', 'true');
        await expect(active).toHaveAttribute('data-entering', 'false');
        await active.locator('[data-dock-group]').press('ArrowDown');
        await page.getByRole('dialog', { name: 'More views' }).getByRole('button', { name: 'Favorites', exact: true }).click();
        await expect(active.locator('.pwa-tab-panel:not([data-leaving]) .view-header-title')).toHaveText('Favorites');
        await expect(page.getByRole('dialog', { name: 'More views' })).toHaveCount(0);
        for (const surface of await workspace.locator('.pwa-dock__surface').all()) await expect(surface).toHaveCSS('height', '60px');
      });
      test(`plugin dock highlight takes one continuous path at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.clock.install({ time: new Date('2026-09-26T12:00:00Z') });
        await page.goto(`/?host=plugin&scene=navigation&theme=${width === 320 ? 'light' : 'dark'}`);
        const workspace = page.locator('.plugin-workspace-navigation');
        const active = workspace.locator('.plugin-workspace-panel[data-active="true"]');
        await active.getByRole('button', { name: 'Projects', exact: true }).click();
        await expect.poll(() => active.locator('.pwa-dock__indicator').evaluate(indicator => new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width)).toBeCloseTo(2, 2);
        // Motion springs run on rAF. Advance their real frame loop explicitly so
        // a busy CI runner cannot skip the entire movement between observations.
        await page.clock.pauseAt(new Date('2026-09-26T12:01:00Z'));
        const sampler = await workspace.evaluateHandle(root => {
          const position = (indicator: Element) => new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width;
          return {
            select: (label: string) => {
              const before = position(root.querySelector('.plugin-workspace-panel[data-active="true"] .pwa-dock__indicator')!);
              const button = root.querySelector<HTMLElement>(`.plugin-workspace-panel[data-active="true"] .pwa-dock [aria-label="${label}"]`)!;
              button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
              button.click();
              return before;
            },
            sample: () => Array.from(root.querySelectorAll('.plugin-workspace-panel .pwa-dock__indicator')).map(position),
          };
        });
        const advance = async (duration: number) => {
          const positions: number[][] = [];
          for (let time = 0; time < duration; time += 16) {
            await page.clock.runFor(Math.min(16, duration - time));
            positions.push(await sampler.evaluate(sampler => sampler.sample()));
          }
          return positions;
        };
        // Include Reading's first mount, switches to remembered tabs, and local changes.
        for (const [label, index] of [['Reading', 3], ['Inbox', 0], ['Projects', 2], ['Reminders', 1], ['Reading', 3], ['Projects', 2], ['Reading', 3]] as const) {
          const before = await sampler.evaluate((sampler, label) => sampler.select(label), label);
          const frames = { before, positions: await advance(480) };
          expect(frames.positions.length).toBeGreaterThan(1);
          expect(frames.positions.every(pair => pair.length === 2 && Math.abs(pair[0]! - pair[1]!) < .03), `${label} must share one painted highlight: ${JSON.stringify(frames.positions)}`).toBe(true);
          const low = Math.min(frames.before, index), high = Math.max(frames.before, index);
          expect(frames.positions.every(pair => pair.every(position => position >= low - .01 && position <= high + .01))).toBe(true);
          expect(frames.positions.some(pair => pair.every(position => position > low + .05 && position < high - .05)), `${label} must visibly slide`).toBe(true);
          await expect.poll(() => workspace.locator('.pwa-dock__indicator').evaluateAll((indicators, index) => indicators.every(indicator => Math.abs(new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width - index) < .005), index)).toBe(true);
        }
        const reversed: number[][] = [];
        for (const label of ['Inbox', 'Projects', 'Reminders', 'Reading', 'Inbox']) {
          await sampler.evaluate((sampler, label) => sampler.select(label), label);
          reversed.push(...await advance(45));
        }
        reversed.push(...await advance(480));
        await sampler.dispose();
        await page.clock.resume();
        expect(reversed.every(pair => Math.abs(pair[0]! - pair[1]!) < .03), `Reversals must share one painted highlight: ${JSON.stringify(reversed)}`).toBe(true);
        await expect.poll(() => workspace.locator('.pwa-dock__indicator').evaluateAll(indicators => indicators.every(indicator => Math.abs(new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width) < .005))).toBe(true);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await active.getByRole('button', { name: 'Reading', exact: true }).click();
        await expect.poll(() => workspace.locator('.pwa-dock__indicator').evaluateAll(indicators => indicators.every(indicator => Math.abs(new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width - 3) < .01 && indicator.getAnimations().length === 0))).toBe(true);
      });
      test(`plugin discards an unfinished tab fade when returning to the same destination at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto('/?host=plugin&scene=navigation&theme=light');
        const workspace = page.locator('.plugin-workspace-navigation');
        const frames = await workspace.evaluate(async root => {
          const select = (label: string) => {
            const button = root.querySelector<HTMLElement>(`.plugin-workspace-panel[data-active="true"] .pwa-dock [aria-label="${label}"]`)!;
            button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
            button.click();
          };
          const views = () => Array.from(root.querySelectorAll<HTMLElement>('.plugin-workspace-panel[data-active="true"] .pwa-navigation-viewport > .pwa-tab-transition > .pwa-tab-panel')).map(panel => panel.dataset.tabView!);
          select('Reminders');
          await new Promise(requestAnimationFrame);
          const departing = views();
          select('Reading');
          await new Promise(requestAnimationFrame);
          select('Reminders');
          await new Promise(requestAnimationFrame);
          return { departing, returned: views() };
        });
        expect(frames.departing).toContain('inbox');
        expect(frames.departing).toContain('today');
        expect(frames.returned).toEqual(['today']);
      });
      test(`plugin prepares every dock destination during feature switches at ${width}px`, async ({ page }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(`/?host=plugin&scene=navigation&theme=${width === 320 ? 'dark' : 'light'}`);
        const workspace = page.locator('.plugin-workspace-navigation');
        const active = workspace.locator('.plugin-workspace-panel[data-active="true"]');
        const panels = active.locator('.pwa-navigation-viewport > .pwa-tab-transition > .pwa-tab-panel:not([data-leaving]), .crate-reading__library > .pwa-tab-transition > .pwa-tab-panel:not([data-leaving])');
        const reminders = [{ label: 'Inbox', key: 'inbox' }, { label: 'Reminders', key: 'today' }, { label: 'Projects', key: 'browse' }];
        const reading = [{ label: 'Reading', key: 'inbox' }, { label: 'Favorites', key: 'favorites' }, { label: 'Archive', key: 'archived' }, { label: 'Highlights', key: 'highlights' }];
        for (const destination of reading) {
          if (destination.label === 'Reading') await active.getByRole('button', { name: destination.label, exact: true }).click();
          else {
            await active.locator('[data-dock-group]').press('ArrowDown');
            await page.getByRole('dialog', { name: 'More views' }).getByRole('button', { name: destination.label, exact: true }).click();
          }
          await expect(panels).toHaveCount(1);
          await expect(panels).toHaveAttribute('data-tab-view', destination.key);
          for (const [index, target] of reminders.entries()) {
            await active.getByRole('button', { name: reminders[(index + 1) % reminders.length]!.label, exact: true }).click();
            await expect(panels).toHaveCount(1);
            for (const delay of [240, 35]) {
              const frames = await workspace.evaluate(async (root, { reading, target, delay }) => {
                const select = (name: string) => {
                  const button = root.querySelector<HTMLElement>(`.plugin-workspace-panel[data-active="true"] .pwa-dock [aria-label="${name}"]`)!;
                  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
                  button.click();
                };
                select(reading.label);
                await new Promise(requestAnimationFrame);
                const readingViews = Array.from(root.querySelectorAll<HTMLElement>('.plugin-workspace-panel[data-active="true"] .pwa-tab-panel')).map(panel => panel.dataset.tabView!);
                if (!root.querySelector('.plugin-workspace-panel[data-active="true"] .crate-reading')) throw new Error(`${reading.label} did not open`);
                await new Promise(resolve => setTimeout(resolve, delay));
                select(target.label);
                const frames: string[][] = [], start = performance.now();
                while (performance.now() - start < 220 || frames.length < 2) {
                  await new Promise(requestAnimationFrame);
                  frames.push(Array.from(root.querySelectorAll<HTMLElement>('.plugin-workspace-panel[data-active="true"] .pwa-navigation-viewport > .pwa-tab-transition > .pwa-tab-panel')).map(panel => panel.dataset.tabView!));
                }
                return { readingViews, frames };
              }, { reading: destination, target, delay });
              expect(frames.readingViews).toEqual([destination.key]);
              expect(frames.frames.length).toBeGreaterThan(1);
              expect(frames.frames.every(frame => frame.length === 1 && frame[0] === target.key), `${destination.label} → ${target.label} after ${delay}ms: ${JSON.stringify(frames.frames)}`).toBe(true);
            }
          }
        }
      });
      test(`plugin reveals Inbox directly when returning from Reading at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(`/?host=plugin&scene=navigation&theme=${width === 320 ? 'light' : 'dark'}`);
        const workspace = page.locator('.plugin-workspace-navigation');
        const active = workspace.locator('.plugin-workspace-panel[data-active="true"]');
        const panels = active.locator('.pwa-navigation-viewport > .pwa-tab-transition > .pwa-tab-panel');
        // Exercise both a settled feature switch and a reversal during its fade.
        for (const readingTime of [240, 35]) {
          await active.getByRole('button', { name: 'Projects', exact: true }).click();
          await expect(panels).toHaveCount(1);
          await expect(panels).toHaveAttribute('data-tab-view', 'browse');
          const frames = await workspace.evaluate(async (root, delay) => {
            const select = (name: string) => {
              const button = root.querySelector<HTMLElement>(`.plugin-workspace-panel[data-active="true"] .pwa-dock [aria-label="${name}"]`)!;
              button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
              button.click();
            };
            select('Reading');
            await new Promise(resolve => setTimeout(resolve, delay));
            if (!root.querySelector('.plugin-workspace-panel[data-active="true"] .crate-reading')) throw new Error('Reading did not open before returning to Inbox');
            select('Inbox');
            const frames: string[][] = [], start = performance.now();
            while (performance.now() - start < 240) {
              await new Promise(requestAnimationFrame);
              frames.push(Array.from(root.querySelectorAll<HTMLElement>('.plugin-workspace-panel[data-active="true"] .pwa-navigation-viewport > .pwa-tab-transition > .pwa-tab-panel'))
                .map(panel => panel.dataset.tabView!));
            }
            return frames;
          }, readingTime);
          expect(frames.length).toBeGreaterThan(1);
          expect(frames.every(frame => frame.length === 1 && frame[0] === 'inbox'), `Reading return after ${readingTime}ms: ${JSON.stringify(frames)}`).toBe(true);
          await expect(active.getByRole('button', { name: 'Inbox', exact: true })).toBeFocused();
        }
        // Ordinary reminder tab changes still use their own dissolve.
        const leaving = await workspace.evaluate(async root => {
          root.querySelector<HTMLElement>('.plugin-workspace-panel[data-active="true"] .pwa-dock [aria-label="Projects"]')!.click();
          await new Promise(requestAnimationFrame);
          const panel = root.querySelector<HTMLElement>('.pwa-tab-panel[data-tab-view="inbox"]')!;
          return { inert: panel.inert, opacity: Number(getComputedStyle(panel).opacity) };
        });
        expect(leaving.inert).toBe(true);
        expect(leaving.opacity).toBeGreaterThan(0);
        await expect(panels).toHaveCount(1);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await active.getByRole('button', { name: 'Reading', exact: true }).click();
        await active.getByRole('button', { name: 'Inbox', exact: true }).click();
        await expect(panels).toHaveCount(1);
        await expect(panels).toHaveAttribute('data-tab-view', 'inbox');
        await expect(active).toHaveCSS('opacity', '1');
      });
      test(`plugin preserves a tab fade during repeated feature returns at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(`/?host=plugin&scene=navigation&theme=${width === 320 ? 'light' : 'dark'}`);
        const workspace = page.locator('.plugin-workspace-navigation');
        const active = workspace.locator('.plugin-workspace-panel[data-active="true"]');
        for (let iteration = 0; iteration < 3; iteration++) {
          await active.getByRole('button', { name: 'Reading', exact: true }).click();
          await expect(active).toHaveAttribute('data-entering', 'false');
          const fade = await workspace.evaluate(async root => {
            const select = (label: string) => {
              const button = root.querySelector<HTMLElement>(`.plugin-workspace-panel[data-active="true"] .pwa-dock [aria-label="${label}"]`)!;
              button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
              button.click();
            };
            select('Inbox');
            await Promise.resolve();
            const front = root.querySelector('.plugin-workspace-panel[data-front="true"]')!;
            const outer = front.getAnimations().find(animation => (animation as CSSTransition).transitionProperty === 'opacity');
            if (!outer) throw new Error('Expected a feature return fade');
            outer.pause(); outer.currentTime = 60;
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            const panel = root.querySelector<HTMLElement>('.plugin-workspace-panel[data-active="true"]')!;
            const container = panel.querySelector('.pwa-navigation-viewport > .pwa-tab-transition')!;
            const outgoing = container.querySelector<HTMLElement>(':scope > .pwa-tab-panel:not([data-leaving])')!;
            const entering = panel.dataset.entering;
            select('Projects');
            await Promise.resolve();
            const local = outgoing.getAnimations().find(animation => (animation as CSSTransition).transitionProperty === 'opacity');
            if (local) { local.pause(); local.currentTime = 60; }
            const result = { entering, retained: outgoing.isConnected, inert: outgoing.inert,
              opacity: outgoing.isConnected ? Number(getComputedStyle(outgoing).opacity) : 0,
              opaque: Array.from(container.children).some(layer => getComputedStyle(layer).opacity === '1'),
              active: container.querySelector<HTMLElement>(':scope > .pwa-tab-panel:not([data-leaving])')?.dataset.tabView };
            local?.finish(); outer.finish();
            return result;
          });
          expect(fade.entering).toBe('true');
          expect(fade.retained && fade.inert && fade.opaque, JSON.stringify(fade)).toBe(true);
          expect(fade.opacity).toBeGreaterThan(0);
          expect(fade.opacity).toBeLessThan(1);
          expect(fade.active).toBe('browse');
          await expect(active).toHaveAttribute('data-entering', 'false');
          await expect(workspace.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
          await expect(active.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
        }
      });
      test(`plugin dock, date views, feature retention and project Back at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/?host=plugin&scene=navigation&theme=light');
        const active = page.locator('.plugin-workspace-panel[data-active="true"]');
        await active.getByRole('button', { name: 'Crate settings', exact: true }).click();
        await expect(page.getByTestId('result')).toHaveText('settings');
        await active.getByRole('button', { name: 'Reminders', exact: true }).click();
        await expect(active.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await active.getByRole('button', { name: 'Upcoming', exact: true }).click();
        await expect(active.getByRole('button', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(active.getByRole('button', { name: 'Reminders', exact: true })).toHaveAttribute('aria-current', 'page');
        await active.getByRole('button', { name: 'Projects', exact: true }).click();
        const project = active.locator('[data-action="open-project"]').last();
        await project.scrollIntoViewIfNeeded();
        const scroller = active.locator('.pwa-navigation-viewport .reminders-view-scroll');
        const scroll = await scroller.evaluate(el => el.scrollTop);
        const title = await project.getAttribute('data-project');
        await project.click();
        await expect(active.locator('.pwa-navigation-viewport')).toHaveAttribute('inert', '');
        await active.getByRole('button', { name: 'Add reminder', exact: true }).click();
        await expect(page.getByTestId('result')).toHaveText(title!);
        await active.getByRole('button', { name: 'Back to projects', exact: true }).click();
        await expect(active.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'false');
        expect(await scroller.evaluate(el => el.scrollTop)).toBe(scroll);
        await expect(project).toBeFocused();
        await active.getByRole('button', { name: 'Reading', exact: true }).click();
        const search = active.getByRole('searchbox', { name: 'Search reading' });
        await search.fill('pleasure');
        await active.getByRole('button', { name: 'Inbox', exact: true }).click();
        await active.getByRole('button', { name: 'Reading', exact: true }).click();
        await expect(search).toHaveValue('pleasure');
        await active.locator('.crate-reading__open').first().click();
        await expect(active.locator('.crate-reading__reader-pane')).toBeVisible();
        await active.getByRole('button', { name: 'Back to reading', exact: true }).click();
        await expect(search).toHaveValue('pleasure');

        const dock = active.locator('.pwa-dock');
        const bounds = await dock.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(801);
      });
    }
    test('dock picker supports keyboard selection, dismissal and disabled features', async ({ page }) => {
      await page.goto('/?host=plugin&scene=navigation&theme=dark');
      const active = page.locator('.plugin-workspace-panel[data-active="true"]');
      await active.locator('[data-dock-group]').press('ArrowDown');
      await expect(page.getByRole('dialog', { name: 'More views' })).toBeVisible();
      await page.getByRole('button', { name: 'Favorites', exact: true }).click();
      await expect(active.locator('.pwa-tab-panel:not([data-leaving]) .view-header-title')).toHaveText('Favorites');
      await active.locator('[data-dock-group]').press('ArrowDown');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'More views' })).toBeHidden();
      await expect(active.locator('[data-dock-group]')).toBeFocused();
      await page.evaluate(() => window.dispatchEvent(new Event('disable-reading')));
      await expect(active.locator('.plugin-reminders-navigation')).toBeVisible();
      await expect(active.getByRole('button', { name: 'Favorites', exact: true })).toHaveCount(0);
    });
    test('compact project sheet retains header, Back and local create action', async ({ page }) => {
      await page.goto('/?host=plugin&scene=navigation&compact&theme=dark');
      await expect(page.locator('.crate-modal-header')).toBeVisible();
      await page.getByRole('button', { name: 'Crate settings', exact: true }).click();
      await expect(page.getByTestId('result')).toHaveText('settings');
      await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
      await expect(page.getByTestId('result')).toHaveText('Project 01');
      await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
      await expect(page.locator('[data-action="open-project"]').first()).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    });
    test('held dock selection and rapid navigation settle with reduced motion changes', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto('/?host=plugin&scene=navigation&theme=dark');
      const active = page.locator('.plugin-workspace-panel[data-active="true"]');
      const group = active.locator('[data-dock-group]');
      const bounds = await group.boundingBox();
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
      await page.mouse.down();
      const favorite = page.getByRole('dialog', { name: 'More views' }).getByRole('button', { name: 'Favorites', exact: true });
      await expect(favorite).toBeVisible();
      const target = await favorite.boundingBox();
      await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(active.locator('.pwa-tab-panel:not([data-leaving]) .view-header-title')).toHaveText('Favorites');
      for (let index = 0; index < 3; index++) {
        await active.getByRole('button', { name: 'Reminders', exact: true }).click();
        await active.getByRole('button', { name: 'Upcoming', exact: true }).click();
        await active.getByRole('button', { name: 'Today', exact: true }).click();
        await active.getByRole('button', { name: 'Favorites', exact: true }).click();
      }
      await page.evaluate(() => document.body.classList.add('reduce-motion'));
      await active.getByRole('button', { name: 'Projects', exact: true }).click();
      await active.locator('[data-action="open-project"]').first().click();
      await expect(active.locator('.pwa-navigation-screen')).toHaveCSS('transform', 'none');
      await active.getByRole('button', { name: 'Back to projects', exact: true }).click();
      await expect(active.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'false');
      await expect(active.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
    });

}
