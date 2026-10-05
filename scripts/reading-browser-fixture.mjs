import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalRuntime, issueLocalDevice } from '../packages/server/src/local-server-runtime.mjs';

/** Real Worker, storage and browser HTTP bridge; scenarios own their fault injection. */
export async function openReadingBrowserFixture({ deviceName = 'Reading browser test', handleRequest } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-browser-'));
  let runtime, server;
  const close = async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
    } finally {
      try { await runtime?.close(); }
      finally { await rm(dir, { recursive: true, force: true }); }
    }
  };
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, deviceName);
    server = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const dispatch = () => runtime.mf.dispatchFetch(`${origin}${request.url}`, {
          method: request.method, headers: request.headers,
          ...(['GET', 'HEAD'].includes(request.method) ? {} : { body }),
        });
        const result = await (handleRequest ? handleRequest({ request, body, dispatch }) : dispatch());
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        if (response.headersSent) response.destroy(error);
        else { response.writeHead(500); response.end('Test server failed'); }
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    return { runtime, vault, origin, api, close };
  } catch (error) {
    await close();
    throw error;
  }
}
