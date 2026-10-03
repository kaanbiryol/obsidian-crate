import { assertPairingCurrent, createPairingRequester, createPairingResponder, PairingEndedError, PAIRING_LIFETIME, type PairingContext, type PairingRecord, type PairingTransport } from './protocol';

function initial(record: PairingRecord, expected: { context: PairingContext; commitment: string }) {
  assertPairingCurrent(record, expected, Date.now() + PAIRING_LIFETIME + 30_000);
  return record.expiresAt;
}
// A lost opening response must reuse the same ephemeral key, not leave a
// claimed request whose private key has already been discarded. One retry is
// sufficient for a lost response; later failures surface for an explicit retry.
async function publishOpening(transport: PairingTransport, body: Record<string, unknown>, current: () => void) {
  try { return await transport.write(body); }
  catch (error) {
    current();
    if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && error.status < 500) throw error;
    return transport.write(body);
  }
}
export async function requestAppPairing(context: PairingContext, transport: PairingTransport, current: () => void) {
  const requester = await createPairingRequester(context);
  current();
  const { request } = await publishOpening(transport, { action: 'start', ...requester.request }, current);
  current();
  const deadline = initial(request, requester.request);
  let agreed: Awaited<ReturnType<typeof requester.accept>> | undefined;
  let responder: string | undefined;
  return {
    id: context.id,
    expiresAt: deadline,
    async poll(): Promise<{ code?: string; payload?: unknown }> {
      current();
      const record = (await transport.read(context.id)).requests[0];
      current();
      if (!record) throw new PairingEndedError('This pairing expired or was cancelled. Start again.');
      assertPairingCurrent(record, requester.request, deadline);
      if (responder && responder !== record.responderKey) throw new Error('Pairing device changed. Start again.');
      if (!record.responderKey) return {};
      responder = record.responderKey;
      agreed ??= await requester.accept(responder);
      current();
      if (!record.requesterKey) {
        await transport.write({ action: 'reveal', id: context.id, key: agreed.publicKey });
        current();
      } else if (record.requesterKey !== agreed.publicKey) throw new Error('Pairing verification failed. Start again.');
      if (!record.payload) return { code: agreed.code };
      if (!record.requesterKey) throw new Error('Pairing verification failed. Start again.');
      const payload = await agreed.open(record.payload);
      current();
      return { code: agreed.code, payload };
    },
    async close(finished = false) {
      current();
      await transport.write({ action: finished ? 'finish' : 'cancel', id: context.id });
    },
  };
}

export async function answerAppPairing(request: PairingRecord, transport: PairingTransport, current: () => void) {
  const deadline = initial(request, request);
  if (request.responderKey || request.requesterKey || request.payload) throw new Error('Start a fresh pairing request in the app.');
  const responder = await createPairingResponder(request);
  current();
  const accepted = (await publishOpening(transport, { action: 'accept', id: request.context.id, key: responder.publicKey }, current)).request;
  current();
  assertPairingCurrent(accepted, request, deadline);
  if (accepted.responderKey !== responder.publicKey) throw new Error('Another device accepted this request.');
  let agreed: Awaited<ReturnType<typeof responder.accept>> | undefined;
  let requesterKey: string | undefined;
  let packet: string | undefined;
  return {
    id: request.context.id,
    context: request.context,
    async poll(): Promise<string | undefined> {
      current();
      const record = (await transport.read(request.context.id)).requests[0];
      current();
      if (!record) throw new PairingEndedError('This pairing expired or was cancelled. Start again in the app.');
      assertPairingCurrent(record, request, deadline);
      if (record.responderKey !== responder.publicKey || requesterKey && requesterKey !== record.requesterKey) throw new Error('Pairing device changed. Start again.');
      if (!record.requesterKey) return;
      requesterKey = record.requesterKey;
      agreed ??= await responder.accept(requesterKey);
      current();
      return agreed.code;
    },
    /** Called only after the user compares the two displays and approves. */
    async approve(payload: unknown) {
      if (!agreed) throw new Error('Wait for the verification code.');
      await this.poll();
      current();
      packet ??= await agreed.seal(payload);
      current();
      await transport.write({ action: 'approve', id: request.context.id, payload: packet });
      current();
    },
    async close() { current(); await transport.write({ action: 'cancel', id: request.context.id }); },
  };
}
