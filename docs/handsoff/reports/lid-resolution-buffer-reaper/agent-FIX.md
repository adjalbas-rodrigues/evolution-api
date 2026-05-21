# LID Resolution Buffer + Reaper — Agent FIX Report

**Branch:** `fix/lid-resolution-buffer-reaper`
**Base:** `release/debugger`
**Status:** DONE

## Resumo

Implementa fix de 2 layers para o problema de mensagens descartadas no fdv2-back
quando uma instance Evolution é re-pareada via QR (`lidMapping` interno do
Baileys vazio inicialmente).

## Root cause

Imediatamente após re-pair, WhatsApp envia mensagens com `key.remoteJid='<lid>@lid'`
e `key.remoteJidAlt=undefined` porque o Baileys ainda não aprendeu o mapeamento
LID → PN. A linha 1656 do `whatsapp.baileys.service.ts` só executava o swap LID/PN
quando **ambos** existiam. No caso `remoteJidAlt` ausente, a mensagem era emitida
via `messages.upsert` com `jidAlt=undefined`, e o `ChatPersister` no fdv2-back
descartava silenciosamente (log `dropped non-DM message { jid: ...@lid, jidAlt: undefined }`).

A mensagem **continuava** sendo gravada no PG `Message` table do Evolution + S3,
mas nunca chegava ao mysql `chat_messages` nem aparecia no frontend.

## Solução em 2 layers (complementares)

### Layer 1 — `LidBufferService` (95% coverage)

Novo arquivo: `src/api/services/lid-buffer.service.ts` (272 LOC).

Buffer in-memory com TTL 30s (configurável via `LID_BUFFER_TTL_MS`):

1. No emit path do `messages.upsert`, se `remoteJid` termina em `@lid` e
   `remoteJidAlt` é falsy:
   - Tenta resolver via `signalRepository.lidMapping.getPNForLID(lid)`.
   - Fallback: query PG `IsOnWhatsapp` por `lid='lid'` + `jidOptions` contendo o LID.
   - **Hit:** rewrites payload (`remoteJid=PN`, `remoteJidAlt=LID`,
     `addressingMode='pn'`) + emite imediatamente.
   - **Miss:** bufferiza payload com TTL 30s.
2. **Opportunistic flush:** após cada batch `messages.upsert` processado pelo
   `events.process`, itera buffers pendentes e tenta novo resolve — latência cai
   de 30s (TTL) pra "próxima msg na mesma conversa".
3. **TTL expirado:** drop + WARN log; o Layer 2 reaper pega depois.
4. Cap por (instance, LID): 100 msgs (`LID_BUFFER_MAX_PER_LID`) — overflow → drop + WARN.
5. Inflight dedup: chamadas concorrentes pro mesmo LID compartilham a mesma promise
   de lookup.

Hooks adicionados no `BaileysStartupService`:
- Campo `public readonly lidBuffer: LidBufferService` instanciado no constructor.
- Método `public async resolveLidToPN(lid)` — orquestra Baileys lookup + PG fallback.
- Método `public async emitMessageUpsert(payload)` — re-emite via webhook+chatbot
  (usado por buffer flush + reaper).
- Método `public async flushPendingLidBuffers()` — chamado opportunisticamente
  no events.process após `messages.upsert`.
- Wiring no emit site (linha ~1679): substitui `sendDataWebhook(MESSAGES_UPSERT, raw)`
  + `chatbotController.emit` pelo guard buffer-or-emit. Caso `endsWith('@lid')` +
  `!remoteJidAlt`: chama `lidBuffer.tryResolveOrBuffer`. Resto inalterado.

### Layer 2 — `LidReaperService` (safety net, 5%)

Novo arquivo: `src/api/services/lid-reaper.service.ts` (~230 LOC).

Cron 60s (gated via `LID_REAPER_ENABLED=true`, default OFF — não-breaking pra forks):

1. Query PG `Message` table (raw SQL via `$queryRaw`):
   ```sql
   SELECT id, key, message, "messageType", "messageTimestamp", "instanceId", "pushName"
   FROM "Message"
   WHERE key->>'remoteJid' LIKE '%@lid'
     AND (key->>'remoteJidAlt' IS NULL OR key->>'remoteJidAlt' = '')
     AND "messageTimestamp" > EXTRACT(EPOCH FROM NOW() - INTERVAL '${lookbackSeconds} seconds')::int
   ORDER BY "messageTimestamp" DESC
   LIMIT ${batchSize}
   ```
2. Pra cada row: pega instance context (resolveFn + emitFn) via `getInstanceContext`
   callback registrado no `server.module.ts`. Se instance não está carregada → skip.
3. Se resolve hit: UPDATE row pra populate `remoteJidAlt` (via `jsonb_set`) + re-emit
   payload via instance's emit hook (com `source: 'lid-reaper-replay'` marker).
4. Skip rows ainda não resolvíveis (tenta de novo no próximo tick).
5. Guard contra ticks concorrentes (`tickInFlight` flag).

Wiring no `server.module.ts`:
```ts
export const lidReaper = new LidReaperService({...});
lidReaper.start(process.env.LID_REAPER_ENABLED === 'true');
```

## Arquivos modificados / criados

