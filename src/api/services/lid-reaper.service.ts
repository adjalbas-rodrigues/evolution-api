/**
 * LidReaperService — Layer 2 of LID→PN resolution fix.
 *
 * Safety net for the ~5% of msgs that the in-memory `LidBufferService`
 * cannot recover (e.g. service restart while buffer was full; resolver kept
 * missing through TTL window). Periodically scans the Postgres `Message`
 * table for rows whose key.remoteJid is `<lid>@lid` and whose key.remoteJidAlt
 * is missing, attempts to resolve via the per-instance resolver, and:
 *
 *   1. UPDATEs the row to populate `key.remoteJidAlt` so future replays don't
 *      re-process it.
 *   2. Re-emits the row via the instance's emit hook (mirrors `messages.upsert`).
 *
 * Gated by env `LID_REAPER_ENABLED=true` (default off) — opt-in to avoid
 * breaking forks that don't need the safety net.
 */

import cron from 'node-cron';

import type { LidBufferLogger, LidEmitFn, LidResolveFn } from './lid-buffer.service';

export interface LidReaperInstanceContext {
  resolveFn: LidResolveFn;
  emitFn: LidEmitFn;
}

export type GetInstanceContextFn = (instanceId: string) => LidReaperInstanceContext | null;

export interface LidReaperConfig {
  logger: LidBufferLogger;
  prismaRepository: {
    $queryRaw: (...args: any[]) => Promise<any>;
    $executeRaw: (...args: any[]) => Promise<number>;
  };
  /**
   * Returns the resolver + emit functions for a given instanceId, or null if
   * the instance is not currently loaded.
   */
  getInstanceContext: GetInstanceContextFn;
  /** Rows per scan tick. Default 100. */
  batchSize?: number;
  /** Cron schedule. Default '* /1 * * * *' (every 60s — see comments). */
  cronExpression?: string;
  /** Lookback window in seconds. Default 86400 (24h). */
  lookbackSeconds?: number;
}

export interface ReaperTickResult {
  scanned: number;
  resolved: number;
  skipped: number;
  failed: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CRON_EXPRESSION = '*/1 * * * *'; // every minute
const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60;

interface MessageRow {
  id: string;
  key: { remoteJid?: string; remoteJidAlt?: string; id?: string; fromMe?: boolean; participant?: string };
  message: any;
  messageType: string;
  messageTimestamp: number;
  instanceId: string;
  pushName?: string | null;
}

export class LidReaperService {
  private readonly logger: LidBufferLogger;
  private readonly prisma: LidReaperConfig['prismaRepository'];
  private readonly getInstanceContext: GetInstanceContextFn;
  private readonly batchSize: number;
  private readonly cronExpression: string;
  private readonly lookbackSeconds: number;

  private task: ReturnType<typeof cron.schedule> | null = null;
  private running = false;
  private tickInFlight = false;

  constructor(config: LidReaperConfig) {
    this.logger = config.logger;
    this.prisma = config.prismaRepository;
    this.getInstanceContext = config.getInstanceContext;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.cronExpression = config.cronExpression ?? DEFAULT_CRON_EXPRESSION;
    this.lookbackSeconds = config.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS;
  }

  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Activates the cron when `enabled=true`. Idempotent — calling twice is a
   * no-op. Pass `enabled=false` to leave the reaper dormant (matches default
   * fork behavior so we don't break chatwoot/other consumers).
   */
  public start(enabled: boolean): void {
    if (!enabled || this.running) return;
    this.task = cron.schedule(
      this.cronExpression,
      async () => {
        if (this.tickInFlight) {
          this.logger.verbose?.(`[LidReaper] previous tick still in flight, skipping`);
          return;
        }
        this.tickInFlight = true;
        try {
          const result = await this.tick();
          if (result.scanned > 0) {
            this.logger.info(
              `[LidReaper] tick scanned=${result.scanned} resolved=${result.resolved} skipped=${result.skipped} failed=${result.failed}`,
            );
          }
        } catch (err) {
          this.logger.error(`[LidReaper] tick crashed: ${(err as Error)?.message ?? err}`);
        } finally {
          this.tickInFlight = false;
        }
      },
      { scheduled: false } as any,
    );
    this.task.start();
    this.running = true;
    this.logger.info(`[LidReaper] started (cron='${this.cronExpression}', batchSize=${this.batchSize})`);
  }

  public stop(): void {
    if (!this.running) return;
    try {
      this.task?.stop();
    } catch {
      /* noop */
    }
    this.task = null;
    this.running = false;
    this.logger.info(`[LidReaper] stopped`);
  }

  /**
   * Single reaper pass. Public for testability + on-demand triggers.
   *
   * SQL note: filters on JSONB key fields use `->>` and `IS NULL` checks for
   * both `remoteJidAlt` absent and explicit null. The query is bounded by
   * `messageTimestamp > NOW() - 24h` so we don't scan the whole table.
   */
  public async tick(): Promise<ReaperTickResult> {
    const result: ReaperTickResult = { scanned: 0, resolved: 0, skipped: 0, failed: 0 };

    let rows: MessageRow[];
    try {
      rows = (await this.prisma.$queryRaw`
        SELECT id, key, message, "messageType", "messageTimestamp", "instanceId", "pushName"
        FROM "Message"
        WHERE key->>'remoteJid' LIKE '%@lid'
          AND (key->>'remoteJidAlt' IS NULL OR key->>'remoteJidAlt' = '')
          AND "messageTimestamp" > EXTRACT(EPOCH FROM NOW() - INTERVAL '${this.lookbackSeconds} seconds')::int
        ORDER BY "messageTimestamp" DESC
        LIMIT ${this.batchSize}
      `) as MessageRow[];
    } catch (err) {
      this.logger.error(`[LidReaper] query failed: ${(err as Error)?.message ?? err}`);
      return result;
    }

    result.scanned = rows.length;
    if (rows.length === 0) return result;

    for (const row of rows) {
      try {
        const lid = row.key?.remoteJid;
        if (!lid || !lid.endsWith('@lid')) {
          result.skipped++;
          continue;
        }

        const ctx = this.getInstanceContext(row.instanceId);
        if (!ctx) {
          result.skipped++;
          continue;
        }

        const pn = await ctx.resolveFn(lid);
        if (!pn) {
          // still unresolvable — leave for next tick or buffer
          continue;
        }

        // 1. UPDATE PG row first so a crash mid-emit doesn't double-emit later
        await this.prisma.$executeRaw`
          UPDATE "Message"
          SET key = jsonb_set(
            jsonb_set(key, '{remoteJidAlt}', to_jsonb(${lid}::text)),
            '{remoteJid}', to_jsonb(${pn}::text)
          )
          WHERE id = ${row.id}
        `;

        // 2. Re-emit with resolved key
        const newKey = {
          ...row.key,
          remoteJid: pn,
          remoteJidAlt: lid,
          addressingMode: 'pn',
        };
        const payload = {
          key: newKey,
          message: row.message,
          messageType: row.messageType,
          messageTimestamp: row.messageTimestamp,
          pushName: row.pushName ?? undefined,
          // Mark origin so downstream consumers can identify reaper replays
          source: 'lid-reaper-replay',
        };
        await ctx.emitFn(payload);
        result.resolved++;
      } catch (err) {
        result.failed++;
        this.logger.warn(`[LidReaper] row id=${row.id} failed: ${(err as Error)?.message ?? err}`);
      }
    }

    return result;
  }
}
