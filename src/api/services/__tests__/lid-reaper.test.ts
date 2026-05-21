import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { LidReaperService } from '../lid-reaper.service';

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

describe('LidReaperService — Layer 2 (cron reaper)', () => {
  let logger: any;

  beforeEach(() => {
    logger = makeLogger();
  });

  afterEach(() => {
    // ensure no dangling cron scheduled
  });

  it('queries Message table only for unresolved @lid rows (last 24h, LIMIT 100)', async () => {
    const queryRaw = mock.fn(async (..._args: any[]) => [] as any[]);
    const prismaRepository = {
      $queryRaw: queryRaw,
      $executeRaw: mock.fn(async () => 0),
    } as any;

    const reaper = new LidReaperService({
      logger,
      prismaRepository,
      getInstanceContext: () => null,
      batchSize: 100,
    });

    await reaper.tick();

    assert.equal(queryRaw.mock.callCount(), 1);
    const callArgs = queryRaw.mock.calls[0]!.arguments;
    // Prisma $queryRaw template literal: first arg is TemplateStringsArray, rest are interpolated values
    const strings = callArgs[0] as TemplateStringsArray;
    const values = callArgs.slice(1);
    const joined = strings.join('|');
    assert.match(joined, /Message/);
    assert.match(joined, /@lid|%@lid/);
    assert.match(joined, /remoteJidAlt/);
    assert.match(joined, /LIMIT/i);
    assert.match(joined, /messageTimestamp/);
    // batchSize=100 should be passed as a parameter value, not inlined
    assert.ok(values.includes(100), `expected batchSize=100 in values, got: ${JSON.stringify(values)}`);
  });

  it('re-emits resolved rows and updates PG remoteJidAlt', async () => {
    const row = {
      id: 'row-42',
      key: { remoteJid: LID, remoteJidAlt: null, id: 'msg-a', fromMe: false },
      messageType: 'conversation',
      message: { conversation: 'hello' },
      messageTimestamp: 1700000000,
      instanceId: 'inst-1',
      pushName: 'Alice',
    };

    const queryRaw = mock.fn(async () => [row] as any[]);
    const executeRaw = mock.fn(async () => 1);
    const prismaRepository = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
    } as any;

    const resolveFn = mock.fn(async () => PN);
    const emitFn = mock.fn();
    const getInstanceContext = mock.fn(() => ({ resolveFn: resolveFn as any, emitFn: emitFn as any }));

    const reaper = new LidReaperService({
      logger,
      prismaRepository,
      getInstanceContext: getInstanceContext as any,
      batchSize: 100,
    });

    const result = await reaper.tick();

    assert.equal(result.scanned, 1);
    assert.equal(result.resolved, 1);
    assert.equal(emitFn.mock.callCount(), 1);
    const emitted = emitFn.mock.calls[0]!.arguments[0];
    assert.equal(emitted.key.remoteJid, PN);
    assert.equal(emitted.key.remoteJidAlt, LID);
    assert.equal(executeRaw.mock.callCount(), 1);
  });

  it('skips rows still unresolvable (resolver returns null)', async () => {
    const row = {
      id: 'row-99',
      key: { remoteJid: LID, remoteJidAlt: null, id: 'msg-b', fromMe: false },
      messageType: 'conversation',
      message: { conversation: 'pending' },
      messageTimestamp: 1700000000,
      instanceId: 'inst-1',
      pushName: '',
    };

    const queryRaw = mock.fn(async () => [row] as any[]);
    const executeRaw = mock.fn(async () => 1);
    const prismaRepository = { $queryRaw: queryRaw, $executeRaw: executeRaw } as any;

    const resolveFn = mock.fn(async () => null);
    const emitFn = mock.fn();
    const getInstanceContext = mock.fn(() => ({ resolveFn: resolveFn as any, emitFn: emitFn as any }));

    const reaper = new LidReaperService({
      logger,
      prismaRepository,
      getInstanceContext: getInstanceContext as any,
      batchSize: 100,
    });

    const result = await reaper.tick();

    assert.equal(result.scanned, 1);
    assert.equal(result.resolved, 0);
    assert.equal(emitFn.mock.callCount(), 0);
    assert.equal(executeRaw.mock.callCount(), 0);
  });

  it('skips rows whose instance has no context (not loaded)', async () => {
    const row = {
      id: 'row-77',
      key: { remoteJid: LID, remoteJidAlt: null, id: 'msg-c', fromMe: false },
      messageType: 'conversation',
      message: { conversation: 'orphan' },
      messageTimestamp: 1700000000,
      instanceId: 'inst-gone',
      pushName: '',
    };

    const queryRaw = mock.fn(async () => [row] as any[]);
    const executeRaw = mock.fn(async () => 1);
    const prismaRepository = { $queryRaw: queryRaw, $executeRaw: executeRaw } as any;

    const reaper = new LidReaperService({
      logger,
      prismaRepository,
      getInstanceContext: () => null, // no instance loaded
      batchSize: 100,
    });

    const result = await reaper.tick();

    assert.equal(result.scanned, 1);
    assert.equal(result.skipped, 1);
    assert.equal(executeRaw.mock.callCount(), 0);
  });

  it('caps query at configured batchSize (verifies LIMIT param in SQL)', async () => {
    const queryRaw = mock.fn(async () => [] as any[]);
    const prismaRepository = { $queryRaw: queryRaw, $executeRaw: mock.fn(async () => 0) } as any;

    const reaper = new LidReaperService({
      logger,
      prismaRepository,
      getInstanceContext: () => null,
      batchSize: 100,
    });

    await reaper.tick();
    const args = queryRaw.mock.calls[0]!.arguments;
    const strings = args[0] as TemplateStringsArray;
    const values = args.slice(1);
    assert.match(strings.join('|'), /LIMIT/i);
    assert.ok(values.includes(100));
  });

  it('does NOT start cron if disabled via constructor flag', () => {
    const reaper = new LidReaperService({
      logger,
      prismaRepository: { $queryRaw: mock.fn(async () => []), $executeRaw: mock.fn(async () => 0) } as any,
      getInstanceContext: () => null,
      batchSize: 100,
    });

    // start() should be a no-op when enabled=false
    reaper.start(false);
    assert.equal(reaper.isRunning(), false);
  });

  it('start(true) activates cron scheduling and stop() tears it down', () => {
    const reaper = new LidReaperService({
      logger,
      prismaRepository: { $queryRaw: mock.fn(async () => []), $executeRaw: mock.fn(async () => 0) } as any,
      getInstanceContext: () => null,
      batchSize: 100,
    });

    reaper.start(true);
    assert.equal(reaper.isRunning(), true);
    reaper.stop();
    assert.equal(reaper.isRunning(), false);
  });
});
