import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

// Only the Obsidian host is mocked; key generation, verification and setup UI are production code.
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { renderEncryptionLoading, renderEncryptionSetup } from './src/ui/settings/encryption-setup-ui';
    import { renderEncryptionManagement } from './src/ui/settings/encryption-manage-ui';
    import { verifyRecoveryCode } from './src/encryption/recovery-verification';
    import { mountModalHeader } from './src/ui/shared/mountModalHeader';
    import { createVaultKeyBundle, addReminderScope, generateRecoveryCode, sealRecoveryBundle } from './src/encryption/key-bundle';
    HTMLElement.prototype.createEl = function(tag, options = {}) {
      const el = document.createElement(tag); el.className = options.cls ?? ''; el.textContent = options.text ?? '';
      for (const [key,value] of Object.entries(options.attr ?? {})) el.setAttribute(key,value);
      this.append(el); return el;
    };
    HTMLElement.prototype.createSpan = function(options) { return this.createEl('span',options); };
    HTMLElement.prototype.createDiv = function(options) { return this.createEl('div',options); };
    HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
    HTMLElement.prototype.setText = function(text) { this.textContent = text; };
    HTMLElement.prototype.empty = function() { this.replaceChildren(); };
    HTMLElement.prototype.toggleClass = function(name, value) { this.classList.toggle(name, value); };
    HTMLElement.prototype.hide = function() { this.style.display = 'none'; };
    HTMLElement.prototype.show = function() { this.style.removeProperty('display'); };
    Object.defineProperty(HTMLElement.prototype,'win',{get:()=>window});
    window.mount = async (resuming = false, delayed = false) => {
      window.disposeContent?.(); window.unmountHeader?.(); document.body.replaceChildren();
      window.calls = []; window.connectionChanged = false;
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async()=>{throw new Error('Clipboard unavailable');}}});
      const modal = document.body.createDiv({cls:'modal crate-shared-modal crate-encryption-modal'});
      modal.setAttribute('role','dialog'); modal.setAttribute('aria-label','End-to-end encryption');
      const content = modal.createDiv({cls:'modal-content crate-reminders-ui'});
      const header = content.createDiv({cls:'crate-modal-header-host'});
      window.unmountHeader = mountModalHeader(header,resuming ? 'Resume encryption' : 'Enable encryption',()=>{});
      const body = content.createDiv({cls:'crate-modal-body'});
      renderEncryptionLoading(body);
      if (delayed) await new Promise(resolve=>{window.finishLoading=resolve;});
      const bundle = addReminderScope(createVaultKeyBundle(),'Reminders');
      window.recovery = await generateRecoveryCode();
      const envelope = await sealRecoveryBundle(bundle,window.recovery);
      await verifyRecoveryCode(envelope,window.recovery,bundle);
      body.empty();
      window.unmountHeader.setTitle(resuming ? 'Resume encryption' : 'Enable encryption');
      window.disposeContent = renderEncryptionSetup(body, {recovery:window.recovery, resuming,
        automaticSync:()=>false, setTitle:title=>window.unmountHeader.setTitle(title), manage:()=>{window.manageOpened=true;}, close:()=>{window.closed=true;},
        assertCurrent:()=>{if(window.connectionChanged) throw new Error('The server connection changed.');},
        encrypt:async(code,progress)=>{
          window.calls.push(code); window.progress=progress; progress('Encrypting files and retained versions',{completed:0,total:12});
          await new Promise((resolve,reject)=>{window.finish = resolve; window.fail = ()=>reject(new Error('Connection lost.'));});
        },
      });
      body.setAttribute('aria-busy','false');
    };
    window.mountManage = () => {
      window.disposeContent?.(); window.unmountHeader?.(); document.body.replaceChildren();
      const modal = document.body.createDiv({cls:'modal crate-shared-modal crate-encryption-modal'});
      const content = modal.createDiv({cls:'modal-content crate-reminders-ui'});
      window.unmountHeader = mountModalHeader(content.createDiv({cls:'crate-modal-header-host'}),'Manage encryption',()=>{});
      const body = content.createDiv({cls:'crate-modal-body'});
      window.disposeContent = renderEncryptionManagement(body, {
        webAppDescription:'Unlock Reading and Reminders with one code.',
        copyRecovery:async()=>{throw new Error('Clipboard unavailable');},
        copyWebApp:()=>new Promise(resolve=>{window.finishCopy=resolve;}),
        turnOff:()=>{window.resetOpened=true;},
        advanced:container=>{container.createEl('p',{text:'Keep both codes private.'}); return ()=>{};},
      });
    };

  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.scss': 'empty' },
  plugins: [{ name: 'obsidian-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({path:'obsidian',namespace:'host'}));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ contents: `
      export function setIcon(el) {
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 24 24');
        svg.setAttribute('width','18');svg.setAttribute('height','18');svg.setAttribute('stroke','currentColor');
        const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M6 6l12 12M18 6 6 18');svg.append(path);el.append(svg);
      }
      export class Setting {
        constructor(el) {
          this.settingEl=el.createDiv({cls:'setting-item'});
          this.infoEl=this.settingEl.createDiv({cls:'setting-item-info'});
          this.nameEl=this.infoEl.createDiv({cls:'setting-item-name'});this.descEl=this.infoEl.createDiv({cls:'setting-item-description'});
          this.controlEl=this.settingEl.createDiv({cls:'setting-item-control'});
        }
        setName(text){this.nameEl.textContent=text;return this;}
        setDesc(text){this.descEl.textContent=text;return this;}
        setClass(name){this.settingEl.classList.add(name);return this;}
        addText(build){
          const input=this.controlEl.createEl('input');
          const api={inputEl:input,setValue:v=>{input.value=v;return api;},setPlaceholder:v=>{input.placeholder=v;return api;},onChange:fn=>{input.oninput=()=>fn(input.value);return api;}};
          build(api);return this;
        }
        addButton(build){
          const button=this.controlEl.createEl('button');
          const api={buttonEl:button,setButtonText:v=>{button.textContent=v;return api;},setDisabled:v=>{button.disabled=v;return api;},
            onClick:fn=>{button.onclick=fn;return api;},setCta:()=>{button.classList.add('mod-cta');return api;},setDestructive:()=>{button.classList.add('mod-warning');return api;}};
          build(api);return this;
        }
      }
    ` }));
  } }],
});
const css = await readFile('dist/styles.css','utf8');
const obsidianCss = process.env.CRATE_OBSIDIAN_CSS_PATH ? await readFile(process.env.CRATE_OBSIDIAN_CSS_PATH,'utf8') : '';
const hostName = obsidianCss ? 'obsidian-' : '';
const output = '.generated/encryption-ui-review';
await mkdir(output,{recursive:true});
const hostStyles = `
  :root{--background-primary:#fff;--background-secondary:#f5f5f5;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--text-normal:#242424;--text-muted:#666;--text-accent:#7057b8;--interactive-accent:#7057b8;--text-on-accent:white;--interactive-normal:#eee;--text-success:#26763d;--text-error:#c33636;--font-ui-small:14px;--font-ui-smaller:12px;--font-ui-medium:16px;--radius-m:8px;--radius-s:4px;--font-interface:system-ui;--font-monospace:monospace}
  .theme-dark{--background-primary:#1e1e1e;--background-secondary:#262626;--background-modifier-border:#393939;--background-modifier-hover:#303030;--text-normal:#ddd;--text-muted:#aaa;--interactive-normal:#292929;--text-success:#87c693;--text-error:#ed9696}
  *{box-sizing:border-box}body{margin:0;background:var(--background-secondary);color:var(--text-normal);font:16px system-ui;display:flex;align-items:center;justify-content:center;height:100dvh}
  button,input,textarea{font:inherit;color:inherit;border:1px solid var(--background-modifier-border);background:var(--interactive-normal);padding:8px 12px;border-radius:6px}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}
  .modal:not(.mod-settings) .setting-item:not(.setting-item-heading):where(:not(.setting-group *)){padding:16px 0;border-top:1px solid var(--background-modifier-border)}
  .modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:14px}
  .setting-item{display:flex;align-items:center;padding:18px 0;border-top:1px solid var(--background-modifier-border)}.setting-item-info{flex:1 1 auto;margin-right:16px}.setting-item-control{display:flex;flex:1 0 auto;justify-content:flex-end;align-items:center;gap:8px}
`;
for (const browserType of [chromium,webkit]) {
  const browser = await browserType.launch();
  try {
    for (const [width,height] of [[1100,900],[390,844],[320,568]]) for (const theme of ['light','dark']) {
      const page = await browser.newPage({viewport:{width,height},hasTouch:width<700,reducedMotion:theme==='light'?'reduce':'no-preference'});
      const errors = []; page.on('pageerror',error=>errors.push(error.message));
      await page.route('https://encryption-ui.test/**',route=>route.fulfill({contentType:'text/html',body:`<html class="theme-${theme}"><head><style>${hostStyles}</style><style>${obsidianCss}</style><style>body{display:flex;align-items:center;justify-content:center;height:100dvh}</style><style>${css}</style></head><body class="theme-${theme}"></body></html>`}));
      await page.goto('https://encryption-ui.test/');
      await page.addScriptTag({content:outputFiles[0].text});
      await page.evaluate(()=>{window.mounted=window.mount(false,true);});
      const modal = page.getByRole('dialog',{name:'End-to-end encryption',exact:true});
      const before = await modal.boundingBox();
      const headerBefore = await page.locator('.crate-modal-header-host').boundingBox();
      const footerBefore = await page.locator('.crate-encryption-footer').boundingBox();
      await expect(page.locator('.crate-modal-body')).toHaveAttribute('aria-busy','true');
      await expect(page.getByRole('button',{name:'Loading…',exact:true})).toBeDisabled();
      await page.screenshot({path:`${output}/${hostName}${browserType.name()}-${width}-${theme}-loading.png`});
      await page.evaluate(async()=>{window.finishLoading();await window.mounted;});
      assert.deepEqual(await modal.boundingBox(),before,'Loading and loaded dialog bounds must match');
      assert.deepEqual(await page.locator('.crate-modal-header-host').boundingBox(),headerBefore,'Header must stay in place');
      assert.deepEqual(await page.locator('.crate-encryption-footer').boundingBox(),footerBefore,'Footer must stay in place');
      await expect(page.locator('.crate-modal-body')).toHaveAttribute('aria-busy','false');
      const outputKey = page.getByLabel('Recovery key',{exact:true});
      const saved = page.getByRole('checkbox',{name:'I’ve saved this key somewhere safe outside my vault.',exact:true});
      const copy = page.getByRole('button',{name:'Copy',exact:true});
      const convert = page.getByRole('button',{name:'Enable encryption',exact:true});
      const details = page.locator('.crate-encryption-details');
      const footer = page.locator('.crate-encryption-footer');
      const content = page.locator('.crate-encryption-setup__content');
      const checkLayout = async () => {
        const bounds = await footer.boundingBox();
        assert.ok(bounds.y>=0 && bounds.y+bounds.height<=height,'Primary action must stay within the viewport');
        assert.equal(await page.evaluate(()=>Array.from(document.querySelectorAll('.modal, .crate-modal-body, .crate-encryption-setup__content, .crate-encryption-footer')).some(el=>el.scrollWidth>el.clientWidth+1)),false,'No horizontal scrolling');
        assert.deepEqual(await modal.boundingBox(),before,'Dialog bounds must stay stable');
        assert.deepEqual(await footer.boundingBox(),footerBefore,'Footer must stay in place');
      };
      await expect(page.getByRole('heading',{name:'Enable encryption',exact:true})).toBeVisible();
      await expect(convert).toBeDisabled();
      await expect(saved).not.toBeChecked();
      await expect(page.getByLabel('Saved recovery key',{exact:true})).toHaveCount(0);
      await expect(details).not.toHaveAttribute('open');
      await expect(outputKey).toHaveJSProperty('readOnly',true);
      await expect(outputKey).not.toHaveAttribute('aria-label'); // Avoid Obsidian's automatic hover tooltip.
      assert.ok(await outputKey.evaluate(el=>el.scrollHeight<=el.clientHeight+1),'The complete recovery key must fit without scrolling');
      if (width<700) {
        assert.ok((await convert.boundingBox()).height>=44,'Touch actions need a 44px target');
        assert.ok((await copy.boundingBox()).height>=44);
      }
      const keyHeader = page.locator('.crate-encryption-key__header');
      await expect(keyHeader).toHaveCSS('border-top-width','0px');
      await expect(keyHeader).toHaveCSS('padding-top','0px');
      await expect(keyHeader).toHaveCSS('padding-bottom','0px');
      const fieldBounds = await outputKey.boundingBox(), copyBounds = await copy.boundingBox();
      assert.ok(copyBounds.y+copyBounds.height<=fieldBounds.y,'Copy belongs above the key field');
      assert.ok(fieldBounds.height<=80,'Recovery field should stay compact');
      const checkboxBounds = await saved.boundingBox(), labelBounds = await page.locator('.crate-encryption-confirm span').boundingBox();
      assert.ok(Math.abs(checkboxBounds.y+checkboxBounds.height/2-labelBounds.y-labelBounds.height/2)<1,'Checkbox and label must be vertically centered');
      await checkLayout();
      await page.screenshot({path:`${output}/${hostName}${browserType.name()}-${width}-${theme}-setup.png`});
      await details.locator('summary').click();
      await checkLayout();
      await details.locator('summary').click();
      await copy.click();
      await expect(content).toContainText('Clipboard access is unavailable');
      await expect(convert).toBeDisabled();
      await expect(saved).not.toBeChecked();
      assert.deepEqual(await page.evaluate(()=>window.calls),[],'Copying must not start conversion');
      const recovery = await page.evaluate(()=>window.recovery);
      await page.evaluate(()=>{navigator.clipboard.writeText=async value=>{window.copied=value;};});
      await copy.click();
      assert.equal(await page.evaluate(()=>window.copied),recovery);
      await expect(convert).toBeDisabled();
      await expect(saved).not.toBeChecked();
      await saved.check(); await expect(convert).toBeEnabled();
      await saved.uncheck(); await expect(convert).toBeDisabled();
      // Native checkbox is labeled, keyboard operable, and independent of Copy.
      await saved.focus(); await page.keyboard.press('Space');
      await expect(saved).toBeChecked(); await expect(convert).toBeEnabled();
      if (browserType === chromium) {
        await page.keyboard.press('Tab'); await expect(details.locator('summary')).toBeFocused();
        await page.keyboard.press('Tab');
      } else await convert.focus();
      await expect(convert).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(content).toContainText('Encrypting files');
      await expect(page.getByRole('button',{name:'Encrypting…',exact:true})).toBeDisabled();
      await expect(saved).toHaveCount(0);
      await expect(copy).toHaveCount(0);
      await expect(outputKey).toHaveCount(0);
      await expect(page.getByRole('progressbar')).toHaveAttribute('value','0');
      await page.evaluate(()=>window.progress('Encrypting files and retained versions',{completed:4,total:12}));
      await expect(content).toContainText('4 of 12 files and versions');
      await expect(page.getByRole('progressbar')).toHaveAttribute('value','4');
      await page.screenshot({path:`${output}/${hostName}${browserType.name()}-${width}-${theme}-progress.png`});
      await expect(content).toHaveJSProperty('inert',false); // Keep progress and explanations available to assistive technology.
      assert.deepEqual(await page.evaluate(()=>window.calls),[recovery]);
      await checkLayout();
      await page.evaluate(()=>window.fail());
      await expect(content).toContainText('Connection lost.');
      await expect(page.getByRole('progressbar')).toHaveCount(0);
      await page.getByRole('button',{name:'Retry',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.calls),[recovery,recovery]);
      await page.evaluate(()=>window.progress('Encrypting shared settings'));
      await expect(page.getByRole('progressbar')).not.toHaveAttribute('value');
      await expect(content).not.toContainText('of 12');
      await page.evaluate(()=>window.finish());
      await expect(page.getByRole('heading',{name:'Encryption enabled',exact:true})).toBeVisible();
      await expect(content).toContainText('Automatic sync remains off');
      await expect(page.getByRole('progressbar')).toHaveCount(0);
      await expect(page.getByRole('button',{name:'Manage encryption',exact:true})).toBeVisible();
      await checkLayout();
      await page.screenshot({path:`${output}/${hostName}${browserType.name()}-${width}-${theme}-complete.png`});
      await page.evaluate(()=>window.mount(true));
      const resume = page.getByRole('button',{name:'Resume conversion',exact:true});
      await expect(page.getByRole('heading',{name:'Resume encryption',exact:true})).toBeVisible();
      await expect(resume).toBeDisabled();
      await saved.check(); await expect(resume).toBeEnabled();
      await page.evaluate(()=>{window.connectionChanged=true;}); await resume.click();
      await expect(content).toContainText('The server connection changed.');
      assert.deepEqual(await page.evaluate(()=>window.calls),[]);
      await page.evaluate(()=>window.mountManage());
      await expect(page.getByRole('heading',{name:'Manage encryption',exact:true})).toBeVisible();
      await expect(page.locator('.crate-modal-body')).toContainText('Encryption on');
      const advanced = page.locator('.crate-encryption-manage__advanced');
      await expect(advanced).not.toHaveAttribute('open');
      const webRow = page.locator('.setting-item').filter({has:page.locator('.setting-item-name',{hasText:'Web app key'})});
      const recoveryRow = page.locator('.setting-item').filter({has:page.locator('.setting-item-name',{hasText:'Recovery key'})});
      const webCopy = webRow.getByRole('button',{name:'Copy',exact:true});
      const recoveryCopy = recoveryRow.getByRole('button',{name:'Copy',exact:true});
      const turnOff = page.getByRole('button',{name:'Turn off',exact:true});
      for (const button of [webCopy,recoveryCopy,turnOff]) {
        await expect(button).toBeInViewport();
        if (width<700) assert.ok((await button.boundingBox()).height>=44);
      }
      await page.screenshot({path:`${output}/${hostName}${browserType.name()}-${width}-${theme}-manage.png`});
      assert.equal(await page.locator('.crate-modal-body').evaluate(el=>el.scrollHeight>el.clientHeight+1),false,'Management actions fit without scrolling: '+JSON.stringify(await page.locator('.crate-modal-body').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,children:[...el.children].map(child=>({text:child.textContent,height:child.getBoundingClientRect().height,margin:getComputedStyle(child).margin}))}))));
      assert.equal(await page.locator('.crate-modal-body').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
      await page.screenshot({path:`${output}/${hostName}${browserType.name()}-${width}-${theme}-manage.png`});
      await webCopy.click(); await expect(webCopy).toBeDisabled(); await expect(recoveryCopy).toBeEnabled();
      await page.evaluate(()=>window.finishCopy()); await expect(webRow.getByRole('button',{name:'Copied',exact:true})).toBeEnabled();
      await recoveryCopy.click(); await expect(page.locator('.crate-modal-body')).toContainText('Clipboard unavailable');
      await advanced.locator('summary').click(); await expect(advanced).toContainText('Keep both codes private.');
      await turnOff.click(); assert.equal(await page.evaluate(()=>window.resetOpened),true);
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally { await browser.close(); }
}
console.log('Encryption setup and management: Chromium/WebKit, desktop/phone/small screens, light/dark, reduced motion, stable loading/header/footer geometry, saved-key acknowledgment, automatic key verification, clipboard fallback, busy/retry states and connection fencing passed. No server requests.');
