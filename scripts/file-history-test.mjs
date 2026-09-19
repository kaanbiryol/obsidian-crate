import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
 stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
 import { openRemoteRecoveryModal } from './src/ui/remote-recovery-modal';
 HTMLElement.prototype.createEl = function(tag, options = {}) {
  const el = document.createElement(tag); if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  for (const [key,value] of Object.entries(options.attr ?? {})) el.setAttribute(key,value);
  this.append(el); return el;
 };
 HTMLElement.prototype.createDiv = function(options) { return this.createEl('div',options); };
 HTMLElement.prototype.createSpan = function(options) { return this.createEl('span',options); };
 HTMLElement.prototype.toggleClass = function(name, active) { this.classList.toggle(name, active); };
 HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
 HTMLElement.prototype.setText = function(text) { this.textContent = text; };
 HTMLElement.prototype.empty = function() { this.replaceChildren(); };
 const row = { path:'Reminders/Inbox.md', hash:'a'.repeat(64), storage_key:'first', size:212, created_at:'2026-09-19T11:59:42Z', expires_at:9999999999999, reason:'replaced' };
 window.restores = []; window.previewCalls = []; window.fail = false; window.delay = false;
 const versions = [row, {...row, storage_key:'second', created_at:'2026-09-19T11:59:07Z'}, {...row, path:'Archive/Deleted.md',storage_key:'deleted',reason:'deleted'}, {...row,path:'Notes/A very long file name that should wrap without overflowing the file history pane.md',storage_key:'long'}];
 const currentFiles = Object.fromEntries([versions[0], versions[3], {...row,path:'Notes/New.md'}, {...row,path:'Notes/Trips/New.md'}, {...row,path:'Root.md'}].map(row => [row.path,{hash:row.hash,revision:'current',size:300,modified:'2026-09-19T15:00:00Z'}]));
 const runtime = {
  getSyncHistory: () => [{timestamp:'2026-09-19T16:00:00Z',type:'sync',success:true,uploaded:0,downloaded:1,merged:0,deleted:0,conflictCount:0,errorCount:0,downloadedPaths:['Reminders/Inbox.md']}],
  loadCurrentSyncedPreview: async path => {
   if(!currentFiles[path]) throw new Error('This file is no longer on the server.');
   return {file:currentFiles[path],text:'# Current synced contents\\nThis is the server copy.'};
  },
  getPendingRestores: () => [],
  listRecentFileVersions: async ({search,path}) => ({versions: versions.filter(row => (!path || row.path===path) && (!search || row.path.toLowerCase().includes(search.toLowerCase()))),hasMore:false}),
  loadFileHistoryPreview: async version => {
   window.previewCalls.push(version.storage_key);
   if(window.delay) { window.delay=false; await new Promise(resolve => window.release=resolve); }
   if(window.fail) throw new Error('Offline');
   if(window.timestampDiff) return {current:'Buy flowers 2026-09-19T14:23:00.000Z <!-- crate-id:long-internal-marker-123456789012345678901234567890 -->',saved:'Buy flowers 2026-09-19T14:21:00.000Z <!-- crate-id:long-internal-marker-123456789012345678901234567890 -->'};
   return {saved:'# Inbox\\n- [ ] Read the saved note <!-- crate-id:preview-123 -->\\n<script>not executed</script>',current:window.same ? '# Inbox\\n- [ ] Read the saved note <!-- crate-id:preview-123 -->\\n<script>not executed</script>' : '# Inbox\\n- [x] Read the current note'};
  },
  restoreRecentFileVersion: async version => {window.restores.push(version.storage_key);return {success:true,errors:[]};}
 };
 const localFiles=Object.keys(currentFiles).map(path=>({path,extension:'md',stat:{size:100,mtime:Date.now()}}));
 window.mount = (path = 'Reminders/Inbox.md') => { document.querySelectorAll('.modal').forEach(el => el.remove()); openRemoteRecoveryModal({vault:{getFiles:()=>localFiles,getFileByPath:path=>localFiles.find(file=>file.path===path)??null,cachedRead:async()=> '# Local contents'}},runtime,path); };
 ` },
 plugins: [{name:'obsidian',setup(builder) {
  builder.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
   export const Platform = { get isMobile() { return innerWidth < 700; } };
   export class Modal {
    constructor(app) {this.app=app;this.modalEl=document.createElement('div');this.modalEl.className='modal';this.contentEl=this.modalEl.createDiv({cls:'modal-content'});}
    setTitle() {} open() {document.body.append(this.modalEl);this.onOpen();if(this.modalEl.classList.contains('crate-file-history-modal')) this.modalEl.querySelector('button')?.focus();} close() {this.onClose();this.modalEl.remove();}
   }
   export class Notice {constructor(message){window.notice=message;}}
   export function setIcon(el,name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.8');
    const path=document.createElementNS(svg.namespaceURI,'path');
    path.setAttribute('d',name==='search'?'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0':name==='check'?'m5 12 4 4 10-10':name==='refresh-cw'?'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M19 16a8 8 0 0 1-13 3l-2-3':'M6 6l12 12M18 6 6 18');
    svg.append(path);el.append(svg);
   }
   export class Setting {
    constructor(el) {this.settingEl=el.createDiv({cls:'setting-item'});this.info=this.settingEl.createDiv({cls:'setting-item-info'});this.control=this.settingEl.createDiv({cls:'setting-item-control'});this.controlEl=this.control;}
    setClass(name){this.settingEl.classList.add(name);return this;}
    addText(build){const input=this.control.createEl('input');const api={inputEl:input,setValue:v=>{input.value=v;return api;},setPlaceholder:v=>{input.placeholder=v;return api;},onChange:fn=>{input.oninput=()=>fn(input.value);return api;}};build(api);return this;}
    addButton(build){const button=this.control.createEl('button');const api={setButtonText:v=>{button.textContent=v;return api;},onClick:fn=>{button.onclick=fn;return api;},setCta:()=>{button.classList.add('mod-cta');return api;},setDestructive:()=>api};build(api);return this;}
   }
  `}));
 }}], bundle:true,write:false,format:'iife',platform:'browser',loader:{'.scss':'empty'},
});
await mkdir('.generated/file-history',{recursive:true});
const css=await readFile('dist/styles.css','utf8');
for(const browserType of [chromium,webkit]) {
 const browser=await browserType.launch();
 try {
  for(const width of [1280,390]) for(const theme of ['light','dark']) {
   const page=await browser.newPage({viewport:{width,height:900}});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.setContent(`<style>
   button{justify-content:center}
   :root{--background-primary:#fff;--background-secondary:#f5f5f5;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--text-normal:#242424;--text-muted:#666;--text-accent:#7057b8;--interactive-accent:#7057b8;--text-on-accent:white;--interactive-normal:#eee;--text-success:#26763d;--text-error:#c33636;--font-ui-small:14px;--font-ui-smaller:12px;--font-ui-medium:16px;--radius-m:8px;--radius-s:4px;--font-interface:system-ui}
   ${theme==='dark'?':root{--background-primary:#161616;--background-secondary:#222;--background-modifier-border:#333;--background-modifier-hover:#303030;--text-normal:#ddd;--text-muted:#999;--interactive-normal:#292929;--text-success:#87c693;--text-error:#ed9696;}':''}
   *{box-sizing:border-box}body{margin:0;background:var(--background-secondary);color:var(--text-normal);font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh}button,input{font:inherit;color:inherit;border:1px solid var(--background-modifier-border);background:var(--interactive-normal);padding:8px 12px;border-radius:6px}button{cursor:pointer}button.mod-cta{background:var(--interactive-accent);color:white}.modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:14px}.modal.crate-confirmation-modal{position:fixed;z-index:10;box-shadow:0 0 0 200vmax #0008}.setting-item{display:flex}.setting-item-control{display:flex;gap:8px}
   </style><style>${css}</style>`);
   await page.addScriptTag({content:outputFiles[0].text});await page.evaluate(()=>window.mount());
   await expect(page.locator('.reminder-modal-header-title')).toBeFocused();
   await page.keyboard.press('Shift+Tab');
   await expect(page.getByRole('button', {name:'Close dialog',exact:true})).toBeFocused();
   await page.keyboard.press('Tab');
   const bounds = await page.locator('.crate-file-history-modal').boundingBox();
   assert.equal(bounds.width, width < 700 ? width : Math.min(800, width - 48));
   assert.equal(bounds.height, width < 700 ? 900 * 0.85 : 560);
   const openFile = async path => { await page.evaluate(path => window.mount(path), path); };
   const openInbox = () => openFile('Reminders/Inbox.md');
   await expect(page.getByRole('button',{name:'← All files',exact:true})).toHaveCount(0);
   await expect(page.getByRole('textbox')).toHaveCount(0);
   await expect(page.locator('.crate-history-version')).toHaveCount(3);
   await expect(page.locator('[data-version-key=first]')).toContainText(':59:42');
   await expect(page.locator('[data-version-key=second]')).toContainText(':59:07');
   await page.locator('[data-version-key=first]').focus();await page.keyboard.press('Enter');
   await expect(page.getByLabel('Changes from current local file to saved version')).toContainText('<script>not executed</script>');
   assert.equal(await page.locator('.crate-history-preview-output script').count(),0);
   await expect(page.locator('.crate-history-internal-marker').first()).toHaveText('<!-- crate-id:preview-123 -->');
   await expect(page.getByRole('button',{name:'Compare with local',exact:true})).toHaveCount(0);
   await expect(page.getByRole('button',{name:'Saved version',exact:true})).toHaveCount(0);
   await expect(page.getByLabel('Changes from current local file to saved version')).toContainText('Read the saved note <!-- crate-id:preview-123 -->');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:'.generated/file-history/'+browserType.name()+'-'+width+'-'+theme+'.png'});
   await page.getByRole('button',{name:'Restore this version',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.restores),[]);
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.restores),[]);
   await page.getByRole('button',{name:'Restore this version',exact:true}).click();
   await page.getByRole('button',{name:'Restore',exact:true}).click();
   await expect.poll(()=>page.evaluate(()=>window.restores)).toEqual(['first']);
   await openFile('Notes/New.md');
   await page.getByRole('button',{name:'Current local file',exact:true}).click();
   await expect(page.getByLabel('Current local file contents')).toContainText('Local contents');
   await expect(page.getByRole('button',{name:'Restore this version',exact:true})).toHaveCount(0);
   if(width<700) await page.getByRole('button',{name:'← Versions',exact:true}).click();
   await expect(page.locator('.crate-history-list-pane')).toContainText('No earlier versions retained');
   await page.getByRole('button',{name:'Current local file',exact:true}).click();
   await page.screenshot({path:'.generated/file-history/'+browserType.name()+'-'+width+'-'+theme+'-files.png'});
   await openInbox();
   await page.evaluate(()=>window.fail=true);
   await page.locator('[data-version-key=first]').click();
   await expect(page.getByRole('alert')).toContainText('Offline');
   await page.evaluate(()=>window.fail=false);
   await page.getByRole('button',{name:'Retry preview',exact:true}).click();
   await expect(page.getByLabel('Changes from current local file to saved version')).toBeVisible();
   await page.evaluate(()=>window.same=true);
   await openInbox();
   await page.locator('[data-version-key=first]').click();
   await expect(page.getByText('No differences',{exact:true})).toBeVisible();
   await expect(page.getByLabel('Saved file contents')).not.toBeVisible();
   await page.getByText('View file contents',{exact:true}).click();
   await expect(page.getByLabel('Saved file contents')).toBeVisible();
   await page.evaluate(()=>{ window.timestampDiff=true; window.same=false; });
   await openInbox();
   await page.locator('[data-version-key=first]').click();
   const diff = page.getByLabel('Changes from current local file to saved version');
   await expect(diff.locator('.crate-diff-text').first()).toHaveCSS('white-space', 'pre');
   await expect(diff.locator('.crate-diff-word')).toHaveText(['23', '21']);
   await expect(diff.locator('.crate-history-internal-marker')).toHaveCount(2);
   await expect(diff.locator('.crate-history-internal-marker').first()).toHaveCSS('opacity', '0.25');
   await expect(page.locator('.crate-history-file-context h3')).toHaveText('Reminders/Inbox.md');
   await expect(page.locator('.crate-history-list-pane h3')).toHaveCount(0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.ok(await diff.evaluate(el=>el.scrollWidth>el.clientWidth));
   await expect(diff.locator('.crate-diff-number')).toHaveCount(4);
   await expect(diff.locator('.crate-diff-line.is-removed')).toHaveCount(1);
   await expect(diff.locator('.crate-diff-line.is-added')).toHaveCount(1);
   await page.screenshot({path:'.generated/file-history/'+browserType.name()+'-'+width+'-'+theme+'-timestamp.png'});
   await openFile('Archive/Deleted.md');
   await page.locator('[data-version-key=deleted]').click();
   await expect(page.getByRole('button',{name:'Restore this version',exact:true})).toBeVisible();
   assert.deepEqual(errors,[]);await page.close();
  }
 } finally {await browser.close();}
}
console.log('File history: Chromium and WebKit, desktop/mobile, light/dark, history, current files, keyboard, previews, deleted files, retry and confirmed restore passed.');
