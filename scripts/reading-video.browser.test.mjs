import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';

const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ReadingReader } from './src/reading/ui/Reader';
import { ThemeIconProvider } from './src/ui/shared/ThemeIcon';
import { PwaThemeIcon } from './src/pwa/components/PwaThemeIcon';
import { adoptReadingClip, parseReadingNote, updateReadingNote } from './src/reading/core/notes';
import { readReadingFrontmatter } from './src/reading/core/frontmatter';
let root, note, shadowRoot;
window.mount = async (shadow, css) => {
  if(root) flushSync(()=>root.unmount());
  document.body.replaceChildren(); document.body.style.margin='0'; window.saved=undefined;
  const host=document.createElement('div'); document.body.append(host);
  const container=shadow?host.attachShadow({mode:'open'}):host; shadowRoot=container;
  const style=document.createElement('style');style.textContent=css;container.append(style);
  const mount=document.createElement('div');mount.className='crate-reminders-ui';mount.style.height='100vh';container.append(mount);root=createRoot(mount);
  style.textContent += 'body{margin:0}.crate-reminders-ui{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#7c3aed;--crate-app-bg:#fff;background:var(--background-primary);color:var(--text-normal);font-family:system-ui}';
  note=await adoptReadingClip('---\\ntitle: Learning from a video\\nsource: https://youtu.be/jNQXAC9IVRw?t=12\\n---\\n## Transcript\\n\\n**0:12** · First useful passage.\\n\\n**0:42** · Another thoughtful passage.\\n\\n**1:02** · A closing thought.\\n', 'Reading/video.md','2026-10-04T10:00:00Z');
  note += Array.from({length:30},(_,i)=>'\\n\\n**'+Math.floor((82+i*20)/60)+':'+String((82+i*20)%60).padStart(2,'0')+'** · Further passage '+i+' with enough words to read while the video continues.').join('');
  const render=()=>flushSync(()=>root.render(<ThemeIconProvider renderer={PwaThemeIcon}><ReadingReader item={parseReadingNote(note)} markdown={readReadingFrontmatter(note).body} onBack={()=>{}} onUpdate={async changes=>{note=updateReadingNote(note,parseReadingNote(note).crate_reading_id,changes);window.saved=note;window.highlightCount=parseReadingNote(note).highlights?.length??0;render();}}/></ThemeIconProvider>));
  window.revise=body=>{note=note.slice(0,note.length-readReadingFrontmatter(note).body.length)+body;render();};
  window.unmount=()=>flushSync(()=>root.unmount());render();
  const reader=mount.querySelector('.crate-reading-reader');
  if(!shadow){reader.dataset.documentScroll='true';reader.style.height='auto';reader.style.overflow='visible';mount.style.height='auto';}
  window.reader=reader;window.scrollOwner=shadow?reader:document.scrollingElement;
};
` }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.scss': 'empty' } });
const css = await readFile(process.env.CRATE_PLUGIN_CSS_PATH ?? 'dist/styles.css', 'utf8');
const selectionPoints = paragraph => paragraph.evaluate(node=>{
        const text=[...node.childNodes].find(n=>n.nodeType===3&&n.textContent.includes('Another'));
        const start=text.textContent.indexOf('Another'),end=start+'Another thoughtful passage.'.length;
        const range=document.createRange();range.setStart(text,start);range.setEnd(text,start+1);const first=range.getBoundingClientRect();
        range.setStart(text,end-1);range.setEnd(text,end);const last=range.getBoundingClientRect();
        return {from:{x:first.left+0.5,y:first.top+first.height/2},to:{x:last.right-0.5,y:last.top+last.height/2}};
});
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true });
    const errors=[];page.on('pageerror', error=>errors.push(error.message));
    await page.route('**/*', route => {
      const url=route.request().url();
      if(url==='https://reader.test/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html class="theme-light"><body></body></html>'});
      if(url.startsWith('https://www.youtube-nocookie.com/embed/')) return route.fulfill({contentType:'text/html',body:`<html><body><script>
        window.commands=[];
        window.time=seconds=>parent.postMessage(JSON.stringify({event:'infoDelivery',info:{currentTime:seconds}}),'https://reader.test');
        addEventListener('message',e=>{const data=JSON.parse(e.data);if(data.event==='listening') parent.postMessage(JSON.stringify({event:'initialDelivery',info:{currentTime:0}}),'https://reader.test');if(data.event==='command'){commands.push(data);if(data.func==='seekTo')window.time(data.args[0]);}});
      </script></body></html>`});
      return route.abort();
    });
    await page.goto('https://reader.test/');await page.addScriptTag({content:bundle.outputFiles[0].text});
    for(const shadow of [false,true]) {
      await page.evaluate(({shadow,css})=>window.mount(shadow,css),{shadow,css});
      const body=page.locator('.crate-reading-reader__body');
      await expect(body.locator('[data-transcript-seconds]')).toHaveCount(33);
      const text=await body.textContent();
      await expect(page.locator('iframe')).toHaveCount(0);
      await expect(body.locator('p').nth(1)).toHaveCSS('cursor','pointer');
      await expect(page.getByRole('button',{name:'Unpin video',exact:true})).toHaveCSS('border-top-style','solid');
      await expect(page.getByRole('link',{name:'Open in YouTube',exact:true})).toHaveCount(0);
      await body.locator('p').nth(1).tap({position:{x:140,y:30}});
      await expect(page.locator('iframe')).toHaveAttribute('src',/start=42/);
      await expect.poll(()=>page.frames().some(frame=>frame.url().includes('youtube-nocookie'))).toBe(true);
      const player=page.frames().find(frame=>frame.url().includes('youtube-nocookie'));
      await expect.poll(()=>player.evaluate(()=>window.commands?.length??0)).toBeGreaterThan(0);
      await player.evaluate(()=>window.time(44));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','42');
      await page.locator('iframe').evaluate(frame=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'https://attacker.invalid',data:JSON.stringify({event:'infoDelivery',info:{currentTime:62}})})));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','42');
      await body.getByRole('button',{name:'Seek to 1:02',exact:true}).press('Enter');
      await expect.poll(()=>player.evaluate(()=>window.commands.some(command=>command.func==='seekTo'&&command.args[0]===62))).toBe(true);
      await expect(page.getByRole('button',{name:'Unpin video',exact:true})).toHaveAttribute('aria-pressed','true');
      await expect.poll(()=>player.evaluate(()=>window.commands.some(command=>command.func==='playVideo'))).toBe(true);
      await expect(page.locator('.crate-reading-video')).toHaveCSS('position','sticky');
      await expect(page.getByText('Playback needs an internet connection.',{exact:true})).toHaveCount(0);
      await page.locator('iframe').evaluate(frame=>window.initialPlayer=frame.contentWindow);
      await page.getByRole('button',{name:'Unpin video',exact:true}).click();
      await expect(page.locator('.crate-reading-video')).toHaveCSS('position','static');
      await page.evaluate(()=>window.scrollOwner.scrollTop=800);
      const readTop=await page.evaluate(()=>window.scrollOwner.scrollTop);
      await player.evaluate(()=>window.time(482));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','482');
      assert.equal(await page.evaluate(()=>window.scrollOwner.scrollTop),readTop,'Unpinned video must not move the reading position');
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      assert.equal(await page.locator('iframe').evaluate(frame=>window.initialPlayer===frame.contentWindow),true,'Pinning must preserve the player');
      await player.evaluate(()=>window.time(42));
      // A tap on words (not the timestamp) seeks too.
      await player.evaluate(()=>window.commands=[]);
      await body.locator('p').nth(2).tap({position:{x:140,y:30}});
      await expect.poll(()=>player.evaluate(()=>window.commands.some(command=>command.func==='seekTo'&&command.args[0]===62))).toBe(true);
      await expect.poll(()=>player.evaluate(()=>window.commands.some(command=>command.func==='playVideo'))).toBe(true);
      await player.evaluate(()=>{window.commands=[];window.time(42);});
      assert.equal(await body.textContent(),text,'Playback must not change highlight offsets');
      // Preserve real text selection/highlighting after decorating timestamps.
      const paragraph=body.locator('p').nth(1);
      await paragraph.scrollIntoViewIfNeeded();
      const points=await selectionPoints(paragraph);
      await page.mouse.move(points.from.x,points.from.y);await page.mouse.down();
      const heldTop=await page.evaluate(()=>window.scrollOwner.scrollTop);
      await player.evaluate(()=>window.time(482));
      assert.equal(await page.evaluate(()=>window.scrollOwner.scrollTop),heldTop,'Playback must not move text during selection');
      await page.mouse.move(points.to.x,points.to.y,{steps:12});await page.mouse.up();
      await expect.poll(()=>page.evaluate(()=>window.saved??'')).toContain('==Another thoughtful passage.==');
      await expect.poll(()=>page.evaluate(()=>window.highlightCount)).toBe(1);
      await expect.poll(()=>player.evaluate(()=>window.commands.some(command=>command.func==='seekTo'&&command.args[0]===42))).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'Unpin video',exact:true}).click();
      await player.evaluate(()=>window.commands=[]);
      await body.getByRole('button',{name:'Highlight options'}).click();
      await expect.poll(()=>player.evaluate(()=>window.commands.some(command=>command.func==='seekTo'&&command.args[0]===42))).toBe(true);
      await expect.poll(()=>player.evaluate(()=>window.commands.some(command=>command.func==='playVideo'))).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      await page.getByRole('button',{name:/^Highlights/}).click();
      await expect(page.getByRole('button',{name:'Seek to 0:42',exact:true})).toBeVisible();
      await expect(page.getByRole('link',{name:'Open moment on YouTube'})).toHaveAttribute('href',/t=42s$/);
      await page.getByRole('button',{name:'Transcript',exact:true}).click();
      await expect(body.locator('[data-transcript-seconds]')).toHaveCount(33);
      await page.keyboard.press('Escape');
      // Playback and scrubbing animate only the correct scroll owner.
      await page.emulateMedia({reducedMotion:'no-preference'});
      await player.evaluate(()=>window.time(42));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','42');
      await page.evaluate(()=>window.scrollOwner.scrollTo({top:window.scrollOwner.scrollTop,behavior:'instant'}));
      const before=await page.evaluate(()=>window.scrollOwner.scrollTop);
      await player.evaluate(()=>window.time(482));
      const samples=await page.evaluate(async()=>{const values=[];for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);values.push(window.scrollOwner.scrollTop);}return values;});
      assert(samples.some(value=>value>before+2),'Pinned video must follow a video scrub');
      assert(new Set(samples.map(Math.round)).size>3,'Following must animate through intermediate positions');
      await expect.poll(()=>body.locator('[data-playing]').evaluate(node=>node.getBoundingClientRect().top)).toBeLessThan(780);
      const geometry=await body.locator('[data-playing]').evaluate(node=>({top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,player:node.getRootNode().querySelector('.crate-reading-video').getBoundingClientRect().bottom}));
      assert(geometry.top>=geometry.player,'Current text must remain below the player');
      assert(geometry.top<844-64,'Current text must remain in the reading area');
      if(shadow) assert.equal(await page.evaluate(()=>document.scrollingElement.scrollTop),0,'Plugin follow must not scroll its host document');
      // Retarget before a long animated seek settles, then stop it by unpinning.
      await player.evaluate(()=>window.time(62));
      await player.evaluate(()=>window.time(282));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','282');
      await page.getByRole('button',{name:'Unpin video',exact:true}).click();
      await page.evaluate(()=>window.scrollOwner.scrollTop=700);
      await player.evaluate(()=>window.time(602));
      assert.equal(await page.evaluate(()=>window.scrollOwner.scrollTop),700);
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      await player.evaluate(()=>window.time(182));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','182');
      const reduced=await page.evaluate(async()=>{const values=[];for(let i=0;i<5;i++){await new Promise(requestAnimationFrame);values.push(window.scrollOwner.scrollTop);}return values;});
      assert.equal(new Set(reduced.map(Math.round)).size,1,'Reduced motion must settle immediately');
      await mkdir('.generated/reading-video-review',{recursive:true});
      await page.screenshot({path:`.generated/reading-video-review/${name}-${shadow?'plugin':'pwa'}.png`,fullPage:true});
      console.log(`${name} ${shadow?'Shadow DOM':'document'} complete`);
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.evaluate(()=>{window.scrollWrites=0;const owner=window.scrollOwner,original=owner.scrollTo.bind(owner);owner.scrollTo=(...args)=>{window.scrollWrites++;original(...args);};});
      await player.evaluate(()=>window.time(602));
      await page.evaluate(async()=>{for(let i=0;i<3;i++)await new Promise(requestAnimationFrame);window.unmount();});
      const writes=await page.evaluate(()=>window.scrollWrites);
      await page.evaluate(async()=>{for(let i=0;i<12;i++)await new Promise(requestAnimationFrame);});
      assert.equal(await page.evaluate(()=>window.scrollWrites),writes,'Unmount must cancel an active follow animation');
      await expect(page.locator('iframe')).toHaveCount(0);
      // Starting with a text selection must load the player and preserve the highlight.
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.evaluate(({shadow,css})=>window.mount(shadow,css),{shadow,css});
      await page.getByRole('button',{name:'Unpin video',exact:true}).click();
      await expect(page.locator('iframe')).toHaveCount(0);
      const fresh=page.locator('.crate-reading-reader__body p').nth(1);
      await fresh.scrollIntoViewIfNeeded();
      const initial=await selectionPoints(fresh);
      await page.mouse.move(initial.from.x,initial.from.y);await page.mouse.down();
      await page.mouse.move(initial.to.x,initial.to.y,{steps:12});await page.mouse.up();
      await expect(page.locator('iframe')).toHaveAttribute('src',/start=42/);
      await expect.poll(()=>page.evaluate(()=>window.saved??'')).toContain('==Another thoughtful passage.==');
      await expect.poll(()=>page.frames().some(frame=>frame.url().includes('youtube-nocookie'))).toBe(true);
      const freshPlayer=page.frames().find(frame=>frame.url().includes('youtube-nocookie'));
      await expect.poll(()=>freshPlayer.evaluate(()=>window.commands?.some(command=>command.func==='playVideo'))).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      await page.locator('.crate-reminders-ui').evaluate(root=>{for(const [name,value] of Object.entries({'--background-primary':'#1e1e1e','--background-secondary':'#303030','--text-normal':'#eee','--text-muted':'#aaa','--interactive-accent':'#a991ff','--crate-app-bg':'#1e1e1e'}))root.style.setProperty(name,value);});
      await freshPlayer.evaluate(()=>window.time(182));
      const pin=page.getByRole('button',{name:'Unpin video',exact:true});
      await expect(pin).toHaveCSS('color','rgb(238, 238, 238)');
      await expect(pin).toHaveCSS('border-top-color','rgb(169, 145, 255)');
      assert((await pin.boundingBox()).height>=44,'Pin remains a visible touch target');
      await page.screenshot({path:`.generated/reading-video-review/${name}-${shadow?'plugin':'pwa'}-dark.png`});
      // Resizing breaks out of the text column without reloading the player.
      await page.setViewportSize({width:1440,height:1200});
      const resize=page.getByRole('separator',{name:'Resize video'}), video=page.locator('iframe');
      await expect(resize).toHaveCSS('cursor','ns-resize');
      await video.evaluate(frame=>window.resizedPlayer=frame.contentWindow);
      const textWidth=(await body.boundingBox()).width;
      await resize.press('End');
      await expect(resize).toHaveAttribute('aria-valuenow','100');
      const full=await video.boundingBox(), readerBounds=await page.locator('.crate-reading-reader').boundingBox();
      const available=await page.locator('.crate-reading-reader').evaluate(node=>node.clientWidth);
      assert(Math.abs(full.width-available)<2,'Video can fill the reader width');
      assert(Math.abs(full.width/full.height-16/9)<.02,'Full-width video keeps its proportions');
      assert(full.x>=readerBounds.x-1&&full.x+full.width<=readerBounds.x+readerBounds.width+1,'Video stays within the reader');
      assert.equal((await body.boundingBox()).width,textWidth,'Transcript retains its reading width');
      assert.equal(await video.evaluate(frame=>window.resizedPlayer===frame.contentWindow),true,'Resizing must keep the existing player');
      await freshPlayer.evaluate(()=>window.time(222));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','222');
      await expect(page.locator('.crate-reading-video')).toHaveAttribute('data-pinned','true');
      await page.screenshot({path:`.generated/reading-video-review/${name}-${shadow?'plugin':'pwa'}-wide.png`});
      // Mouse drag follows the handle directly, including over the iframe.
      await resize.press('Home');
      const small=await video.boundingBox();
      assert(Math.abs(small.width-240)<2);
      // A small pinned player still owns the full horizontal band above the
      // transcript. Hidden passage edges must not remain visible or clickable.
      await freshPlayer.evaluate(()=>window.time(242));
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','242');
      await expect.poll(()=>body.locator('[data-playing]').evaluate(node=>
        node.getBoundingClientRect().top-node.getRootNode().querySelector('.crate-reading-video').getBoundingClientRect().bottom)).toBeGreaterThan(15);
      const covered=await body.evaluate(node=>{
        const root=node.getRootNode(),band=root.querySelector('.crate-reading-video').getBoundingClientRect();
        const nav=root.querySelector('.crate-reading-reader__nav').getBoundingClientRect(),text=node.getBoundingClientRect();
        const row=[...node.querySelectorAll('[data-transcript-seconds]')].map(p=>p.getBoundingClientRect()).find(rect=>rect.bottom>nav.bottom+16&&rect.top<band.bottom-16);
        if(!row)throw new Error('Expected earlier transcript text behind the pinned area');
        const y=Math.max(nav.bottom+12,Math.min(band.bottom-12,row.top+12));
        return [text.left+10,text.right-10].map(x=>({x,y,exposed:Boolean(root.elementFromPoint(x,y)?.closest('[data-transcript-seconds]'))}));
      });
      await page.screenshot({path:`.generated/reading-video-review/${name}-${shadow?'plugin':'pwa'}-small-pinned.png`});
      assert(covered.every(point=>!point.exposed),'Transcript must not show through either side of a small pinned player');
      const seeksBefore=await freshPlayer.evaluate(()=>window.commands.filter(command=>command.func==='seekTo').length);
      for(const point of covered)await page.mouse.click(point.x,point.y);
      assert.equal(await freshPlayer.evaluate(()=>window.commands.filter(command=>command.func==='seekTo').length),seeksBefore,'The pinned area must block clicks on covered transcript text');
      await resize.scrollIntoViewIfNeeded();
      let grip=await resize.boundingBox();
      await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await page.mouse.down();
      await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2+110,{steps:8});
      assert((await video.boundingBox()).width>small.width+150,'Dragging down enlarges the video');
      await page.mouse.up();
      const dragged=await video.boundingBox();
      grip=await resize.boundingBox();
      await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await page.mouse.down();
      await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2-60,{steps:6});
      await page.keyboard.press('Escape');await page.mouse.up();
      assert(Math.abs((await video.boundingBox()).width-dragged.width)<2,'Escape restores the previous size');
      // Native touch dispatch verifies that a resize does not pan the document.
      if(name==='chromium'){
        const input=await page.context().newCDPSession(page);grip=await resize.boundingBox();
        const start={x:grip.x+grip.width/2,y:grip.y+grip.height/2};
        const top=await page.evaluate(()=>window.scrollOwner.scrollTop);
        try{
          await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
          await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:start.y+60}]});
          await expect.poll(async()=>(await video.boundingBox()).width).toBeGreaterThan(dragged.width+70);
          assert.equal(await page.evaluate(()=>window.scrollOwner.scrollTop),top,'Touch resize must not scroll the reader');
          await input.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
          await expect.poll(async()=>Math.abs((await video.boundingBox()).width-dragged.width)).toBeLessThan(2);
          assert.equal(await page.evaluate(()=>window.scrollOwner.scrollTop),top,'Canceling resize must preserve the reader position');
          await expect(page.locator('.crate-reading-reader')).not.toHaveClass(/resizing-video/);
        }finally{await input.detach();}
      }
      await resize.dblclick();
      await expect.poll(async()=>(await video.boundingBox()).width).toBeGreaterThan(dragged.width);
      // A screen-filling landscape video must allow scrolling down to its handle.
      await resize.press('End');
      await page.setViewportSize({width:1000,height:500});
      await expect(page.locator('.crate-reading-video')).toHaveAttribute('data-pinned','false');
      await expect(page.getByRole('button',{name:'Pin video',exact:true})).toBeEnabled();
      await resize.scrollIntoViewIfNeeded();await expect(resize).toBeInViewport();
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      await expect(page.getByRole('button',{name:'Unpin video',exact:true})).toBeEnabled();
      const fitted=await video.boundingBox();
      assert(fitted.width<900&&fitted.width>240,'Pinning shrinks the oversized video only as much as needed');
      const room=await page.locator('.crate-reading-video').evaluate(node=>500-parseFloat(getComputedStyle(node).top)-node.offsetHeight);
      assert(room>=96&&room<=100,'Pinning leaves transcript space without unnecessarily shrinking the video');
      assert.equal(await video.evaluate(frame=>window.resizedPlayer===frame.contentWindow),true,'Fitting to pin preserves the playing iframe');
      await page.getByRole('button',{name:'Unpin video',exact:true}).click();
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      assert(Math.abs((await video.boundingBox()).width-fitted.width)<1,'Pinning a video that already fits preserves its size');
      await page.getByRole('button',{name:'Unpin video',exact:true}).click();
      await resize.press('End');
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      await expect(page.locator('.crate-reading-video')).toHaveAttribute('data-pinned','true');
      assert(Math.abs((await video.boundingBox()).width-fitted.width)<2,'Explicitly unpinned videos can also fit and pin');
      await page.setViewportSize({width:390,height:844});
      await resize.press('End');
      await expect.poll(async()=>(await video.boundingBox()).width).toBeLessThanOrEqual(390);
      assert.equal(await video.evaluate(frame=>window.resizedPlayer===frame.contentWindow),true);
      await page.evaluate(()=>window.unmount());

      // Starting playback at the pinning boundary must not toggle sticky layout
      // on every ResizeObserver delivery (including in Obsidian's Shadow DOM).
      await page.setViewportSize({width:1248,height:980});
      await page.evaluate(({shadow,css})=>window.mount(shadow,css),{shadow,css});
      await page.evaluate(()=>window.revise('## Transcript\n\n'+Array.from({length:30},(_,i)=>
        '**'+Math.floor(i*7/60)+':'+String(i*7%60).padStart(2,'0')+'** · A longer transcript passage with enough words to wrap below a large video.').join('\n\n')));
      await resize.press('End');
      await expect(page.locator('.crate-reading-video')).toHaveAttribute('data-pinned','false');
      const previewBounds=await page.locator('.crate-reading-video').boundingBox();
      await page.locator('[data-transcript-seconds="7"]').click({position:{x:150,y:25}});
      await expect(video).toHaveAttribute('src',/start=7/);
      await expect(body.locator('[data-playing]')).toHaveAttribute('data-transcript-seconds','7');
      const pinStates=await page.locator('.crate-reading-video').evaluate(async node=>{
        const states=[];for(let i=0;i<40;i++){await new Promise(requestAnimationFrame);states.push(node.dataset.pinned);}return states;
      });
      assert.equal(new Set(pinStates).size,1,'Starting playback must not oscillate between pinned and unpinned');
      const playingBounds=await page.locator('.crate-reading-video').boundingBox();
      assert(Math.abs(previewBounds.height-playingBounds.height)<1,'Starting playback must preserve the preview layout height');
      assert(Math.abs(previewBounds.width-playingBounds.width)<1,'Starting playback must preserve the chosen width');
      await expect(body.locator('[data-playing]')).toBeInViewport();
      const threshold=await page.locator('.crate-reading-video').evaluate(node=>node.offsetHeight+parseFloat(getComputedStyle(node).getPropertyValue('--reading-video-top'))+96);
      for(const extra of [-1,0,1]){
        await page.setViewportSize({width:1248,height:threshold+extra});
        await expect(page.locator('.crate-reading-video')).toHaveAttribute('data-pinned',String(extra>=0));
        const states=await page.locator('.crate-reading-video').evaluate(async node=>{
          const values=[];for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);values.push(node.dataset.pinned);}return values;
        });
        assert(states.every(value=>value===String(extra>=0)),'Pinning must settle on either side of its height boundary');
      }
      // An unopened video can fit below the usual drag minimum in a short window.
      await page.setViewportSize({width:1000,height:390});
      await page.evaluate(({shadow,css})=>window.mount(shadow,css),{shadow,css});
      await resize.press('End');
      await page.getByRole('button',{name:'Pin video',exact:true}).click();
      await expect(page.getByRole('button',{name:'Unpin video',exact:true})).toBeEnabled();
      await expect(video).toHaveCount(0);
      const fittedPreview=await page.locator('.crate-reading-video__watch').boundingBox();
      assert(fittedPreview.width<240,'Short screens can fit below the normal resize minimum');
      await page.getByRole('button',{name:'Play video',exact:true}).click();
      await expect(video).toBeVisible();
      await expect(page.locator('.crate-reading-video')).toHaveAttribute('data-pinned','true');
      assert(Math.abs((await video.boundingBox()).width-fittedPreview.width)<1,'Starting playback preserves the fitted preview size');
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(()=>window.unmount());
    }
    assert.deepEqual(errors,[]);
    console.log(`${name}: document and Shadow DOM playback, tapping, selection seeking, pinning/unpinning, resizing, smooth/reduced scrolling, highlights, and cleanup passed`);
  } finally { await browser.close(); }
}
