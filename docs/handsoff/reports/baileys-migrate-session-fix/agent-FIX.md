# Baileys migrateSession — Root cause + TDD fix for issue #2548

**Branch**: `agent/baileys-tdd-fix` (worktree: `.claude/worktrees/baileys-tdd`)
**Base**: `release/debugger` @ commit `e450f4d1`
**Commits added** (local only — Iron Law 4, awaits user approval to push):
- `0263213c` — `[backend-agent] test(baileys): RED reproduction migrateSession lookup empty device-list (#2548)`
- `cf18cd86` — `[backend-agent] fix(baileys): migrateSession fallback when device-list empty (#2548)`
- `7fa031ad` — `[backend-agent] test(baileys): GREEN — migrateSession recovers PN→LID with empty device-list`

Tests: **19/19 GREEN** (15 pre-existing lid-buffer/reaper + 4 new migrateSession).

---

## Final diagnosis — what was actually broken

The original bug brief proposed a "key format mismatch" theory: that the
fork's Redis keys use `evolution:baileys:<inst>_<hash>_<v>` and that
`migrateSession` would never match because it generates `${user}.${device}`.

**That theory was wrong.** Inspecting the runtime:

- `libsignal.ProtocolAddress.toString()` returns `${id}.${deviceId}`, i.e.
  `5521979579487.0` for a PN-domain user.
- The fork's Redis adapter (`src/utils/use-multi-file-auth-state-redis-db.ts`)
  stores under `<instanceName>` hash with field `session-5521979579487.0`.
- So when libsignal calls `storage.storeSession('5521979579487.0', record)`,
  the Redis field name lines up exactly with what `migrateSession` later
  asks for via `parsedKeys.get('session', ['5521979579487.0'])`. The
  format matches.

The real issue is **upstream of the session lookup** — it lives in the
`device-list` read that gates `migrateSession`:

```js
// migrateSession (libsignal.js)
const { [user]: userDevices } = await parsedKeys.get('device-list', [user]);
if (!userDevices) {
    return { migrated: 0, skipped: 0, total: 0 };  // ← early-return
}
```

`device-list` is populated **only** by the outbound `getUSyncDevices`
path in `node_modules/baileys/lib/Socket/messages-send.js`:

```js
// messages-send.js:261
await authState.keys.set({ 'device-list': userDeviceUpdates });
```

For an instance whose first contact with a given user is an **inbound**
message — which is the norm for blackCredPix (a support/bot inbox where
clients DM first) — `getUSyncDevices` never runs for that user. Redis
returns `{ '5521979579487': null }`. `migrateSession` early-returns
`{migrated:0}` without checking whether a session exists under
`session-5521979579487.0` — and there IS one, because libsignal stored
it during the initial PreKey decrypt.

Downstream:
1. `decryptMessageNode` calls `getDecryptionJid(sender)` → returns the LID
   (since the LID mapping already exists from a prior `senderAlt` envelope).
2. `repository.decryptMessage({ jid: <LID> })` constructs
   `ProtocolAddress('245607872618564_1', 0)` → looks up
   `session-245607872618564_1.0` → empty.
3. `SessionCipher.decryptWhisperMessage` raises "No session record".
4. Msg piles into the retry cache.
5. `messages.upsert` never fires.
6. `Message` table never receives an insert.

This matches exactly what production logged at 07:39 UTC on 2026-05-22.

---

## Why the previous patch (commit `e450f4d1`) didn't work

That patch hardcoded `userDevices = null`:

```js
const { [user]: userDevices } = { [user]: null };
if (!userDevices) {
    return { migrated: 0, skipped: 0, total: 0 };
}
```

This was an attempt to mimic pre-rc.10 behavior — but pre-rc.10 also
took the early-return path under the same conditions. The reason the
upstream community workaround "fixed" the issue for them (and not us) is
that their multi-file FS storage didn't have a stale PN session sitting
around — they fell into the PreKey path on the next inbound (which has
its own session-build flow). Our fork *does* have the stale PN session,
so we need it migrated, not bypassed.

---

## The fix — `cf18cd86`

Patch file: `patches/baileys+7.0.0-rc11.patch` (regenerated via
`npx patch-package baileys`).

```diff
-            // Get user's device list from storage
-            const { [user]: userDevices } = await parsedKeys.get('device-list', [user]);
-            if (!userDevices) {
-                return { migrated: 0, skipped: 0, total: 0 };
-            }
+            // Patch (issue #2548 — replaces commit e450f4d1's force-null workaround):
+            // ...lengthy explanation in code...
             const { device: fromDevice } = jidDecode(fromJid);
             const fromDeviceStr = fromDevice?.toString() || '0';
-            if (!userDevices.includes(fromDeviceStr)) {
+            let { [user]: userDevices } = await parsedKeys.get('device-list', [user]);
+            if (!userDevices || userDevices.length === 0) {
+                logger.debug({ fromJid, fromDeviceStr }, 'device-list empty — falling back to fromJid device for migration (#2548)');
+                userDevices = [fromDeviceStr];
+            } else if (!userDevices.includes(fromDeviceStr)) {
                 userDevices.push(fromDeviceStr);
             }
```

