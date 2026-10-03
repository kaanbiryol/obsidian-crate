import { describe, expect, it } from 'vitest';
import { createPairingRequester, createPairingResponder, type PairingContext } from './protocol';

const context = (): PairingContext => ({ version: 1, id: crypto.randomUUID(), origin: 'https://crate.example', vaultId: 'vault', generation: 2, scopeId: 'reminders' });
async function pair() {
  const requester = await createPairingRequester(context());
  const responder = await createPairingResponder(requester.request);
  const app = await requester.accept(responder.publicKey);
  const desktop = await responder.accept(app.publicKey);
  return { requester, responder, app, desktop };
}
describe('committed app key transfer', () => {
  it('agrees a verification code and authenticates encrypted packets without exposing secrets', async () => {
    const { requester, app, desktop } = await pair();
    expect(requester.request).not.toHaveProperty('publicKey');
    expect(app.code).toMatch(/^\d{4} \d{4} \d{4}$/);
    expect(app.code).toBe(desktop.code);
    const secret = { grants: ['private-folder-keys'] };
    const sealed = await desktop.seal(secret);
    expect(sealed).not.toContain('private-folder-keys');
    expect(await app.open(sealed)).toEqual(secret);
    const another = await pair();
    await expect(another.app.open(sealed)).rejects.toThrow();
    const tampered = (sealed[0] === 'A' ? 'B' : 'A') + sealed.slice(1);
    await expect(app.open(tampered)).rejects.toThrow();
  });
  it('rejects substituted requester keys against the commitment', async () => {
    const { responder } = await pair();
    const attacker = await pair();
    await expect(responder.accept(attacker.app.publicKey)).rejects.toThrow('verification');
  });
  it('pins the responder before revealing the requester key', async () => {
    const { requester } = await pair();
    const attacker = await pair();
    await expect(requester.accept(attacker.responder.publicKey)).rejects.toThrow('changed');
  });
  it.each(['origin', 'vaultId', 'scopeId', 'id', 'generation'] as const)('binds %s into the commitment', async field => {
    const requester = await createPairingRequester(context());
    const changed = { ...requester.request, context: { ...requester.request.context, [field]: field === 'generation' ? 9 : field === 'origin' ? 'https://evil.example' : 'other' } };
    const responder = await createPairingResponder(changed);
    const app = await requester.accept(responder.publicKey);
    await expect(responder.accept(app.publicKey)).rejects.toThrow('verification');
  });
  it('bounds encoded public keys and packet size', async () => {
    const requester = await createPairingRequester(context());
    await expect(requester.accept('bad-key')).rejects.toThrow();
    const { desktop } = await pair();
    await expect(desktop.seal('x'.repeat(16001))).rejects.toThrow('large');
  });
});
