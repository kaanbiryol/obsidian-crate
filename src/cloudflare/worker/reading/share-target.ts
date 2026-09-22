/** This self-contained function also runs inside the service worker, including offline. */
async function receiveReadingShare(request: Request): Promise<Response> {
  try {
    if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new Error('Unsupported share format.');
    const reader = request.body?.getReader(); if (!reader) throw new Error('The shared link is missing.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 16384) throw new Error('Share one link at a time.'); chunks.push(value); } }
    finally { await reader.cancel(); }
    const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const input = new URLSearchParams(new TextDecoder().decode(all));
    const candidates = `${input.get('url') ?? ''} ${input.get('text') ?? ''}`.match(/https?:\/\/[^\s<>"']+/g) ?? [];
    const urls = [...new Set(candidates)]; if (urls.length !== 1) throw new Error('Share one complete web link at a time.');
    const url = new URL(urls[0]!); if (url.username || url.password || url.href.length > 8192) throw new Error('Unsupported shared link.');
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      let expired = false;
      const opening = indexedDB.open('crate-reading-v1', 1);
      const timer = setTimeout(() => { expired = true; reject(new Error('Reading storage is unavailable. Open Crate, then share again.')); }, 4000);
      opening.onupgradeneeded = () => { if (expired) opening.transaction?.abort(); else opening.result.createObjectStore('values'); };
      opening.onerror = () => { clearTimeout(timer); reject(new Error('Reading storage is unavailable.')); };
      opening.onsuccess = () => {
        const db = opening.result; if (expired) { db.close(); return; }
        const tx = db.transaction('values', 'readwrite');
        const store = tx.objectStore('values');
        const count = store.count(IDBKeyRange.bound('share:', 'share;'));
        count.onsuccess = () => { if (count.result >= 200) { tx.abort(); return; }
        store.put({ url: url.href, title: (input.get('title') ?? '').slice(0, 1000), savedAt: Date.now() }, `share:${id}`); };
        tx.onabort = () => { clearTimeout(timer); db.close(); reject(new Error('Shared links could not be saved. Open Reading and save or export existing shares first.')); };
        tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(); };
        tx.onerror = () => { clearTimeout(timer); db.close(); reject(new Error('The shared link could not be stored.')); };
      };
    });
    return Response.redirect(`${new URL(request.url).origin}/notifications?section=reading&share=${id}`, 303);
  } catch (error) { return new Response(error instanceof Error ? error.message : 'Could not keep this link. Open Crate and paste it again.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
}
export const READING_SHARE_SW = `const receiveReadingShare = ${receiveReadingShare.toString()};`;

export async function readingShareFallback(request: Request): Promise<Response> {
  // First install has no controlling SW. Keep the submitted form in this page until its own storage succeeds.
  const reader = request.body?.getReader(); if (!reader) return new Response('The shared link is missing.', { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) return new Response('Share one link at a time.', { status: 413 }); chunks.push(value); } }
  finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = new TextDecoder().decode(bytes);
  const nonce = crypto.randomUUID();
  const payload = JSON.stringify(body).replace(/</g, '\\u003c');
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Save to Crate</title><main><h1>Keeping your shared link…</h1><p id="status" role="status">Opening Reading.</p></main><script nonce="${nonce}">const receiveReadingShare=${receiveReadingShare.toString()};receiveReadingShare(new Request(location.href,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:${payload}})).then(async response=>{if(response.status===303)location.replace(response.headers.get('Location'));else document.getElementById('status').textContent=await response.text();});</script></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` },
  });
}