**Behavioral contract after fix**:

| Storage state                                          | Before fix       | After fix                                       |
|--------------------------------------------------------|------------------|-------------------------------------------------|
| PN session present, `device-list` empty                | `{migrated:0}`, session stays under PN | `{migrated:1,total:1}`, session moved to LID  |
| No PN session, `device-list` empty                     | `{migrated:0}`   | `{migrated:0,total:1}` (no-op, guarded by `if (sessionData)`) |
| PN session + `device-list=['0','15']`                  | unchanged        | unchanged (additive: only triggers fallback when empty) |
| `fromJid` is not PN                                    | `{migrated:0,total:1}` | unchanged |
| `toJid` is not LID                                     | `{migrated:0,total:0}` | unchanged |

The migration loop downstream (`for (const [sessionKey, sessionData] of Object.entries(existingSessions))`)
already guards `if (sessionData)`, so the fallback device list never
fabricates a phantom migration when nothing is actually there.

The migration is performed inside `parsedKeys.transaction` (atomic
move): copies bytes from PN key → LID key, then sets PN key to `null`
(deleted). No partial state on crash.

---

## Tests added (`src/api/services/__tests__/baileys-migrate-session.test.mjs`)

Native ESM (Node test runner) — required because baileys is ESM-only
and the project's tsconfig emits CommonJS, which makes `tsx` try to
`require()` baileys' transitive `whatsapp-rust-bridge`, whose package
only exports the `import` condition. `npm test` was updated to run
both `.test.ts` (via tsx) and `.test.mjs` (via `node --test`).

| Test | Asserts |
|------|---------|
| `RED: returns {migrated:0} when device-list is empty even though PN session exists` | Bug repro — verifies `{migrated:1, total:1}`, LID key populated, PN key removed after fix |
| `GREEN expectation: no-op when fromJid has no PN session at all` | Negative case — fallback must not fabricate migrations when storage is empty |
| `contract: still no-op when fromJid is not a PN user` | Preserves existing spec — LID→LID returns `{migrated:0}` |
| `contract: still no-op when toJid is not a LID` | Preserves existing spec — PN→PN returns `{migrated:0, total:0}` |

The test uses a real `libsignal.SessionRecord` (constructed via
`createEntry` + `setSession` with `closed:-1` so `haveOpenSession()`
returns true), an in-memory storage emulating the Redis adapter's
`{ get(type, ids) → { [id]: value }, set(data), transaction(fn) }`
contract, and calls the actual `makeLibSignalRepository` from baileys
(not a stubbed one). This means the test exercises the patched code
path end-to-end inside the real Baileys runtime.

### Verification (clean re-apply)

```
$ rm -rf node_modules/baileys && npm install --ignore-scripts baileys
$ npx patch-package
patch-package 8.0.1
Applying patches...
baileys@7.0.0-rc11 ✔
$ npm test
tests 15 / pass 15 / fail 0   (lid-buffer + lid-reaper, tsx runner)
tests  4 / pass  4 / fail 0   (migrateSession, node runner)
```

---

## Operational next steps (awaits user approval)

1. **Review** this report + the three commits on `agent/baileys-tdd-fix`.
2. **Push** to `release/debugger` when approved (Iron Law 4 — no
   unsolicited push by agents).
3. **Deploy** via Coolify trigger on `evolution-api` BRDock TH app —
   no manual Docker pull / SSH on host.
4. **Observe**: in the libsignal pino logs, the patch emits
   `device-list empty — falling back to fromJid device for migration (#2548)`
   on first inbound from any new contact. Should fire heavily during
   the recovery window for blackCredPix's backlog of stuck contacts,
   then taper as `getUSyncDevices` warms up `device-list` for actives.
5. **Confirm fix**: `messages.upsert` log lines reappear within ~30s
   of next inbound from a stuck contact (production proof point).
   Postgres `Message` insert rate should recover to baseline.

---

## Known risks / unknowns

- **LRU `migratedSessionCache` interaction**: after the fallback path,
  the post-migration cache write (`migratedSessionCache.set(deviceKey, true)`)
  uses `${pnUser}.${deviceId}` as key. If a later real
  `getUSyncDevices` discovers a different device on the same user, the
  cache lookup `migratedSessionCache.has(deviceKey)` will see the
  device 0 entry as already migrated and skip it. That's the correct
  behavior (we *did* migrate it) — but it's worth a smoke check.
- **Multi-device contacts**: if the inbound is from device != 0
  (e.g. WhatsApp on a second phone), the fallback uses that device
  number from `fromJid`. Same migration logic applies. No regression
  expected vs. the old `device-list`-driven flow.
- **Cold start storms**: the patch makes `migrateSession` slightly
  heavier when `device-list` is empty (it actually queries the session
  and runs the transaction). For instances with thousands of cold
  contacts hitting at once, expect a small bump in Redis IOPS during
  the warm-up window. Not a concern at blackCredPix's scale.
