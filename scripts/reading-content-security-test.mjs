import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

// Run the production reader and reminder card without CSP. This must pass even
// when browser policy cannot rescue the sanitizer, including in Obsidian's DOM.
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { ReadingReader } from './src/reading/ui/Reader';
  import { ReminderCard } from './src/reminders/components/ReminderCard';
  import { highlightReadingCode } from './src/reading/ui/code-highlighting';
  let root;
  const html = Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  window.articleHtmlWrites = 0;
  Object.defineProperty(Element.prototype,'innerHTML',{...html,set(value){
    if(this.classList.contains('crate-reading-reader__body')) window.articleHtmlWrites++;
    html.set.call(this,value);
  }});
  customElements.define('article-attack',class extends HTMLElement { connectedCallback(){window.articleAttack=true;} });
  window.mount = (markdown, shadow, hostileHighlighter=false) => {
    if(root) flushSync(()=>root.unmount());
    document.body.replaceChildren();
    const host=document.createElement('div');document.body.append(host);
    const container=shadow?host.attachShadow({mode:'open'}):host;
    root=createRoot(container);
    const item={crate_reading_version:1,crate_reading_id:'67de6c50-c70c-4c85-93f2-000000000001',
      title:'<img src=x onerror="window.articleAttack=true">',source_url:'https://example.invalid/article',saved_at:'2026-10-03T10:00:00Z',
      reading_status:'inbox',favorite:false,tags:[],extraction_status:'ready',capture_method:'web-clipper'};
    const reminder={id:'security-test',content:'<img src=x onerror="window.articleAttack=true"> [unsafe](javascript:alert%281%29) [safe](https://example.invalid/safe)',completed:false};
    const highlight=hostileHighlighter?text=>'<img src=x onerror="window.articleAttack=true"><span class="hljs-keyword" onclick="window.articleAttack=true">'+text+'</span>':highlightReadingCode;
    window.revise=markdown=>flushSync(()=>root.render(<><ReadingReader item={item} markdown={markdown} onBack={()=>{}} highlightCode={highlight}/><ReminderCard reminder={reminder} animationConfig={{enabled:false}}/></>));
    window.revise(markdown);
  };
