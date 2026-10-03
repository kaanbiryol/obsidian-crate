import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { switchFeature } from './pwa-feature-navigation.mjs';

// Production PWA + approval modal + WebCrypto in separate browser contexts.
// Obsidian's DOM host and HTTP relay are fixtures; D1/auth have Worker coverage.
const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
export * from './src/encryption/key-bundle';
export * from './src/encryption/server-state';
export * from './src/encryption/scope-binding';` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const keys = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const bundle = keys.addReminderScope(keys.addReminderScope(keys.createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
const recovery = await keys.generateRecoveryCode();
const state = { ...await keys.bindEncryptionScopes(keys.createEncryptionState(bundle, await keys.sealRecoveryBundle(bundle, recovery)), bundle), mode: 'active' };
const grants = bundle.scopes.map(scope => keys.createReminderKeyGrant(bundle, scope.folderPath));
const scoped = folder => ({ version: 1, mode: 'active', vaultId: state.vaultId, generation: state.generation, recovery: state.recovery, scope: state.scopes.find(scope => scope.folderPath === folder) });
const secrets = [recovery, bundle.vault.secret, ...bundle.scopes.flatMap(scope => [scope.data.secret, scope.notifications.secret])];
const host = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import { WebAppPairingModal } from './src/ui/settings/web-app-pairing-modal';
HTMLElement.prototype.createEl = function(tag, options={}) { const el=document.createElement(tag); el.className=options.cls??''; el.textContent=options.text??''; for(const [key,value] of Object.entries(options.attr??{})) el.setAttribute(key,value); this.append(el); return el; };
HTMLElement.prototype.createSpan = function(options) { return this.createEl('span',options); };
HTMLElement.prototype.createDiv = function(options) { return this.createEl('div',options); };
HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
HTMLElement.prototype.setText = function(text) { this.textContent=text; };
HTMLElement.prototype.appendText = function(text) { this.append(text); };
HTMLElement.prototype.empty = function() { this.replaceChildren(); };
Object.defineProperty(HTMLElement.prototype,'win',{get:()=>window});
window.openPairing = () => { window.modal=new WebAppPairingModal({app:{}}); window.modal.onOpen(); };
window.closePairing = () => window.modal.close();
` }, bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.scss': 'empty' }, plugins: [{ name: 'obsidian-host', setup(builder) {
  builder.onResolve({ filter: /(^obsidian$|plugin\/web-app-pairing$)/ }, args => ({ path: args.path, namespace: 'host' }));
  builder.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents: args.path === 'obsidian' ? `
export function setIcon(el) { el.textContent='×'; }
export class Modal {
 constructor(){this.modalEl=document.body.createDiv({cls:'modal'});this.contentEl=this.modalEl.createDiv({cls:'modal-content'});}
 setTitle(title){this.modalEl.setAttribute('role','dialog');this.modalEl.setAttribute('aria-label',title);}
 close(){this.onClose();this.modalEl.remove();}
}
export class Setting {
 constructor(el){this.settingEl=el.createDiv({cls:'setting-item'});this.settingEl.createDiv({cls:'setting-item-info'});this.el=this.settingEl.createDiv({cls:'setting-item-control'});}
 addButton(build){const b=this.el.createEl('button');const api={setButtonText:v=>{b.textContent=v;return api;},setCta:()=>{b.classList.add('mod-cta');return api;},setDisabled:v=>{b.disabled=v;return api;},onClick:fn=>{b.onclick=fn;return api;}};build(api);return this;}
}
` : `
export async function openWebAppPairing(plugin,signal) {
 const current=()=>signal.throwIfAborted();
 const request=async(id,body)=>{current(); const r=await fetch('/encryption/pairing'+(id?'?id='+id:''),{method:body?'POST':'GET',headers:{Authorization:'Bearer mac'},body:body?JSON.stringify(body):undefined,signal});current(); if(!r.ok)throw new Error('Connection lost');return r.json();};
 return {current,validate:()=>{},transport:{read:id=>request(id),write:body=>request(null,body)},payload:async()=>window.testGrants,cancel:async id=>{await fetch('/encryption/pairing',{method:'POST',headers:{Authorization:'Bearer mac'},body:JSON.stringify({action:'cancel',id})});}};}

` }));
} }] });
const pluginCss = await readFile('dist/styles.css','utf8');
const obsidianCss = process.env.CRATE_OBSIDIAN_CSS_PATH ? await readFile(process.env.CRATE_OBSIDIAN_CSS_PATH,'utf8') : '';
const hostCss = `
:root{--background-primary:#fff;--background-secondary:#f5f5f5;--background-modifier-border:#ddd;--text-normal:#242424;--text-muted:#666;--interactive-accent:#7057b8;--text-on-accent:white;--font-ui-small:14px;--font-ui-smaller:12px;--font-ui-medium:16px;--radius-m:8px;--font-monospace:monospace}
.theme-dark{--background-primary:#1e1e1e;--background-secondary:#262626;--background-modifier-border:#393939;--text-normal:#ddd;--text-muted:#aaa}
*{box-sizing:border-box}body{margin:0;background:var(--background-secondary);color:var(--text-normal);font:16px system-ui;display:flex;align-items:center;justify-content:center;height:100dvh}
.modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:14px}
.setting-item{display:flex}.setting-item-control{display:flex;gap:8px}button{font:inherit;color:inherit;border:1px solid var(--background-modifier-border);border-radius:6px;background:transparent}
`;
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';
await mkdir('.generated/pwa-pairing', { recursive: true });

