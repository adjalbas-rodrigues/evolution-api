/**
 * LidBufferService — Layer 1 of LID→PN resolution fix.
 *
 * Context: when a Baileys instance is freshly paired (QR scan) the internal
 * `lidMapping` store is empty. WhatsApp delivers messages keyed by
 * `key.remoteJid='<lid>@lid'` with `key.remoteJidAlt` undefined. Downstream
 * consumers (fdv2-back ChatPersister) require `remoteJidAlt` to persist the
 * message; without it the message is dropped silently.
 *
 * This service buffers such messages in-memory for a short TTL window
 * (default 30s) while attempting to resolve the LID→PN mapping. The buffer is
 * flushed early when a `notifications.upsert` event populates the mapping,
 * or when `flushPendingForLid` is invoked from a hook elsewhere in the
 * channel service. On TTL expiry the message is dropped with a WARN log
 * (Layer 2 — `LidReaperService` — handles the safety net by re-scanning the
 * `Message` table in Postgres).
 *
 * Trade-off: this introduces up to 30s of latency on the very first messages
 * after re-pair before the LID→PN map is hot. After warm-up, msgs pass
 * through synchronously (resolver hits on first try). PG load is a single
 * row lookup per buffered batch, not per msg.
 */

export interface LidBufferLogger {
  log: (message: any) => void;
  info: (message: any) => void;
  warn: (message: any) => void;
  error: (message: any) => void;
  verbose?: (message: any) => void;
  debug?: (message: any) => void;
}

export type LidResolveFn = (lid: string) => Promise<string | null>;
export type LidEmitFn = (payload: any) => void | Promise<void>;

export interface LidBufferConfig {
  logger: LidBufferLogger;
  /** TTL in ms before a buffered message is dropped. Default 30_000. */
  ttlMs?: number;
  /** Cap on buffered msgs per (instance, LID). Default 100. */
  maxPerLid?: number;
}

export interface TryResolveOrBufferArgs {
  instanceId: string;
  lid: string;
  payload: any;
  resolveFn: LidResolveFn;
  emitFn: LidEmitFn;
}

export interface FlushArgs {
  instanceId: string;
  lid: string;
  resolveFn: LidResolveFn;
  emitFn: LidEmitFn;
}

interface BufferEntry {
  payloads: any[];
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_PER_LID = 100;

export class LidBufferService {
  private readonly logger: LidBufferLogger;
  private readonly ttlMs: number;
  private readonly maxPerLid: number;
  private readonly buffers = new Map<string, BufferEntry>();
  private readonly inflightLookups = new Map<string, Promise<string | null>>();
  private shuttingDown = false;

  constructor(config: LidBufferConfig) {
    this.logger = config.logger;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPerLid = config.maxPerLid ?? DEFAULT_MAX_PER_LID;
  }

  /**
   * Apply the resolved PN to the payload's key and return a new payload-ready
   * shape. Mirrors the existing swap logic in `whatsapp.baileys.service.ts`:
   *
   *   key.remoteJid    = <PN>@s.whatsapp.net
   *   key.remoteJidAlt = <LID>@lid
   *   key.addressingMode = 'pn'
   */
  private applyPN(payload: any, lid: string, pn: string): any {
    if (!payload || !payload.key) return payload;
    payload.key.remoteJid = pn;
    payload.key.remoteJidAlt = lid;
    payload.key.addressingMode = 'pn';
    return payload;
  }

  private bufferKey(instanceId: string, lid: string): string {
    return `${instanceId}|${lid}`;
  }

  /** Number of currently-buffered messages for an (instance, LID) pair. */
  public pendingCount(instanceId: string, lid: string): number {
    const entry = this.buffers.get(this.bufferKey(instanceId, lid));
    return entry ? entry.payloads.length : 0;
  }

  /** Diagnostics — total pending msgs across all instances. */
  public totalPending(): number {
    let total = 0;
    for (const entry of this.buffers.values()) total += entry.payloads.length;
    return total;
  }