| Arquivo | Tipo | LOC |
|---|---|---|
| `src/api/services/lid-buffer.service.ts` | NEW | ~270 |
| `src/api/services/lid-reaper.service.ts` | NEW | ~230 |
| `src/api/services/__tests__/lid-buffer.test.ts` | NEW | ~225 |
| `src/api/services/__tests__/lid-reaper.test.ts` | NEW | ~195 |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | MOD | +120 / -7 |
| `src/api/server.module.ts` | MOD | +22 / 0 |
| `package.json` | MOD | +1 / -1 (test script) |
| `tsconfig.json` | MOD | +1 / -1 (excluir __tests__) |
| `.eslintignore` | MOD | +1 / 0 |

## Tests added — 15 total

### Layer 1 — `lid-buffer.test.ts` (8 tests)
- emits immediately with resolved remoteJidAlt when resolver returns PN
- buffers msg when resolver misses (returns null)
- flushes pending msgs when lidMapping learns mid-buffer
- drops + logs after TTL when still unresolved (TTL=50ms para teste rápido)
- coalesces multiple msgs of same LID and flushes them in order
- isolates buffers across instances (same LID, different instanceId)
- opportunisticFlush walks all buffers and emits resolved ones
- respects maxPerLid cap (drops + warns when overflow)

### Layer 2 — `lid-reaper.test.ts` (7 tests)
- queries Message table only for unresolved @lid rows (last 24h, LIMIT 100)
- re-emits resolved rows and updates PG remoteJidAlt
- skips rows still unresolvable (resolver returns null)
- skips rows whose instance has no context (not loaded)
- caps query at configured batchSize (verifies LIMIT param in SQL)
- does NOT start cron if disabled via constructor flag
- start(true) activates cron scheduling and stop() tears it down

**Resultado:** `npm test` → **15/15 GREEN** em ~270ms.

## Verifications

| Check | Resultado |
|---|---|
| `npx tsc --noEmit` | clean (0 errors) |
| `npm run lint:check` | clean (0 errors) |
| `npm test` | 15/15 pass |
| `npm run build` | success (CJS + ESM via tsup, ~3s) |
| Compatibility (non-LID emit signature) | inalterado — branch `else` chama `sendDataWebhook(MESSAGES_UPSERT, messageRaw)` + `chatbotController.emit` igual ao código original |
| Chatwoot integration | inalterado — payload shape pra msgs não-LID não muda |

## Trade-offs

1. **Latência 30s na primeira msg pós re-pair**: durante o "warm-up" window, msgs
   com LID novo ficam até 30s aguardando resolve. O opportunistic flush mitiga isso
   (próxima msg na mesma conversa que chegar primeiro dispara flush). Após primeira
   resolve, `IsOnWhatsapp` cacheia → próximas msgs do mesmo contato passam direto.

2. **PG load do reaper**: 100 rows scan / 60s por instance, filtros índice-friendly
   (`messageTimestamp > NOW() - 24h`). Total estimado: <1MB/min query payload.

3. **Mem footprint**: 100 msgs × N LIDs × instance = bounded. Pior caso (1000 LIDs
   simultâneos novos por instance): 100MB. Realista (10 LIDs/instance): <1MB.

4. **Backwards compat**: reaper é opt-in (`LID_REAPER_ENABLED`); Layer 1 é
   sempre-on mas só intercepta o case `@lid` + `!remoteJidAlt` que antes era
   silenciosamente descartado downstream — sem impacto nos outros emit sites.

## Como verificar em prod pós-deploy

1. Deploy commit em `release/debugger` (CI builds Docker image `ghcr.io/.../evolution-api:debugger-<sha>`).
2. Atualizar Coolify app Evolution pra nova imagem.
3. Smoke test:
   ```bash
   # 1. Logout + QR re-pair na instance blackcredpix
   curl -X DELETE "$EVO_URL/instance/logout/blackcredpix" -H "apikey: $EVO_KEY"
   # 2. Re-conectar (QR) via UI
   # 3. Envia 5 msgs de teste de outra conta pra blackcredpix
   # 4. Verificar logs:
   #    [LidBuffer] resolveFn threw … (esperado nas primeiras tentativas)
   #    [LidBuffer] TTL expired (esperado se demorar pra Baileys aprender)
   #    [LidReaper] tick scanned=N resolved=M (se habilitado)
   # 5. Verificar mysql.chat_messages tem as 5 msgs com mediaPath/sender válidos
   ```
4. Habilitar reaper opcionalmente: `LID_REAPER_ENABLED=true` no env do container
   Evolution.

## Env vars novas (todas com defaults safe)

| Var | Default | Propósito |
|---|---|---|
| `LID_BUFFER_TTL_MS` | `30000` | Tempo máximo de buffer antes do drop |
| `LID_BUFFER_MAX_PER_LID` | `100` | Cap de msgs em buffer por (instance, LID) |
| `LID_REAPER_ENABLED` | `false` | Liga/desliga o cron reaper safety net |
| `LID_REAPER_BATCH_SIZE` | `100` | Linhas por tick |
| `LID_REAPER_LOOKBACK_SECONDS` | `86400` | Janela de scan (24h) |

## Constraints respeitadas

- [x] NÃO alterado Baileys node_modules (patch PR2523 preservado)
- [x] NÃO alterada signature de `sendDataWebhook` (PRE-hook inline no message handler)
- [x] Build atual passa
- [x] Cron reaper opcional via env (`LID_REAPER_ENABLED`), default false
- [x] Não-breaking pra outros forks (chatwoot etc.) — payload shape pra non-LID msgs idêntico
- [x] TDD strict: RED tests primeiro, depois GREEN implementation
- [x] NO `Co-Authored-By: Claude` nos commits

## Final status: DONE