async function savedKeys(page) {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(db => db.name === 'crate-encryption-keys')) return [];
    const db = await new Promise((resolve, reject) => { const r=indexedDB.open('crate-encryption-keys',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
    const values = await new Promise(resolve => { const r=db.transaction('keys').objectStore('keys').getAll();r.onsuccess=()=>resolve(r.result); });
    db.close();return values.map(value=>({folder:value.folderPath,extractable:value.data.key.extractable,localState:value.localState}));
  });
}
try {
  const engines = [chromium, webkit].filter(engine => !process.env.CRATE_TEST_BROWSER || engine.name() === process.env.CRATE_TEST_BROWSER);
  assert.ok(engines.length, 'Unknown test browser');
  for (const engine of engines) {
    const browser = await engine.launch();
    try {
      for (const initial of ['reminders', 'reading']) {
        const phone = await browser.newContext({ userAgent: iphone, hasTouch: true, serviceWorkers: 'block', viewport: {width:390,height:844}, reducedMotion:'reduce' });
        const mac = await browser.newContext({ hasTouch: initial === 'reading' });
        const records = new Map(), writes = [];
        let failPoll = false, expire = false;
        const relay = async route => {
          const request=route.request(), url=new URL(request.url());
          if (request.method()==='GET') {
            if(failPoll && request.headers().authorization !== 'Bearer mac') return route.fulfill({status:503,json:{error:'Temporarily unavailable'}});
            const id=url.searchParams.get('id');
            return route.fulfill({json:{requests:expire?[]:[...records.values()].filter(r=>id?r.context.id===id:!r.closed&&!r.payload)}});
          }
          const body=request.postDataJSON(); writes.push(body);
          let row;
          if(body.action==='start'){row={context:body.context,commitment:body.commitment,expiresAt:Date.now()+300000};records.set(body.context.id,row);}
          else {row=records.get(body.id); assert.ok(row); if(body.action==='accept')row.responderKey=body.key;
            if(body.action==='reveal')row.requesterKey=body.key;
            if(body.action==='approve')row.payload=body.payload;
            if(body.action==='cancel'||body.action==='finish'){row.closed=true;delete row.payload;}}
          await route.fulfill({json:{request:row}});
        };
        const errors=[];
        for(const context of [phone,mac]) {
          await context.route('**/encryption/pairing**',relay);
          context.on('request',request=>{for(const secret of secrets)assert.ok(!(request.url()+(request.postData()??'')).includes(secret),'Secrets must not reach the relay');});
          context.on('page',page=>page.on('pageerror',error=>{errors.push(error.message);if(process.env.CRATE_TEST_DEBUG)console.error('Pairing page error:',error.stack);}));
        }
        try {
          await phone.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));
          await phone.route('**/notifications/preview-session.js',route=>route.fulfill({contentType:'application/javascript',body:''}));
          await phone.route('**/encryption',route=>route.fulfill({json:{encryption:scoped('Reminders')}}));
          await phone.route('**/reading/encryption',route=>route.fulfill({json:{encryption:scoped('Reading')}}));
          await phone.route('**/reading/session',route=>route.fulfill({json:{id:'paired',folderPath:'Reading',generation:'g1',expiresAt:Date.now()+600000}}));
          await phone.route('**/*/encrypted-files?*',route=>route.fulfill({json:{files:[],nextCursor:null,generation:bundle.generation,sequence:1}}));
          await mac.route('**/pairing-host',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${hostCss}</style><style>${obsidianCss}</style><style>${pluginCss}</style></head><body class="theme-dark"><script>${host.outputFiles[0].text}</script></body></html>`}));
          const p=await phone.newPage(), m=await mac.newPage();
          await m.goto(`${origin}/pairing-host`);
          await m.evaluate(payload=>{window.testGrants=payload;},{grants});
          await p.goto(`${origin}/notifications?token=pairing-${initial}&folder=Reminders&section=${initial}`);
          await expect(p.getByRole('button',{name:'Connect with Obsidian',exact:true})).toBeVisible();
          await expect(p.getByRole('button',{name:'Retry connection',exact:true})).not.toBeVisible();
          const options=p.locator('.crate-encryption-unlock__options summary');
          await options.focus(); await p.keyboard.press('Enter');
          await expect(p.getByRole('button',{name:'Retry connection',exact:true})).toBeVisible();
          await expect(p.getByRole('button',{name:'Log out',exact:true})).toBeVisible();
          await options.click();
          assert.ok((await p.getByRole('heading',{name:'Finish setting up Crate',exact:true}).boundingBox()).y < 180,'Setup should not start halfway down the screen');
          await p.screenshot({path:`.generated/pwa-pairing/${engine.name()}-${initial}-setup.png`,fullPage:true});
          assert.deepEqual(await savedKeys(p),[],'Installed app begins without Safari keys');
          assert.equal(writes.length,0,'No pairing writes until requested');
          await expect(p.getByLabel('Recovery key',{exact:true})).toHaveCount(0);
          await p.getByRole('button',{name:'Connect with Obsidian',exact:true}).click();
          await expect.poll(()=>writes.filter(b=>b.action==='start').length).toBe(1);
          // Manual recovery remains available, and leaving pairing cancels it.
          await p.getByRole('button',{name:'Use recovery key instead',exact:true}).click();
          await expect(p.getByLabel('Recovery key',{exact:true})).toBeVisible();
          await expect.poll(()=>writes.filter(b=>b.action==='cancel').length).toBe(1);
          await p.getByRole('button',{name:'Connect with Obsidian instead',exact:true}).click();
          await p.getByRole('button',{name:'Connect with Obsidian',exact:true}).click();
          await expect.poll(()=>writes.filter(b=>b.action==='start').length).toBe(2);
          // Expiry has a fresh-attempt action, instead of retrying a dead request.
          expire=true;
          await p.getByRole('button',{name:'Start again',exact:true}).waitFor({timeout:12000});
          expire=false;
          await p.getByRole('button',{name:'Start again',exact:true}).click();
          await expect.poll(()=>writes.filter(b=>b.action==='start').length).toBe(3);
          await m.evaluate(()=>window.openPairing());
          const modal=m.getByRole('dialog',{name:'Connect web app',exact:true});
          const waitingBounds=await modal.boundingBox();
          assert.ok(waitingBounds.height<=334,'Pairing uses a compact dialog');
          await expect(m.getByRole('button',{name:'Approve',exact:true})).toBeEnabled({timeout:15000});
          assert.deepEqual(await modal.boundingBox(),waitingBounds,'Code arrival keeps the dialog stable');
          await expect(m.getByText('Open Crate on your phone',{exact:false})).toHaveCount(0);
          const code=await m.getByLabel('Verification code',{exact:true}).textContent();
          assert.match(code,/^\d{4} \d{4} \d{4}$/);
          await expect(p.getByLabel('Verification code',{exact:true})).toHaveText(code);
          assert.equal(writes.some(b=>b.action==='approve'),false);
          assert.deepEqual(await savedKeys(p),[],'Showing a code does not transfer keys');
          await p.setViewportSize({width:320,height:568});
          for(const theme of ['light','dark']){
            await p.emulateMedia({colorScheme:theme});
            assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            await p.screenshot({path:`.generated/pwa-pairing/${engine.name()}-${initial}-${theme}.png`,fullPage:true});
          }
          // A transient poll failure keeps the same channel and comparison code.
          failPoll=true;
          await expect(p.getByRole('alert')).toHaveText('Temporarily unavailable',{timeout:12000});
          failPoll=false;
          await p.getByRole('button',{name:'Try again',exact:true}).click();
          await expect(p.getByLabel('Verification code',{exact:true})).toHaveText(code);
          await m.getByRole('button',{name:'Approve',exact:true}).click();
          await expect(m.getByRole('heading',{name:'Finish on your phone',exact:true})).toBeVisible();
          assert.deepEqual(await modal.boundingBox(),waitingBounds,'Approval keeps the dialog stable');
          await expect(m.getByLabel('Verification code',{exact:true})).toHaveText(code);
          for(const width of [1100,320]) for(const theme of ['light','dark']) {
            await m.setViewportSize({width,height:width===320?568:900});
            await m.evaluate(theme=>document.body.className='theme-'+theme,theme);
            await m.screenshot({path:`.generated/pwa-pairing/${engine.name()}-${initial}-mac-${width}-${theme}.png`});
            assert.equal(await m.locator('.crate-modal-body').evaluate(el=>el.scrollWidth<=el.clientWidth && el.scrollHeight<=el.clientHeight),true,'Code and instructions fit without scrolling');
            await expect(m.getByRole('button',{name:'Done',exact:true})).toBeInViewport();
          }
          await expect(p.getByRole('button',{name:'Confirm and unlock',exact:true})).toBeVisible({timeout:15000});
          assert.deepEqual(await savedKeys(p),[], 'A relay packet alone must never enroll an unverified responder');
          await expect(p.getByLabel('Verification code',{exact:true})).toHaveText(code);
          await p.getByRole('button',{name:'Confirm and unlock',exact:true}).click();
          await expect.poll(async()=> (await savedKeys(p)).length,{timeout:15000}).toBe(2);
          await expect(p.locator('.crate-encryption-unlock')).toHaveCount(0);
          await expect.poll(()=>writes.filter(b=>b.action==='finish').length).toBe(1);
          const stored=await savedKeys(p);
          assert.deepEqual(stored.map(k=>k.folder).sort(),['Reading','Reminders']);
          assert.ok(stored.every(k=>!k.extractable));
          // Wait for the automatic post-pairing reload to finish before testing
          // a second reload; overlapping navigations abort WebKit's startup fetches.
          const initialPanel = p.locator(`.crate-feature-panel[data-crate-section="${initial}"][data-active="true"]`);
          await expect(initialPanel).toBeVisible();
          await p.waitForLoadState('networkidle');
          await p.reload();
          await expect(initialPanel).toBeVisible();
          await expect(p.locator('.crate-encryption-unlock')).toHaveCount(0);
          await switchFeature(p,initial==='reading'?'Reminders':'Reading');
          await expect(p.locator(`.crate-feature-panel[data-crate-section="${initial==='reading'?'reminders':'reading'}"][data-active="true"]`)).toBeVisible();
          await expect(p.locator('.crate-encryption-unlock')).toHaveCount(0);
          assert.deepEqual(await savedKeys(p),stored,'Reload preserves local draft encryption keys');
          assert.deepEqual(errors,[]);
          console.log(`${engine.name()} ${initial}: separate storage, explicit approval, matching codes, cancellation, expiry, retry, both scopes and reload passed`);
        } finally {await phone.close();await mac.close();}
      }
    } finally {await browser.close();}
  }
} finally {await new Promise(resolve=>server.close(resolve));}
