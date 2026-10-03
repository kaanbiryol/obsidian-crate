import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { obsidianDomHelpers, obsidianDialogModule, hostStyles } from './obsidian-dialog-fixture.mjs';

// Exercise production modal shells and dialog controls against native host CSS.
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { Setting } from 'obsidian';
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DeleteConfirmationModal } from './src/reminders/components/DeleteConfirmationModal';
    import { SharedModal } from './src/ui/shared/SharedModal';
    import { createSettingsDisclosure } from './src/ui/shared/settings-disclosure';
    import { openConfirmationModal } from './src/ui/confirmation-modal';
    import { PendingDiscardModal } from './src/ui/activity/pending-discard-modal';
    import { SyncDiagnosticsModal } from './src/ui/sync-diagnostics-modal';
    import { QRModal } from './src/ui/qr-modal';
    import { openExternalBrowserModal } from './src/ui/external-browser-modal';
    import { openCloudflareAuthorizationModal } from './src/ui/cloudflare-authorization-modal';
    import { openCloudflareDeploymentModal } from './src/ui/cloudflare-deployment-modal';
    import { selectCloudflareServer } from './src/ui/cloudflare-server-picker-modal';
    import { EncryptionResetModal } from './src/ui/settings/encryption-reset-modal';
    import { renderEncryptionManagement } from './src/ui/settings/encryption-manage-ui';
    import { WebAppPairingModal } from './src/ui/settings/web-app-pairing-modal';
    ${obsidianDomHelpers}
    const row = container => new Setting(container).setName('Recovery key').setDesc('Keep a copy for recovery.').addButton(button => button.setButtonText('Copy'));
    class RowDialog extends SharedModal {
      onOpen() {
        this.openLayout('Dialog controls');
        this.bodyEl.createEl('p', {text:'Manage this device.'});
        row(this.bodyEl);
        const content=createSettingsDisclosure(this.bodyEl,'Advanced',{summary:'Recovery options'});
        row(content);
        new Setting(content).setName('Server address').setDesc('An address with a long description that must wrap inside a narrow dialog.').addText(text=>text.setPlaceholder('https://crate.example'));
      }
    }
    class Management extends SharedModal {
      onOpen() {
        this.modalEl.addClass('crate-encryption-modal'); this.openLayout('Manage encryption');
        this.dispose = renderEncryptionManagement(this.bodyEl, {copyRecovery:async()=>{}, connectApp:()=>{}, turnOff:()=>{},
          advanced:container => {row(createSettingsDisclosure(container,'Check recovery key',{inline:true})); return ()=>{};}});
      }
      onClose() { this.dispose(); super.onClose(); }
    }
    window.mount = scene => {
      if (window.currentModal) { window.currentModal.dismiss?.(); window.currentModal.close(); window.currentModal = null; }
      window.reactRoot?.unmount(); window.reactRoot = null;
      document.body.replaceChildren();
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copied=value;}}});
      const url='https://crate.example/setup?token=fixture';
      if (scene==='delete') {
        window.deleteClosed=false; window.deleteConfirmed=false;
        const host=document.body.createDiv().attachShadow({mode:'open'});
        const styles=document.createElement('style');styles.textContent=window.pluginCss;host.append(styles);
        const mount=document.createElement('div');mount.className='crate-reminders-ui';host.append(mount);
        window.reactRoot=createRoot(mount);
        window.setDeleteBusy=busy=>window.reactRoot.render(createElement(DeleteConfirmationModal,{isOpen:true,isLoading:busy,onClose:()=>{window.deleteClosed=true;},onConfirm:()=>{window.deleteConfirmed=true;}}));
        window.setDeleteBusy(false);
      } else if (scene==='rows') new RowDialog({}).open();
      else if(scene==='management') new Management({}).open();
      else if(scene==='confirmation') void openConfirmationModal({}, {title:'Disconnect this device',message:'Stop syncing this device?',details:['Other devices stay connected.'],confirmText:'Disconnect',warning:true,checkbox:{label:'Also forget the saved server connection',onChange:()=>{}}});
      else if(scene==='discard') new PendingDiscardModal({},async()=>({items:[{path:'Notes/Review.md',action:'restore'}],unchangedCount:0,discard:async()=>{window.discarded=true;}}),()=>{},['Notes/Review.md']).open();
      else if(scene==='diagnostics') new SyncDiagnosticsModal({},'Fixture sync report\\n'.repeat(30)).open();
      else if(scene==='qr') new QRModal({},url).open();
      else if(scene==='external') openExternalBrowserModal({},url,{title:'Open Crate',message:'Open the web app in your browser.',linkText:'Open app',showCopyableUrl:true});
      else if(scene==='authorization') openCloudflareAuthorizationModal({},url,new AbortController().signal);
      else if(scene==='deployment') { const modal=openCloudflareDeploymentModal({}); modal.fail('Server update needs attention','Check your connection and try again.',[],{technicalDetails:'The connection was interrupted.',action:{label:'Try again',onClick:()=>{}}}); }
      else if(scene==='server') void selectCloudflareServer({},[{metadata:{workerName:'crate-fixture',vaultName:'Personal vault'},modifiedOn:'2026-10-01T12:00:00Z'}]);
      else if(scene==='pairing') new WebAppPairingModal({app:{}}).open();
      else if(scene==='reset') new EncryptionResetModal({app:{},settings:{workerUrl:url},secretStorage:{get:()=>null}},null).open();
    };
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.scss': 'empty' },
  plugins: [{ name: 'obsidian-host', setup(builder) {
    builder.onResolve({ filter: /(^obsidian$|plugin\/web-app-pairing$)/ }, args => ({ path: args.path, namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents: args.path==='obsidian' ? obsidianDialogModule : 'export function openWebAppPairing(){return new Promise(()=>{});}' }));
  } }],
});
const css = await readFile(process.env.CRATE_PLUGIN_CSS_PATH ?? 'dist/styles.css','utf8');
const obsidianCss = process.env.CRATE_OBSIDIAN_CSS_PATH ? await readFile(process.env.CRATE_OBSIDIAN_CSS_PATH,'utf8') : '';
const output = '.generated/plugin-dialog-review';
const hostName = obsidianCss ? 'obsidian-' : '';
await mkdir(output,{recursive:true});
const scenes=['confirmation','diagnostics','qr','external','authorization','deployment','server','pairing','reset','management','discard','delete'];
for (const browserType of [chromium,webkit]) {
  const browser = await browserType.launch();
  try {
    for (const [width,height] of [[1100,900],[390,844],[320,568],[900,320]]) for (const theme of ['light','dark']) {
      const page = await browser.newPage({viewport:{width,height},hasTouch:width<700,reducedMotion:'reduce'});
      const errors=[]; page.on('pageerror',error=>errors.push(error.message));
      await page.route('https://dialog-ui.test/**',route=>route.fulfill({contentType:'text/html',body:`<html class="theme-${theme}"><head><style>${hostStyles}</style><style>${obsidianCss}</style><style>${css}</style></head><body class="theme-${theme} ${width<700?'is-mobile is-phone':''}"></body></html>`}));
      await page.goto('https://dialog-ui.test/');
      await page.evaluate(css=>{window.pluginCss=css;},css);
      await page.addScriptTag({content:outputFiles[0].text});
      await page.evaluate(()=>window.mount('rows'));
      const rowMetrics = locator => locator.evaluate(el=>{
        const style=getComputedStyle(el), name=getComputedStyle(el.querySelector('.setting-item-name')), desc=getComputedStyle(el.querySelector('.setting-item-description')), button=getComputedStyle(el.querySelector('button'));
        return {padding:style.padding,gap:style.gap,nameSize:name.fontSize,descriptionSize:desc.fontSize,descriptionLeading:desc.lineHeight,buttonHeight:button.minHeight,buttonSize:button.fontSize,buttonRadius:button.borderRadius,buttonPadding:button.padding};
      });
      const expectedRow=await rowMetrics(page.locator('.crate-modal-body > .setting-item'));
      await page.locator('summary').click();
      await page.locator('.crate-modal-body input').scrollIntoViewIfNeeded();
      await expect(page.locator('.crate-modal-body input')).toBeInViewport();
      if(width<700) await expect(page.locator('.setting-item').filter({has:page.locator('input')})).toHaveCSS('flex-wrap','wrap');
      for (const scene of scenes) {
        await page.evaluate(scene=>window.mount(scene),scene);
        const modal=page.getByRole(scene==='delete'?'alertdialog':'dialog');
        const header=modal.locator('.reminder-modal-header');
        await expect(header).toBeVisible();
        if(width<700) assert.ok((await header.getByRole('button').first().boundingBox()).height>=44,'Header close has a touch target');
        const label=`${browserType.name()} ${width}x${height} ${theme} ${scene}`;
        await expect(header).toHaveCSS('padding',width<=640?'4px 12px':'4px 10px');
        await expect(modal.locator('.crate-modal-body')).toHaveCSS('padding','16px');
        const bounds=await modal.boundingBox();
        assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=width+1 && bounds.y+bounds.height<=height+1,`${label}: modal fits the viewport`);
        assert.equal(await modal.evaluate(el=>[el,...el.querySelectorAll('.modal-content,.crate-modal-body,.setting-item,.crate-modal-footer')].some(node=>node.scrollWidth>node.clientWidth+1)),false,`${label}: no horizontal overflow`);
        if(await modal.locator('.crate-modal-footer').count()) {
          const footer=modal.locator('.crate-modal-footer');
          await expect(footer,`${label}: footer stays visible`).toBeInViewport({ratio:0.98});
          const footerBounds=await footer.boundingBox();
          assert.ok(footerBounds.y+footerBounds.height<=bounds.y+bounds.height+1,`${label}: footer fits inside the modal`);
          await expect(footer).toHaveCSS('padding','12px 16px');
          for(const button of await footer.locator('button').all()) {
            await expect(button).toBeInViewport({ratio:1});
            if(width<700) assert.ok((await button.boundingBox()).height>=44,`${label}: touch target`);
          }
        }
        if(scene==='management') {
          const row=modal.locator('.setting-item').filter({has:page.locator('.setting-item-name',{hasText:'Recovery key'})}).first();
          assert.deepEqual(await rowMetrics(row),expectedRow,`${label}: dialog rows match exactly`);
          const advanced=modal.locator('.crate-encryption-manage__advanced');
          await advanced.locator(':scope > summary').click();
          await expect(advanced).toHaveAttribute('open','');
          assert.equal(await advanced.locator(':scope > summary').evaluate(el=>getComputedStyle(el,'::after').gridColumnStart),'2','Disclosure uses the shared trailing chevron');
        }
        if(scene==='delete') {
          await expect(modal.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
          await page.evaluate(()=>window.setDeleteBusy(true));
          for(const button of await modal.getByRole('button').all()) await expect(button).toBeDisabled();
          await page.keyboard.press('Escape');
          assert.equal(await page.evaluate(()=>window.deleteClosed),false,'Pending deletion cannot dismiss');
          await page.evaluate(()=>window.setDeleteBusy(false));
          await modal.getByRole('button',{name:'Delete',exact:true}).click();
          assert.equal(await page.evaluate(()=>window.deleteConfirmed),true);
        }
        if(scene==='discard') {
          await modal.getByRole('button',{name:'Discard changes (1)',exact:true}).click();
          assert.equal(await page.evaluate(()=>window.discarded),true);
          continue;
        }
        if(scene==='diagnostics') {
          await modal.getByRole('button',{name:'Copy report'}).click();
          assert.ok((await page.evaluate(()=>window.copied)).startsWith('Fixture sync report'));
        }
        if(height>320) await page.screenshot({path:`${output}/${hostName}${browserType.name()}-${width}-${theme}-${scene}.png`});
      }
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally { await browser.close(); }
}
console.log('Plugin dialogs: Chromium/WebKit, light/dark, desktop/phone/short screens, shared row/header/body/footer metrics, wrapping, touch targets, disclosure and diagnostics copy passed. Synthetic Obsidian host; no server requests.');
