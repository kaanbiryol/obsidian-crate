import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

// A dedicated loopback sandbox. Never point this at a real Crate data directory.
const port = 8877, origin = `http://localhost:${port}`;
const runtime = await openLocalRuntime({ dataDir: resolve('.crate/reading-preview'), origin, handleSignals: false });
const vault = await issueLocalDevice(runtime.db, 'Disposable Reading preview');
const api = async (path, body) => {
  const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Preview setup failed (${response.status})`);
  return response.json();
};
const { policy } = await api('/reading/policy');
if (!policy?.enabled) await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: policy?.revision ?? null });
if (!(await api('/reading/list')).items.length) await api('/reading/capture', { url: 'https://example.com', title: 'Your first saved link', operationId: `e1_${String(Math.floor(Date.now()/86400000)).padStart(8,'0')}_${randomUUID()}` });
const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== `localhost:${port}`) { response.writeHead(403); response.end(); return; }
    if (request.url === '/preview/start' && request.method === 'GET') {
      const enrollment = await api('/reading/access', { kind: 'reading' });
      response.writeHead(303, { Location: enrollment.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end(); return;
    }
    const chunks=[]; let size=0;
    for await (const chunk of request) { size+=chunk.length; if(size>32768) { response.writeHead(413);response.end();return; } chunks.push(chunk); }
    const headers = new Headers();
    for (const [name,value] of Object.entries(request.headers)) if (value && !['host','connection','transfer-encoding'].includes(name) && !/^(mf-|cf-|x-crate-internal-)/.test(name)) headers.set(name,Array.isArray(value)?value.join(','):value);
    const result = await runtime.mf.dispatchFetch(`${origin}${request.url}`, { method:request.method, headers, redirect:'manual', ...(['GET','HEAD'].includes(request.method)?{}:{body:Buffer.concat(chunks)}) });
    const outputHeaders = new Headers(result.headers); for(const name of ['Content-Length','Content-Encoding','Transfer-Encoding','Connection','MF-Content-Encoding']) outputHeaders.delete(name);
    response.writeHead(result.status,Object.fromEntries(outputHeaders));response.end(Buffer.from(await result.arrayBuffer()));
  } catch { response.writeHead(503,{'Content-Type':'text/plain'});response.end('Preview temporarily unavailable. Refresh to retry.'); }
});
try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port,'127.0.0.1',resolve); }); }
catch (error) { await runtime.close(); throw error; }
console.log(`Reading test server: ${origin}/preview/start\nUses only .crate/reading-preview. Stop with Ctrl+C.`);
let closing=false;
const close=async()=>{if(closing)return;closing=true;await new Promise(resolve=>server.close(resolve));await runtime.db.prepare('DELETE FROM auth_tokens WHERE id=?').bind(vault.id).run();await runtime.close();};
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