  /**
   * Attempt to resolve `lid` → PN via `resolveFn`. If hit: rewrites payload key
   * + invokes `emitFn` synchronously and returns `{ action: 'emitted' }`. If
   * miss: stores payload in buffer with TTL, returns `{ action: 'buffered' }`.
   *
   * Concurrent calls for the same LID share an inflight lookup promise to
   * avoid hammering the resolver.
   */
  public async tryResolveOrBuffer(args: TryResolveOrBufferArgs): Promise<{ action: 'emitted' | 'buffered' }> {
    if (this.shuttingDown) {
      // graceful no-op during shutdown
      return { action: 'buffered' };
    }

    const { instanceId, lid, payload, resolveFn, emitFn } = args;
    const key = this.bufferKey(instanceId, lid);

    let pn: string | null = null;
    try {
      let inflight = this.inflightLookups.get(key);
      if (!inflight) {
        inflight = resolveFn(lid);
        this.inflightLookups.set(key, inflight);
      }
      try {
        pn = await inflight;
      } finally {
        this.inflightLookups.delete(key);
      }
    } catch (err) {
      this.logger.warn(`[LidBuffer] resolveFn threw for ${lid}: ${(err as Error)?.message ?? err}`);
      pn = null;
    }

    if (pn) {
      // hit — emit immediately
      const finalPayload = this.applyPN(payload, lid, pn);
      await emitFn(finalPayload);
      // flush any older queued msgs for the same lid (best-effort)
      if (this.buffers.has(key)) {
        await this.flushBuffer(key, lid, pn, emitFn);
      }
      return { action: 'emitted' };
    }

    // miss — buffer
    this.appendToBuffer(key, instanceId, lid, payload);
    return { action: 'buffered' };
  }

  /**
   * Called when an external signal (e.g. notification event populating
   * lidMapping) suggests it's worth re-trying buffered msgs for `lid`.
   * Re-runs `resolveFn`; if hit, flushes all pending in arrival order.
   */
  public async flushPendingForLid(args: FlushArgs): Promise<{ emitted: number }> {
    const { instanceId, lid, resolveFn, emitFn } = args;
    const key = this.bufferKey(instanceId, lid);
    const entry = this.buffers.get(key);
    if (!entry || entry.payloads.length === 0) {
      return { emitted: 0 };
    }

    let pn: string | null = null;
    try {
      pn = await resolveFn(lid);
    } catch (err) {
      this.logger.warn(`[LidBuffer] flush resolveFn threw for ${lid}: ${(err as Error)?.message ?? err}`);
      return { emitted: 0 };
    }

    if (!pn) {
      return { emitted: 0 };
    }

    return { emitted: await this.flushBuffer(key, lid, pn, emitFn) };
  }

  private async flushBuffer(key: string, lid: string, pn: string, emitFn: LidEmitFn): Promise<number> {
    const entry = this.buffers.get(key);
    if (!entry) return 0;
    const payloads = entry.payloads.slice();
    clearTimeout(entry.timer);
    this.buffers.delete(key);

    let count = 0;
    for (const payload of payloads) {
      try {
        const final = this.applyPN(payload, lid, pn);
        await emitFn(final);
        count++;
      } catch (err) {
        this.logger.warn(`[LidBuffer] emit failed during flush for ${lid}: ${(err as Error)?.message ?? err}`);
      }
    }
    return count;
  }

  private appendToBuffer(key: string, instanceId: string, lid: string, payload: any): void {
    let entry = this.buffers.get(key);
    if (!entry) {
      const timer = setTimeout(() => {
        const current = this.buffers.get(key);
        if (!current) return;
        this.logger.warn(
          `[LidBuffer] TTL expired — dropping ${current.payloads.length} pending msg(s) for instance=${instanceId} lid=${lid}`,
        );
        this.buffers.delete(key);
      }, this.ttlMs);
      // Avoid keeping the event loop alive in tests; safe in prod (Node)
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
      entry = { payloads: [], expiresAt: Date.now() + this.ttlMs, timer };
      this.buffers.set(key, entry);
    }
    if (entry.payloads.length >= this.maxPerLid) {
      this.logger.warn(
        `[LidBuffer] overflow — buffer at maxPerLid=${this.maxPerLid} for instance=${instanceId} lid=${lid}; dropping new msg`,
      );
      return;
    }
    entry.payloads.push(payload);
  }

  /**
   * Iterate all currently-buffered (instance, LID) pairs and attempt to
   * flush each one via the supplied resolver. Used by an outer
   * `BaileysStartupService` after every `messages.upsert` batch as a
   * latency-reducer (avoid waiting up to TTL when the next batch in the
   * same conversation arrives with the LID mapping primed).
   */
  public async opportunisticFlush(args: { resolveFn: LidResolveFn; emitFn: LidEmitFn }): Promise<{ flushed: number }> {
    const keys = Array.from(this.buffers.keys());
    let totalFlushed = 0;
    for (const key of keys) {
      const sep = key.indexOf('|');
      if (sep === -1) continue;
      const instanceId = key.slice(0, sep);
      const lid = key.slice(sep + 1);
      const out = await this.flushPendingForLid({
        instanceId,
        lid,
        resolveFn: args.resolveFn,
        emitFn: args.emitFn,
      });
      totalFlushed += out.emitted;
    }
    return { flushed: totalFlushed };
  }

  /**
   * Releases all timers and clears state. Idempotent.
   * Intended for graceful shutdown / test teardown.
   */
  public shutdown(): void {
    this.shuttingDown = true;
    for (const entry of this.buffers.values()) {
      clearTimeout(entry.timer);
    }
    this.buffers.clear();
    this.inflightLookups.clear();
  }
}
