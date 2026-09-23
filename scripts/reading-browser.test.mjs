import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`Reading ${name}: enroll, save, cached reader, offline change, phone confirmation and logout`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-browser-')); let runtime, browser, server, loseCaptureReply = false, holdArticle; const sent = [];
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Browser test');
    server = createServer(async (req, res) => {
      try {
        if (req.url === '/notifications/test-share') { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<!doctype html><title>Share fixture</title><body>Share fixture</body>'); return; }
        const chunks=[]; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method:req.method, headers:req.headers, ...(['GET','HEAD'].includes(req.method) ? {} : { body:Buffer.concat(chunks) }) });
        if (req.url.startsWith('/reading/item?') && holdArticle) { const held = holdArticle; holdArticle = null; held.started(); await held.release; }
        if (req.url === '/reading/capture') { sent.push(Buffer.concat(chunks).toString()); if (loseCaptureReply) { loseCaptureReply = false; res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:"Save acknowledgement interrupted"})); return; } }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end('Test server failed'); }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const origin=`http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response=await runtime.mf.dispatchFetch(`${origin}${path}`, {method:'POST',headers:{Authorization:`Bearer ${vault.token}`,'X-Crate-Protocol':'11','Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());return response.json();
    };
    await api('/reading/policy',{enabled:true,folderPath:'Reading',revision:null});
    const enrollment=await api('/reading/access',{kind:'reading'});
    browser=await engine.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page=await context.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(enrollment.url); await page.getByRole('heading',{name:'Reading',exact:true}).waitFor();
    assert.equal(await page.locator('.crate-feature-nav').count(), 0);
    await page.getByRole('searchbox',{name:'Search reading'}).fill('kept while switching');
    await page.getByRole('button',{name:'Switch to Reminders',exact:true}).click();
    await page.getByRole('heading',{name:'Connect to Crate',exact:true}).waitFor();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Switch to Reading',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'Switch to Reading',exact:true}).click();
    await expect(page.getByRole('searchbox',{name:'Search reading'})).toHaveValue('kept while switching');
    await expect(page.getByRole('button',{name:'Switch to Reminders',exact:true})).toBeFocused();
    assert.equal(new URL(page.url()).searchParams.get('section'),'reading');
    await page.getByRole('searchbox',{name:'Search reading'}).fill('');
    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await page.getByLabel('Link',{exact:true}).fill('https://example.invalid/browser');
    await page.getByLabel('Title (optional)').fill('A browser article');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await page.getByRole('button',{name:/example.invalid A browser article/}).waitFor();
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await page.goForward();
    await page.getByRole('heading',{name:'A browser article',exact:true}).waitFor();
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    // A slow Forward request must not reopen the reader after a subsequent Back.
    const started = Promise.withResolvers(), released = Promise.withResolvers();
    holdArticle = { started: started.resolve, release: released.promise };
    await page.goForward(); await started.promise; await page.goBack();
    const responseReceived = page.waitForResponse(response => response.url().includes('/reading/item?'));
    released.resolve(); await responseReceived;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('searchbox',{name:'Search reading'})).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.has('item'), false);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // Playwright WebKit cannot navigate while setOffline(true) on this macOS build.
    // Chromium exercises cold offline launch; WebKit verifies the cached shell and in-place offline reading.
    assert.equal(await page.evaluate(async () => !!await caches.match('/notifications')), true);
    await context.setOffline(true); if (name === 'chromium') await page.reload();
    await page.getByRole('button',{name:/example.invalid A browser article/}).waitFor();
    await page.getByRole('button',{name:/example.invalid A browser article/}).click();
    await page.getByText('Available offline',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Back to reading',exact:true}).click();
    await page.getByRole('button',{name:'Favorite',exact:true}).click();
    await page.getByText('1 pending change',{exact:true}).waitFor();
    await context.setOffline(false); await page.getByRole('button',{name:'Retry saved changes'}).click();
    await page.getByRole('button',{name:'Remove favorite',exact:true}).waitFor();
    const pending = await page.getByText('1 pending change',{exact:true}).count(); assert.equal(pending,0);
    // A committed save with a lost response must resend exactly the persisted operation.
    sent.length = 0; loseCaptureReply = true;
    await page.getByRole('button',{name:'Save a link',exact:true}).click();
    await page.getByLabel('Link',{exact:true}).fill('https://example.invalid/lost-reply');
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await expect.poll(() => page.evaluate(async () => { const db = await new Promise((resolve,reject) => { const r=indexedDB.open('crate-reading-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject; }); const id=JSON.parse(localStorage.getItem('crate-reading-session-v1')).id;return new Promise(resolve=>{const r=db.transaction('values').objectStore('values').get(`pending:${id}`);r.onsuccess=()=>{db.close();resolve(r.result?.some(op=>op.action==='capture' && op.error));};}); })).toBeTruthy();
    await page.getByRole('button',{name:'Retry saved changes'}).click();
    await expect.poll(() => page.evaluate(async () => { const db = await new Promise((resolve,reject) => { const r=indexedDB.open('crate-reading-v1',1); r.onsuccess=()=>resolve(r.result);r.onerror=reject; }); const id=JSON.parse(localStorage.getItem('crate-reading-session-v1')).id; return new Promise(resolve=>{ const r=db.transaction('values').objectStore('values').get(`pending:${id}`);r.onsuccess=()=>{db.close();resolve(r.result.length===0);}; }); })).toBe(true);
    assert.ok(sent.length >= 2, JSON.stringify({ sent, text: await page.locator('body').innerText() })); assert.equal(sent[0],sent[1]);
    if (name === 'chromium') {
      await page.goto(`${origin}/notifications/test-share`); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.evaluate(() => { const form=document.createElement('form');form.method='POST';form.action='/notifications/share/reading';for (const [name,value] of Object.entries({url:'https://example.invalid/android',title:'Android share'})){const input=document.createElement('input');input.name=name;input.value=value;form.append(input);}document.body.append(form);form.submit(); });
      await page.waitForURL(/share=/);
      await page.getByLabel('Link',{exact:true}).waitFor(); assert.equal(await page.getByLabel('Link',{exact:true}).inputValue(),'https://example.invalid/android');
      await page.getByRole('button',{name:'Save link',exact:true}).click(); await page.getByText('1 pending change',{exact:true}).waitFor();
      await context.setOffline(false); await page.getByRole('button',{name:'Retry saved changes'}).click(); await page.getByRole('button',{name:/example.invalid Android share/}).waitFor();
    }
    const fresh = await browser.newContext({serviceWorkers:'block'}), shared = await fresh.newPage();
    await shared.goto(`${origin}/notifications/test-share`);
    await shared.evaluate(() => { const form=document.createElement('form');form.method='POST';form.action='/notifications/share/reading';const input=document.createElement('input');input.name='url';input.value='https://example.invalid/first-share';form.append(input);document.body.append(form);form.submit(); });
    await shared.getByText('Your shared link is kept on this device.',{exact:false}).waitFor(); await fresh.close();
    await mkdir('test-results/reading',{recursive:true}); await page.screenshot({path:`test-results/reading/${name}-library.png`,fullPage:true});
    const prepared=await api('/reading/prepare',{url:'https://example.invalid/phone',title:'Phone article'});
    const phone=await context.newPage(); await phone.goto(prepared.launchUrl);
    await phone.getByRole('heading',{name:'Saved to Crate ✓'}).waitFor(); assert.equal(new URL(phone.url()).hash,'');
    await phone.screenshot({path:`test-results/reading/${name}-saved.png`,fullPage:true});
    await phone.reload(); await phone.getByRole('heading',{name:'Saved to Crate ✓'}).waitFor();
    await page.getByRole('button',{name:'Reading settings'}).click();
    await page.getByRole('button',{name:'Log out and clear device data'}).click();
    await page.getByRole('heading',{name:'Your reading, everywhere'}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reading-session-v1')),null);
    // An already enrolled Reminders PWA opens Reading with the same browser credential.
    await runtime.db.prepare('UPDATE reading_policy SET enabled=0').run();
    const remindersEnrollment = await api('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' });
    await page.goto(`${origin}/notifications?browserToken=${remindersEnrollment.browserToken}`);
    await page.waitForFunction(() => !!localStorage.getItem('crate-reminders-auth-token'));
    await page.goto(`${origin}/notifications?section=reading`);
    await page.getByText('Reading is disabled. Enable it in Crate settings.', { exact: false }).waitFor();
    await runtime.db.prepare('UPDATE reading_policy SET enabled=1').run();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('heading',{name:'Reading',exact:true}).waitFor();
    const linked = await page.evaluate(() => ({ reading: JSON.parse(localStorage.getItem('crate-reading-session-v1')), reminders: localStorage.getItem('crate-reminders-auth-token') }));
    assert.equal(linked.reading.source, 'reminders'); assert.equal(linked.reading.token, linked.reminders);
    await page.getByRole('button',{name:'Switch to Reminders',exact:true}).click();
    await page.getByRole('button',{name:'Switch to Reading',exact:true}).click();
    await page.getByRole('heading',{name:'Reading',exact:true}).waitFor();
    await page.getByRole('button',{name:'Reading settings'}).click();
    await page.getByRole('button',{name:'Log out and clear device data'}).click();
    await page.getByRole('heading',{name:'Your reading, everywhere'}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reminders-auth-token')), null);
    assert.equal(await page.evaluate(()=>localStorage.getItem('crate-reading-session-v1')), null);
    assert.equal((await runtime.mf.dispatchFetch(`${origin}/reading/session`, { headers: { Authorization: `Bearer ${linked.reminders}` } })).status, 401);
    assert.deepEqual(errors,[]);
  } catch (error) { await mkdir('test-results/reading',{recursive:true}); for (const context of browser?.contexts() ?? []) for (const page of context.pages()) { console.log('Reading failure page:',page.url(),(await page.locator('body').innerText().catch(()=>''))); await page.screenshot({path:`test-results/reading/${name}-failure.png`}).catch(()=>{}); } throw error; } finally { await browser?.close(); if(server) await new Promise(resolve=>server.close(resolve)); await runtime?.close(); await rm(dir,{recursive:true,force:true}); }
});
