import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
 stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
 import { openRemoteRecoveryModal } from './src/ui/remote-recovery-modal';
 import { HistoryRestoreModal } from './src/ui/activity/history-restore-modal';
 import { ActivityHistory } from './src/ui/activity/activity-history';
 import { mergeSharedHistory } from './src/ui/activity/shared-history';
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
 window.stateRestores = 0;
 window.mountStateHistory = () => {
  window.activityHistory?.dispose();
  document.querySelectorAll('.modal, #history-fixture').forEach(el => el.remove());
  const container = document.body.createDiv({cls:'crate-reminders-ui'}); container.id='history-fixture';
  const surface=container.createDiv({cls:'crate-activity-surface '+(innerWidth<700?'is-bottom-sheet':'is-centered'),attr:{role:'dialog','aria-label':'Sync activity'}});
  const activity = surface.createDiv({cls:'crate-activity-modal'});
  const header = activity.createDiv({cls:'crate-modal-header-host'});
  header.createEl('h2',{text:'Sync activity'});
  header.createEl('button',{text:'Sync vault'});
  const body=activity.createDiv({cls:'crate-activity-body'});
  const panel=body.createDiv({cls:'crate-activity-panel'});
  const entry = {timestamp:'2026-09-20T10:18:42Z',type:'sync',success:true,uploaded:2,downloaded:1,merged:0,deleted:0,conflictCount:0,errorCount:0,uploadedPaths:['Today.md','Upcoming.md'],downloadedPaths:['Notes/Downloaded.md'],sharedCheckpoint:'12345678-1234-1234-1234-123456789012'};
  const shared = [{id:'12345678-1234-1234-1234-123456789012',sequence:1,timestamp:entry.timestamp,expiresAt:Date.parse('2026-10-20T10:18:00Z'),fileCount:15}];
  shared.push({...shared[0],id:'abcdef12-1234-1234-1234-123456789012',timestamp:'2026-09-20T10:18:07Z'});
  window.stateChecks=0; window.stateFilePreviews=0;
  const restore = entry => {
   window.restoreModal = new HistoryRestoreModal({}, entry, async () => {
    window.stateChecks++;
    if(window.stateCheckDelay) {window.stateCheckDelay=false;await new Promise(resolve=>window.releaseStateCheck=resolve);}
    if(window.statePreviewError) throw new Error('This version is no longer available. No files were changed.');
    return {items:window.stateNoChanges?[]:[{path:'Notes/Plan.md',action:'revert'},{path:'Archive/Deleted.md',action:'restore'},{path:'Notes/Added later.md',action:'remove'}],unchangedCount:12,
     preview:async () => {window.stateFilePreviews++;return {current:'current',saved:'saved'};},
     restore:async () => {window.stateRestores++;if(window.stateRestoreError) throw new Error('Restore failed');await new Promise(resolve=>window.finishStateRestore=resolve);}};
   }, () => {});
   window.restoreModal.open();
  };
  const history = mergeSharedHistory([entry], shared);
  window.historyLoads = []; window.openedHistoryFiles = [];
  window.activityHistory = new ActivityHistory({}, panel, {
   restore,
   openFile: path => window.openedHistoryFiles.push(path),
   load: async (selected, previous) => {
    window.historyLoads.push([selected.sharedCheckpoint,previous?.sharedCheckpoint]);
    if(window.historyDelay) {window.historyDelay=false;await new Promise(resolve=>window.releaseHistory=resolve);}
    if(window.historyError) throw new Error('History is offline');
    return {compared:!!previous,items:[{path:'Today.md',action:previous?'modified':'saved'},{path:'Upcoming.md',action:previous?'added':'saved'}],
     notice:previous?undefined:'No earlier state to compare.',
     preview:async path => {
      if(window.historyPreviewDelay) {window.historyPreviewDelay=false;await new Promise(resolve=>window.releaseHistoryPreview=resolve);}
      if(window.historyPreviewError) throw new Error('Historical preview is offline');
      return {current:'# Before '+path,saved:'# '+(previous?'After ':'Earliest ')+path};
     }};
   }
  });
  window.updateHistory = () => window.activityHistory.update(history);
  window.refreshHistoryDetails = () => {history[0]={...history[0],errors:[]};window.updateHistory();};
  window.updateHistory();
 };
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
    path.setAttribute('d',name==='arrow-left'?'M19 12H5m7-7-7 7 7 7':name==='search'?'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0':name==='check'?'m5 12 4 4 10-10':name==='refresh-cw'?'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M19 16a8 8 0 0 1-13 3l-2-3':'M6 6l12 12M18 6 6 18');
    svg.append(path);el.append(svg);
   }
   export class Setting {
    constructor(el) {this.settingEl=el.createDiv({cls:'setting-item'});this.info=this.settingEl.createDiv({cls:'setting-item-info'});this.control=this.settingEl.createDiv({cls:'setting-item-control'});this.controlEl=this.control;}
    setClass(name){this.settingEl.classList.add(name);return this;}
    addText(build){const input=this.control.createEl('input');const api={inputEl:input,setValue:v=>{input.value=v;return api;},setPlaceholder:v=>{input.placeholder=v;return api;},onChange:fn=>{input.oninput=()=>fn(input.value);return api;}};build(api);return this;}
    addButton(build){const button=this.control.createEl('button');const api={buttonEl:button,setButtonText:v=>{button.textContent=v;return api;},onClick:fn=>{button.onclick=fn;return api;},setCta:()=>{button.classList.add('mod-cta');return api;},setDestructive:()=>api};build(api);return this;}
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
   :root{--background-primary:#fff;--background-secondary:#f5f5f5;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--text-normal:#242424;--text-muted:#666;--text-accent:#7057b8;--interactive-accent:#7057b8;--text-on-accent:white;--interactive-normal:#eee;--text-success:#26763d;--text-error:#c33636;--font-ui-small:14px;--font-ui-smaller:12px;--font-ui-medium:16px;--radius-m:8px;--radius-s:4px;--font-interface:system-ui;--font-monospace:monospace}
   ${theme==='dark'?':root{--background-primary:#161616;--background-secondary:#222;--background-modifier-border:#333;--background-modifier-hover:#303030;--text-normal:#ddd;--text-muted:#999;--interactive-normal:#292929;--text-success:#87c693;--text-error:#ed9696;}':''}
   #history-fixture{display:flex;width:auto;max-width:100vw} #history-fixture .crate-activity-surface.is-bottom-sheet{width:100vw}*{box-sizing:border-box}body{margin:0;background:var(--background-secondary);color:var(--text-normal);font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh}button,input{font:inherit;color:inherit;border:1px solid var(--background-modifier-border);background:var(--interactive-normal);padding:8px 12px;border-radius:6px}button{cursor:pointer}button.mod-cta{background:var(--interactive-accent);color:white}.modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:14px}.modal.crate-confirmation-modal,.modal.crate-history-restore-modal,.modal.crate-vault-history-modal{position:fixed;z-index:10;box-shadow:0 0 0 200vmax #0008}.setting-item{display:flex}.setting-item-control{display:flex;gap:8px}
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
   await page.evaluate(()=>window.mountStateHistory());
   const activityRoot=page.locator('#history-fixture');
   const historyRoot=page.locator('.crate-vault-history-modal');
   const showHistory = async () => {
    const browse=activityRoot.getByRole('button',{name:'Browse vault history',exact:true});
    if(!(await historyRoot.count())) await browse.click();
    for(const name of ['Back to files','Back to history']) {
     const back=historyRoot.getByRole('button',{name,exact:true});
     if(await back.isVisible()) await back.click();
    }
   };
   const selectPoint = async id => {
    await showHistory();
    await historyRoot.locator('.crate-history-syncs button[data-history-key*=":'+id+'-"]').click();
   };
   const openPoint = async id => {
    await selectPoint(id);
    await historyRoot.getByRole('button',{name:'Restore to this point',exact:true}).click();
   };
   const timeline=activityRoot.locator('.crate-history-timeline');
   const details=timeline.locator('details[data-history-key*=":12345678-"]');
   const browseVault=activityRoot.getByRole('button',{name:'Browse vault history',exact:true});
   await expect(timeline.locator('.crate-history-entry')).toHaveCount(2);
   await expect(details).not.toHaveAttribute('open');
   await details.locator('summary').click();
   await expect(details.getByRole('button',{name:'File history for Today.md',exact:true})).toBeVisible();
   await expect(details.getByRole('button',{name:'File history for Notes/Downloaded.md',exact:true})).toBeVisible();
   await details.getByRole('button',{name:'File history for Today.md',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.openedHistoryFiles),['Today.md']);
   await details.getByRole('button',{name:'File history for Today.md',exact:true}).focus();
   await page.evaluate(()=>window.refreshHistoryDetails());
   await expect(details).toHaveAttribute('open','');
   await expect(details.getByRole('button',{name:'File history for Today.md',exact:true})).toBeFocused();
   assert.equal(await page.evaluate(()=>window.historyLoads.length),0);
   if(width>=700) assert.equal((await activityRoot.locator('.crate-activity-surface').boundingBox()).width,800);
   await page.screenshot({path:'.generated/file-history/'+browserType.name()+'-'+width+'-'+theme+'-compact-history.png'});
   await browseVault.click();
   await expect(historyRoot).toBeVisible();
   await expect(activityRoot.getByRole('dialog',{name:'Sync activity',exact:true})).toBeVisible();
   await expect(historyRoot.getByRole('heading',{name:'Vault history',exact:true})).toBeVisible();
   if(width>=700) {
    assert.equal((await activityRoot.locator('.crate-activity-surface').boundingBox()).width,800);
    assert.equal((await historyRoot.boundingBox()).width,1120);
   }
   const savedScroll=await timeline.evaluate(el=>el.scrollTop);
   await historyRoot.getByRole('button',{name:'Close dialog',exact:true}).click();
   await expect(historyRoot).toHaveCount(0);
   await expect(browseVault).toBeFocused();
   await expect(details).toHaveAttribute('open','');
   assert.equal(await timeline.evaluate(el=>el.scrollTop),savedScroll);
   await browseVault.click();
   await expect(historyRoot.getByRole('button',{name:'← Sync activity',exact:true})).toHaveCount(0);
   await expect(historyRoot.locator('.crate-history-syncs button')).toHaveCount(2);
   await expect(historyRoot.locator('.crate-history-syncs')).toContainText('Uploaded 2 · Downloaded 1');
   await expect(historyRoot.locator('.crate-history-syncs')).toContainText(':18:42');
   await expect(historyRoot.locator('.crate-history-syncs')).toContainText(':18:07');
   await expect(historyRoot.getByRole('button',{name:'Review restore point',exact:true})).toHaveCount(0);
   await expect.poll(()=>page.evaluate(()=>window.historyLoads.length)).toBe(2);
   await page.evaluate(()=>window.updateHistory());
   assert.equal(await page.evaluate(()=>window.historyLoads.length),2);
   const historyPanel=historyRoot.locator('.crate-history-browser');
   await historyPanel.evaluate(el=>el.hidden=true);
   await expect(historyPanel).not.toBeVisible();
   await historyPanel.evaluate(el=>el.hidden=false);
   await expect(historyPanel).toBeVisible();
   if(width<700) await selectPoint('12345678');
   await expect(historyRoot.getByRole('button',{name:'View Today.md',exact:true})).toBeVisible();
   await historyRoot.getByRole('button',{name:'View Today.md',exact:true}).click();
   await expect(historyRoot.getByRole('region')).toContainText('# Before Today.md');
   await expect(historyRoot.getByRole('region')).toContainText('# After Today.md');
   if(width>=700) {
    const columns=await Promise.all(['.crate-history-syncs','.crate-history-event-files','.crate-history-preview-pane'].map(selector=>historyRoot.locator(selector).boundingBox()));
    assert.ok(columns[0].x+columns[0].width<=columns[1].x);
    assert.ok(columns[1].x+columns[1].width<=columns[2].x);
   }
   await page.screenshot({path:'.generated/file-history/'+browserType.name()+'-'+width+'-'+theme+'-restore-points.png'});
   await selectPoint('abcdef12');
   await expect(historyRoot.locator('.crate-history-syncs [aria-current="true"]')).toContainText(':18:07');
   await historyRoot.getByRole('button',{name:'View Today.md',exact:true}).click();
   await expect(historyRoot.getByLabel('Saved file contents')).toContainText('# Earliest Today.md');
   await expect(historyRoot.getByRole('region')).toHaveCount(0);
   await expect(historyRoot.getByRole('button',{name:'Retry loading',exact:true})).toHaveCount(0);
   await page.evaluate(()=>{window.historyDelay=true;});
   await selectPoint('12345678');
   await selectPoint('abcdef12');
   await expect(historyRoot.locator('.crate-history-event-files')).toContainText('Saved files');
   await page.evaluate(()=>window.releaseHistory());
   await expect(historyRoot.locator('.crate-history-event-files')).toContainText('Saved files');
   await page.evaluate(()=>{window.historyError=true;});
   await selectPoint('12345678');
   await expect(historyRoot.locator('.crate-history-event-files')).toContainText('History is offline');
   await page.evaluate(()=>{window.historyError=false;});
   await historyRoot.getByRole('button',{name:'Retry loading',exact:true}).click();
   await historyRoot.getByRole('button',{name:'View Today.md',exact:true}).click();
   await expect(historyRoot.getByRole('region')).toContainText('# After Today.md');
   const selectHistoryFile = async path => {
    const back=historyRoot.getByRole('button',{name:'Back to files',exact:true});
    if(await back.isVisible()) await back.click();
    await historyRoot.getByRole('button',{name:'View '+path,exact:true}).click();
   };
   await page.evaluate(()=>{window.historyPreviewDelay=true;});
   await selectHistoryFile('Upcoming.md');
   await selectHistoryFile('Today.md');
   await page.evaluate(()=>window.releaseHistoryPreview());
   await expect(historyRoot.getByRole('region')).toContainText('# After Today.md');
   await expect(historyRoot.getByRole('region')).not.toContainText('Upcoming.md');
   await page.evaluate(()=>{window.historyPreviewError=true;});
   await selectHistoryFile('Upcoming.md');
   await expect(historyRoot.locator('.crate-history-preview-output')).toContainText('Historical preview is offline');
   await page.evaluate(()=>{window.historyPreviewError=false;});
   await historyRoot.getByRole('button',{name:'Retry preview',exact:true}).click();
   await expect(historyRoot.getByRole('region')).toContainText('# After Upcoming.md');
   await page.mouse.move(0,0);
   for(const name of ['File history','Restore to this point']) {
    const action=historyRoot.getByRole('button',{name,exact:true});
    await expect(action).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
    await expect(action).toHaveCSS('box-shadow','none');
    await expect(action).toHaveCSS('border-top-style','solid');
   }
   await openPoint('12345678');
   const stateModal = page.locator('.crate-history-restore-modal');
   await expect(stateModal.getByRole('heading',{name:'Restore vault?',exact:true})).toBeVisible();
   await expect(stateModal).toContainText('3 files will change · 12 unchanged');
   await expect(stateModal).toContainText('Files excluded from sync stay untouched.');
   await expect(stateModal).toContainText('Restore point 12345678');
   await expect(stateModal.locator('nav, .crate-history-preview-pane')).toHaveCount(0);
   assert.equal(await page.evaluate(()=>window.stateFilePreviews),0);
   assert.equal(await page.evaluate(()=>window.stateRestores),0);
   assert.equal((await stateModal.boundingBox()).width,Math.min(380,width-32));
   await expect(stateModal.getByRole('button',{name:'Restore',exact:true})).toBeEnabled();
   await page.screenshot({path:'.generated/file-history/'+browserType.name()+'-'+width+'-'+theme+'-state-restore.png'});
   await stateModal.getByRole('button',{name:'Cancel',exact:true}).click();
   await expect(stateModal).toHaveCount(0);
   assert.equal(await page.evaluate(()=>window.stateRestores),0);
   await openPoint('abcdef12');
   await expect(stateModal).toContainText('Restore point abcdef12');
   await stateModal.getByRole('button',{name:'Cancel',exact:true}).click();
   await page.evaluate(()=>{window.statePreviewError=true;});
   await openPoint('12345678');
   await expect(stateModal).toContainText('This version is no longer available');
   await expect(stateModal.getByRole('button',{name:'Restore',exact:true})).toHaveCount(0);
   await page.evaluate(()=>{window.statePreviewError=false;});
   await stateModal.getByRole('button',{name:'Try again',exact:true}).click();
   await expect(stateModal).toContainText('3 files will change · 12 unchanged');
   await stateModal.getByRole('button',{name:'Cancel',exact:true}).click();
   await page.evaluate(()=>{window.stateCheckDelay=true;});
   await openPoint('12345678');
   await expect(stateModal).toContainText('Checking files and available versions');
   await expect(stateModal.getByRole('button',{name:'Restore',exact:true})).toBeDisabled();
   await stateModal.getByRole('button',{name:'Cancel',exact:true}).click();
   await page.evaluate(()=>window.releaseStateCheck());
   await expect(stateModal).toHaveCount(0);
   assert.equal(await page.evaluate(()=>window.stateRestores),0);
   await page.evaluate(()=>{window.stateNoChanges=true;});
   await openPoint('12345678');
   await expect(stateModal).toContainText('Your synced files already match this state.');
   await expect(stateModal.getByRole('button',{name:'Restore',exact:true})).toBeDisabled();
   await stateModal.getByRole('button',{name:'Cancel',exact:true}).click();
   await page.evaluate(()=>{window.stateNoChanges=false;window.stateRestoreError=true;});
   await openPoint('12345678');
   await stateModal.getByRole('button',{name:'Restore',exact:true}).click();
   await expect(stateModal).toContainText('Restore failed');
   assert.equal(await page.evaluate(()=>window.stateRestores),1);
   await page.evaluate(()=>{window.stateRestoreError=false;});
   const checks=await page.evaluate(()=>window.stateChecks);
   await stateModal.getByRole('button',{name:'Try again',exact:true}).click();
   await expect(stateModal.getByRole('button',{name:'Restore',exact:true})).toBeEnabled();
   assert.equal(await page.evaluate(()=>window.stateChecks),checks+1);
   assert.equal(await page.evaluate(()=>window.stateRestores),1);
   await stateModal.getByRole('button',{name:'Restore',exact:true}).click();
   await expect(stateModal.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
   await expect(stateModal.getByRole('button',{name:'Restore',exact:true})).toBeDisabled();
   await expect(stateModal.getByRole('button',{name:'Close dialog',exact:true})).toBeDisabled();
   await page.evaluate(()=>window.restoreModal.close());
   await expect(stateModal).toBeVisible();
   assert.equal(await page.evaluate(()=>window.stateRestores),2);
   await page.evaluate(()=>window.finishStateRestore());
   await expect(stateModal).toHaveCount(0);
   await expect(historyRoot).toBeVisible();
   await historyRoot.getByRole('button',{name:'Close dialog',exact:true}).click();
   await expect(historyRoot).toHaveCount(0);
   await expect(activityRoot).toBeVisible();
   await expect(browseVault).toBeFocused();
   assert.deepEqual(errors,[]);await page.close();
  }
 } finally {await browser.close();}
}
console.log('File history: Chromium and WebKit, desktop/mobile, light/dark, history, current files, keyboard, previews, deleted files, retry and confirmed restore passed.');