` }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.scss': 'empty' },
});
const attack = 'window.articleAttack=true';
const cases = [
  `<script>${attack}</script><img src="https://tracking.invalid/pixel" onerror="${attack}"><p onclick="${attack}">Click me</p>`,
  `<svg onload="${attack}"><foreignObject><p onclick="${attack}">SVG</p></foreignObject></svg><math><mtext><img src=x onerror="${attack}"></mtext></math>`,
  `<iframe srcdoc="<script>${attack}</script>"></iframe><object data="https://tracking.invalid/active"></object><embed src="https://tracking.invalid/active"><base href="https://tracking.invalid/"><meta http-equiv="refresh" content="0;url=https://tracking.invalid/">`,
  `<style>@import url(https://tracking.invalid/style);</style><link rel="stylesheet" href="https://tracking.invalid/style"><form action="https://tracking.invalid/"><input autofocus onfocus="${attack}"><button formaction="javascript:${attack}">Send</button></form>`,
  `<a href="jav&#x61;script:${attack}">entity</a><a href="java&#10;script:${attack}">newline</a><a href="data:text/html,&lt;script&gt;${attack}&lt;/script&gt;">data</a><a href="vbscript:msgbox(1)">vb</a><a href="file:///tmp/test">file</a><a href="https://user:password@example.invalid/">credentials</a>`,
  `<p id="app" name="constructor" style="position:fixed;inset:0" data-user-content="x" tabindex="0" onpointerenter="${attack}">Clobber</p><article-attack>custom</article-attack><p is="article-attack">customized</p>`,
  `<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror='${attack}'>">`,
  `<svg></p><style><a id="</style><img src=x onerror='${attack}'>">`,
  `<table><caption><svg><desc><table><tbody><tr><td><style><!--</style><img title="--><img src=x onerror='${attack}'>">`,
  `<noscript><p title="</noscript><img src=x onerror='${attack}'>">x</p></noscript><template><img src=x onerror="${attack}"></template>`,
  '```html\n<img src=x onerror="window.articleAttack=true">\n```',
];
const benign = '# Safe heading\n\nA **useful** paragraph with a [relative link](/more).\n\n| A | B |\n| - | - |\n| One | Two |\n\n```js\nconst value = 1;\n```';
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().url() === 'https://reader.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
      requests.push(route.request().url()); return route.abort();
    });
    await page.goto('https://reader.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    for (const shadow of [false,true]) {
      for (const payload of cases) {
        await page.evaluate(({payload,shadow})=>window.mount(payload,shadow),{payload,shadow});
        const body=page.locator('.crate-reading-reader__body');
        await expect(body).toBeAttached();
        await expect(body.locator('script,img,iframe,svg,math,form,input,button,style,link,meta,base,object,embed,template,article-attack')).toHaveCount(0);
        assert.equal(await body.evaluate(root=>[...root.querySelectorAll('*')].some(el=>el.namespaceURI!=='http://www.w3.org/1999/xhtml'||[...el.attributes].some(a=>/^(on|style$|id$|name$|is$|srcdoc$|autofocus$|tabindex$)/i.test(a.name)))),false);
        assert.equal(await body.locator('a').evaluateAll(links=>links.every(link=>{
          const url=new URL(link.href);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&link.target==='_blank'&&link.rel==='noopener noreferrer';
        })),true);
        await expect(page.locator('.premium-reminder-title img,.premium-reminder-title script,.premium-reminder-title a[href^="javascript:"]')).toHaveCount(0);
        await expect(page.locator('.premium-reminder-title')).toContainText('<img src=x');
        await expect(page.locator('.premium-reminder-title a')).toHaveCount(1);
        await body.dispatchEvent('click');
        assert.equal(await page.evaluate(()=>window.articleAttack),undefined);
      }
      await page.evaluate(({benign,shadow})=>window.mount(benign,shadow),{benign,shadow});
      const body=page.locator('.crate-reading-reader__body');
      await expect(body.locator('h1')).toHaveText('Safe heading');
      await expect(body.locator('strong')).toHaveText('useful');
      await expect(body.locator('table td')).toHaveText(['One','Two']);
      await expect(body.getByRole('link',{name:'relative link'})).toHaveAttribute('href','https://example.invalid/more');
      await expect(body.locator('pre code')).toHaveText('const value = 1;');
      await expect(body.locator('.hljs-keyword')).toHaveText('const');
      const paragraph=await body.locator('p').first().elementHandle();
      await page.evaluate(benign=>window.revise(benign.replace('A **useful**','==A **useful**==')),benign);
      assert.equal(await paragraph.evaluate(node=>node.isConnected),true,'Saving native markers must retain the existing paragraph');
      await expect(body.locator('p').first()).toHaveText('A useful paragraph with a relative link.');
      await page.evaluate(()=>window.revise('# Changed article\n\nNew content.'));
      assert.equal(await paragraph.evaluate(node=>node.isConnected),false,'Actual content edits must replace the old article');
      await expect(body.locator('h1')).toHaveText('Changed article');
      await page.evaluate(shadow=>window.mount('```js\ncode\n```',shadow,true),shadow);
      await expect(page.locator('.crate-reading-reader__body code')).toHaveText('code');
      await expect(page.locator('.crate-reading-reader__body img,[onclick]')).toHaveCount(0);
    }
    // Allow resource loads and event handlers a browser turn to expose effects.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.articleAttack),undefined);
    assert.equal(await page.evaluate(()=>window.articleHtmlWrites),0,'Article nodes must never go through innerHTML again');
    assert.deepEqual(requests,[],'Untrusted content must not load external resources');
    assert.deepEqual(errors,[]);
    console.log(`${engine.name()}: ${cases.length} hostile articles, code highlighting and reminder text safe in document and Shadow DOM without CSP`);
  } finally { await browser.close(); }
}
