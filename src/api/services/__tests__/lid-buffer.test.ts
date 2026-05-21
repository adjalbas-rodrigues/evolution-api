import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { LidBufferService } from '../lid-buffer.service';

const PN = '5521999999999@s.whatsapp.net';
const LID = '254876730831069@lid';

const makeLogger = () =>
  ({
    log: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    verbose: mock.fn(),
    debug: mock.fn(),
    setContext: mock.fn(),
  }) as any;

const makePayload = (lid: string) => ({
  key: { remoteJid: lid, remoteJidAlt: undefined, id: 'msg1', fromMe: false },
  messageType: 'conversation',
  message: { conversation: 'hi' },
});

describe('LidBufferService — Layer 1 (buffer-and-wait)', () => {
  let buf: LidBufferService;
  let emit: ReturnType<typeof mock.fn>;
  let resolver: ReturnType<typeof mock.fn>;
  let logger: any;

  beforeEach(() => {
    logger = makeLogger();
    buf = new LidBufferService({ logger, ttlMs: 30_000, maxPerLid: 100 });
    emit = mock.fn();
    resolver = mock.fn(async (_lid: string) => null as string | null);
  });

  afterEach(() => {
    buf.shutdown();
  });

  it('emits immediately with resolved remoteJidAlt when resolver returns PN', async () => {
    resolver.mock.mockImplementation(async () => PN);
    const payload = makePayload(LID);

    const out = await buf.tryResolveOrBuffer({
      instanceId: 'inst-1',
      lid: LID,
      payload,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(out.action, 'emitted');
    assert.equal(emit.mock.callCount(), 1);
    const emitted = emit.mock.calls[0]!.arguments[0];
    assert.equal(emitted.key.remoteJid, PN);
    assert.equal(emitted.key.remoteJidAlt, LID);
    assert.equal(emitted.key.addressingMode, 'pn');
    assert.equal(buf.pendingCount('inst-1', LID), 0);
  });

  it('buffers msg when resolver misses (returns null)', async () => {
    resolver.mock.mockImplementation(async () => null);
    const payload = makePayload(LID);

    const out = await buf.tryResolveOrBuffer({
      instanceId: 'inst-1',
      lid: LID,
      payload,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(out.action, 'buffered');
    assert.equal(emit.mock.callCount(), 0);
    assert.equal(buf.pendingCount('inst-1', LID), 1);
  });

  it('flushes pending msgs when lidMapping learns mid-buffer', async () => {
    resolver.mock.mockImplementation(async () => null);
    const payload = makePayload(LID);

    await buf.tryResolveOrBuffer({
      instanceId: 'inst-1',
      lid: LID,
      payload,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(emit.mock.callCount(), 0);
    assert.equal(buf.pendingCount('inst-1', LID), 1);

    // Simulate lidMapping learning the PN
    resolver.mock.mockImplementation(async () => PN);

    const flushed = await buf.flushPendingForLid({
      instanceId: 'inst-1',
      lid: LID,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(flushed.emitted, 1);
    assert.equal(emit.mock.callCount(), 1);
    const emittedPayload = emit.mock.calls[0]!.arguments[0];
    assert.equal(emittedPayload.key.remoteJid, PN);
    assert.equal(emittedPayload.key.remoteJidAlt, LID);
    assert.equal(buf.pendingCount('inst-1', LID), 0);
  });

  it('drops + logs after TTL when still unresolved', async () => {
    buf.shutdown();
    buf = new LidBufferService({ logger, ttlMs: 50, maxPerLid: 100 });
    resolver.mock.mockImplementation(async () => null);
    const payload = makePayload(LID);

    await buf.tryResolveOrBuffer({
      instanceId: 'inst-1',
      lid: LID,
      payload,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(buf.pendingCount('inst-1', LID), 1);

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(emit.mock.callCount(), 0);
    assert.equal(buf.pendingCount('inst-1', LID), 0);
    assert.ok(
      logger.warn.mock.calls.length > 0 || logger.error.mock.calls.length > 0,
      'expected warn/error log when buffer expires',
    );
  });

  it('coalesces multiple msgs of same LID and flushes them in order', async () => {
    resolver.mock.mockImplementation(async () => null);
    const p1 = makePayload(LID);
    const p2 = makePayload(LID);
    const p3 = makePayload(LID);
    p1.key.id = 'id-a';
    p2.key.id = 'id-b';
    p3.key.id = 'id-c';

    for (const p of [p1, p2, p3]) {
      await buf.tryResolveOrBuffer({
        instanceId: 'inst-1',
        lid: LID,
        payload: p,
        resolveFn: resolver as any,
        emitFn: emit as any,
      });
    }

    assert.equal(buf.pendingCount('inst-1', LID), 3);
    assert.equal(emit.mock.callCount(), 0);

    resolver.mock.mockImplementation(async () => PN);
    const flushed = await buf.flushPendingForLid({
      instanceId: 'inst-1',
      lid: LID,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(flushed.emitted, 3);
    assert.equal(emit.mock.callCount(), 3);
    const ids = emit.mock.calls.map((c: any) => c.arguments[0].key.id);
    assert.deepEqual(ids, ['id-a', 'id-b', 'id-c']);
    assert.equal(buf.pendingCount('inst-1', LID), 0);
  });

  it('isolates buffers across instances (same LID, different instanceId)', async () => {
    resolver.mock.mockImplementation(async () => null);
    const payload = makePayload(LID);

    await buf.tryResolveOrBuffer({
      instanceId: 'inst-1',
      lid: LID,
      payload,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });
    await buf.tryResolveOrBuffer({
      instanceId: 'inst-2',
      lid: LID,
      payload,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(buf.pendingCount('inst-1', LID), 1);
    assert.equal(buf.pendingCount('inst-2', LID), 1);

    resolver.mock.mockImplementation(async () => PN);
    await buf.flushPendingForLid({
      instanceId: 'inst-1',
      lid: LID,
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    assert.equal(buf.pendingCount('inst-1', LID), 0);
    assert.equal(buf.pendingCount('inst-2', LID), 1, 'inst-2 buffer should be untouched');
    assert.equal(emit.mock.callCount(), 1);
  });

  it('opportunisticFlush walks all buffers and emits resolved ones', async () => {
    resolver.mock.mockImplementation(async () => null);
    const lidA = '111@lid';
    const lidB = '222@lid';
    await buf.tryResolveOrBuffer({
      instanceId: 'inst-1',
      lid: lidA,
      payload: makePayload(lidA),
      resolveFn: resolver as any,
      emitFn: emit as any,
    });
    await buf.tryResolveOrBuffer({
      instanceId: 'inst-1',
      lid: lidB,
      payload: makePayload(lidB),
      resolveFn: resolver as any,
      emitFn: emit as any,
    });

    // Resolver now resolves only lidA, lidB still misses.
    const selectiveResolver = mock.fn(async (lid: string) => (lid === lidA ? PN : null));
    const result = await buf.opportunisticFlush({
      resolveFn: selectiveResolver as any,
      emitFn: emit as any,
    });

    assert.equal(result.flushed, 1);
    assert.equal(buf.pendingCount('inst-1', lidA), 0);
    assert.equal(buf.pendingCount('inst-1', lidB), 1);
  });

  it('respects maxPerLid cap (drops + warns when overflow)', async () => {
    buf.shutdown();
    buf = new LidBufferService({ logger, ttlMs: 30_000, maxPerLid: 2 });
    resolver.mock.mockImplementation(async () => null);

    for (let i = 0; i < 5; i++) {
      const p = makePayload(LID);
      p.key.id = `id-${i}`;
      await buf.tryResolveOrBuffer({
        instanceId: 'inst-1',
        lid: LID,
        payload: p,
        resolveFn: resolver as any,
        emitFn: emit as any,
      });
    }

    assert.equal(buf.pendingCount('inst-1', LID), 2);
    assert.ok(logger.warn.mock.calls.length > 0, 'expected warn when overflow');
  });
});
