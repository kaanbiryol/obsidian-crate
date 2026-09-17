import assert from 'node:assert/strict';
import { swipe } from './browser-touch-swipe.mjs';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

const css = compileString('@use "src/styles/plugin-ui/modal"; .crate-reminders-ui { @include modal.styles; }', { loadPaths: [process.cwd()] }).css + `
  .base-modal-container { inset: 0; display:flex; align-items:center; justify-content:center; }
  .base-modal-backdrop { position:absolute; inset:0; }
  .base-modal-surface { background:white; color:black; width:min(560px,100%); padding:16px; max-height:85dvh; }
  .base-modal-viewport { align-items:center; }
  .reminder-modal-header {display:flex;justify-content:space-between} button {min-height:36px}
  [contenteditable] {min-height:48px} .reminder-picker-scroll {max-height:400px}
  .recurrence-frequency-tabs {display:flex} .project-picker-row {display:flex;width:100%}
  .base-modal-drag-region {height:24px;flex-shrink:0}
  [hidden] {display:none!important}
`;
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Button } from './src/ui/shared/Button';
    import { AddReminderModal } from './src/reminders/ui/reminder-modal/AddReminderModal';
    import { BaseUiModal } from './src/ui/shared/BaseUiModal';
    import { BaseModal } from './src/reminders/components/BaseModal';
    import { ActivityTabs } from './src/ui/activity/ActivityTabs';
    import { ActivitySheet } from './src/ui/activity/ActivitySheet';
    import { ExclusionSheet } from './src/ui/ExclusionSheet';
    class HostShell extends BaseUiModal {}
    const hostShell = new HostShell({}); hostShell.open();
    const shadow = document.getElementById('host').attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)};
    const mount = document.createElement('div'); mount.className = 'crate-reminders-ui'; shadow.append(style, mount);
    const reminder = {id:'one',content:'Keep this draft',description:'Existing description',project:'Inbox',priority:4,completed:false};
    function Harness() {
      const [open,setOpen] = useState(null);
      const [mode,setMode] = useState('centered');
      return <>
        <Button onClick={() => {setMode('centered');setOpen('editor')}}>Desktop editor</Button>
        <Button onClick={() => {setMode('bottom-sheet');setOpen('editor')}}>Mobile editor</Button>
        <Button onClick={() => setOpen('activity')}>Activity</Button>
        <Button onClick={() => setOpen('tabs')}>Activity tabs</Button>
        <Button onClick={() => setOpen('exclusion')}>Exclusions</Button>
        {open === 'editor' && <AddReminderModal reminder={reminder} projects={['Inbox','Work','Personal']}
          variant={mode} pickerMode={mode==='centered'?'overlay':'replace'}
          onClose={() => setOpen(null)}
          onSave={() => new Promise(resolve => {window.finishSave=resolve})}
          onDelete={() => new Promise(resolve => {window.finishDelete=resolve})} />}
        {open === 'tabs' && <BaseModal variant='centered' onClose={() => setOpen(null)} ariaLabel='Tabs test'>
          <ActivityTabs initialTab='pending' onTabChange={index => {window.tabIndex=index}} onMount={elements => {
            elements.pending.textContent='Pending files'; elements.conflicts.textContent='Conflicting files'; elements.history.textContent='Sync history';
          }} />
        </BaseModal>}
        {open === 'activity' && <ActivitySheet isMobile={false} onClose={() => setOpen(null)} onMount={el => {el.textContent='Mounted activity';}} />}
        {open === 'exclusion' && <ExclusionSheet onClose={() => setOpen(null)} onMount={el => {el.textContent='Mounted exclusions';}} />}
      </>;
    }
    const root = createRoot(mount); root.render(<Harness />);
    window.unmount = () => {root.unmount();hostShell.close()};
  ` },
  plugins: [{ name:'obsidian', setup(builder) {
    builder.onResolve({filter:/^obsidian$/}, () => ({path:'obsidian',namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'}, () => ({contents:`
      export function setIcon() {} export function getIcon() { return null; }
      export class Scope { handlers=[]; register(modifiers,key,fn) {this.handlers.push({key,fn});} }
      export class Modal {
        constructor() {this.scope=new Scope();this.scope.register([],'Escape',event=>{event.preventDefault();this.close()});}
        open() {window.nativeCloses=0;this.handler=event=>{for(const item of this.scope.handlers) if(item.key===event.key) item.fn(event)};window.addEventListener('keydown',this.handler,true);}
        close() {window.nativeCloses++;window.removeEventListener('keydown',this.handler,true);}
      }
    `}));
  }}],
  bundle:true,write:false,format:'iife',platform:'browser',loader:{'.scss':'empty'},
  define:{'process.env.NODE_ENV':'"production"'},
});

for (const browserType of [chromium, webkit]) {
 const browser = await browserType.launch();
 try {
  const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="host" class="modal-container"></div>');
  await page.addScriptTag({content:outputFiles[0].text});
  for (const mode of ['Desktop','Mobile']) {
    const trigger=page.getByRole('button',{name:`${mode} editor`,exact:true});
    await trigger.click();
    const editor=page.getByRole('dialog',{name:'Edit reminder',exact:true});
    const title=page.getByRole('textbox',{name:'Reminder title',exact:true});
    await expect(editor).toBeVisible(); await expect(title).toBeFocused();
    // Native Obsidian menus and confirmation dialogs live outside React's portal tree.
    for (const className of ['menu','modal-container']) {
      await page.evaluate(className => {
        const overlay=document.createElement('div');overlay.id='native-overlay';overlay.className=className;
        const button=document.createElement('button');button.textContent='Native action';overlay.append(button);
        document.body.append(overlay);button.focus();
      }, className);
      await expect(page.getByRole('button',{name:'Native action',exact:true})).toBeFocused();
      await page.evaluate(() => document.querySelector('#native-overlay').remove());
      await title.focus(); await expect(title).toBeFocused();
    }
    await title.click();
    await title.press('ControlOrMeta+A');
    await title.pressSequentially('Draft survives pickers');
    await expect(title).toHaveText('Draft survives pickers');
    await page.locator('[data-picker="project"]').click();
    const project=page.getByRole('dialog',{name:'Select project',exact:true});
    await expect(project).toBeVisible();
    await page.getByRole('option',{name:'Work',exact:true}).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option',{name:'Personal',exact:true})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(project).toHaveCount(0);
    await expect(title).toHaveText('Draft survives pickers #Personal ');
    await expect(title).toBeFocused();
    await page.locator('[data-picker="recurrence"]').click();
    await page.getByRole('tab',{name:'Weekly',exact:true}).click();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab',{name:'Monthly',exact:true})).toHaveAttribute('aria-selected','true');
    await page.keyboard.press('Escape');
    await expect(title).toBeFocused();
    await page.getByRole('button',{name:'Delete reminder',exact:true}).click();
    const confirmation=page.getByRole('alertdialog');
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
    for(let step=0;step<8;step++) {
      await page.keyboard.press('Tab');
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.ok(await confirmation.evaluate(el => el.contains(el.getRootNode().activeElement)));
    }
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0); await expect(editor).toBeVisible();
    await page.getByRole('button',{name:'Save reminder',exact:true}).click();
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    if(mode==='Mobile') {
      await swipe(page, editor.locator('.base-modal-drag-region'));
      await expect(editor).toBeVisible();
    }
    assert.equal(await page.evaluate(() => window.nativeCloses),0);
    await page.evaluate(() => window.finishSave());
    await expect(editor).toHaveCount(0); await expect(trigger).toBeFocused();
  }
  await page.getByRole('button',{name:'Activity tabs',exact:true}).click();
  await expect(page.getByRole('tabpanel')).toHaveText('Pending files');
  await page.getByRole('tab',{name:'Pending',exact:true}).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab',{name:'History',exact:true})).toBeFocused();
  await expect(page.getByRole('tabpanel',{name:'History',exact:true})).toHaveText('Sync history');
  await expect(page.getByRole('tabpanel',{name:'Pending',exact:true})).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Activity',exact:true}).click();
  await expect(page.getByText('Mounted activity',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close sync activity'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Exclusions',exact:true}).click();
  await expect(page.getByText('Mounted exclusions',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Mobile editor',exact:true}).click();
  const mobileEditor=page.getByRole('dialog',{name:'Edit reminder',exact:true});
  await expect(mobileEditor).toHaveCSS('transform','none');
  const title=page.getByRole('textbox',{name:'Reminder title',exact:true});
  await swipe(page,title,40);
  await expect(mobileEditor).toBeVisible();
  await page.evaluate(() => document.getSelection()?.collapseToEnd());
  await swipe(page,mobileEditor.locator('.base-modal-drag-region'),16,400);
  await expect(mobileEditor).toHaveCSS('transform','none');
  await swipe(page,mobileEditor.locator('.base-modal-drag-region'));
  await expect(mobileEditor).toHaveCount(0);
  await page.getByRole('button',{name:'Mobile editor',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('button',{name:'Mobile editor',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Mobile editor',exact:true}).click();
  await page.evaluate(() => window.unmount());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.deepEqual(errors,[]);
  console.log(`${browserType.name()}: plugin Base UI nested dialogs/drawers, pickers, focus, pending saves, imperative mounts and cleanup passed`);
 } finally { await browser.close(); }
}
