/**
 * RED test for Baileys issue #2548 — `migrateSession` early-returns when
 * `device-list` storage is empty, leaving the PN→LID session unmigrated.
 *
 * Repro context (production blackCredPix, 2026-05-22 ~07:39 UTC):
 *   • inbound msg from `<PN>@s.whatsapp.net` carries `senderAlt=<LID>@lid`
 *   • `lidMapping.getLIDForPN` already returns the LID (mapping exists)
 *   • Baileys calls `repository.migrateSession(PN, LID)` to move the active
 *     session record from PN-keyed storage (`<user>.<device>`) to LID-keyed
 *     storage (`<user>_1.<device>` for `WAJIDDomains.LID`).
 *   • Internally, `migrateSession` first asks `keys.get('device-list', [user])`
 *     for the known devices. In our Redis-backed adapter (and in any storage
 *     where `getUSyncDevices` never ran for that user — i.e. first inbound
 *     before any outbound), this lookup returns `{ [user]: null/undefined }`.
 *   • `migrateSession` then `return { migrated: 0, skipped: 0, total: 0 }`
 *     without inspecting whether a session already exists under `<user>.0`.
 *   • Downstream `decryptMessage({ jid: LID })` reads `session-<user>_1.0`
 *     → empty → "No session record" → retry cache → no `messages.upsert`.
 *
 * The existing fork patch (commit e450f4d1) forced `userDevices = null` to
 * mimic pre-rc.10 behavior — same early-return outcome, no rescue. This test
 * proves: even when there IS a real session under the PN address, the bug
 * leaves it unmigrated, decryption against the LID address subsequently fails.
 *
 * NOTE: file is `.mjs` because baileys is ESM-only and the package tsconfig
 * compiles to CommonJS — running this through `tsx` triggers a `require`
 * resolve for `whatsapp-rust-bridge`, which only exports `import` condition.
 * Native node ESM under `node --test` resolves cleanly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import libsignalPkg from 'libsignal';

import { makeLibSignalRepository } from 'baileys/lib/Signal/libsignal.js';

/**
 * Builds an in-memory SignalAuthState that mirrors the fork's Redis adapter
 * contract (`keys.get(type, ids) → { [id]: value }`, `keys.set(...)`).
 * Records `set` writes by category so tests can assert post-state.
 *
 * @param {{ sessions?: Record<string, Buffer|null>, deviceList?: Record<string, string[]|null>, lidForPn?: Record<string,string> }} opts
 */
function makeAuth(opts = {}) {
  const store = {
    session: { ...(opts.sessions ?? {}) },
    'device-list': { ...(opts.deviceList ?? {}) },
    'lid-mapping': {},
    'identity-key': {},
    'pre-key': {},
    'sender-key': {},
    'app-state-sync-key': {},
    'app-state-sync-version': {},
    'sender-key-memory': {},
  };

  const keys = {
    get: async (type, ids) => {
      const bucket = store[type] ?? {};
      const out = {};
      for (const id of ids) {
        out[id] = bucket[id] ?? null;
      }
      return out;
    },
    set: async (data) => {
      for (const [category, entries] of Object.entries(data)) {
        if (!store[category]) store[category] = {};
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) {
            delete store[category][id];
          } else {
            store[category][id] = value;
          }
        }
      }
    },
    transaction: async (fn) => fn(),
    isInTransaction: () => false,
  };

  // Stubbed creds — none of the migrateSession path uses them.
  const creds = {
    signedIdentityKey: { private: Buffer.alloc(32), public: Buffer.alloc(32) },
    signedPreKey: { keyPair: { private: Buffer.alloc(32), public: Buffer.alloc(32) } },
    registrationId: 1,
  };

  const lidForPnTable = opts.lidForPn ?? {};
  const pnToLIDFunc = async (jids) => {
    const out = [];
    for (const pn of jids) {
      if (lidForPnTable[pn]) out.push({ pn, lid: lidForPnTable[pn] });
    }
    return out;
  };

  return { auth: { creds, keys }, store, pnToLIDFunc };
}

const noopLogger = (() => {
  const fn = () => {};
  const log = { trace: fn, debug: fn, info: fn, warn: fn, error: fn, fatal: fn };
  log.child = () => log;
  return log;
})();

const PN_USER = '5521979579487';
const PN_JID = `${PN_USER}@s.whatsapp.net`;
const LID_USER = '245607872618564';
const LID_JID = `${LID_USER}@lid`;
// libsignal ProtocolAddress.toString() format: `${signalUser}.${device}`
// For PN (domainType=WHATSAPP=0) → bare user. For LID (domainType=1) → `<user>_1`.
const PN_SESSION_KEY = `${PN_USER}.0`;
const LID_SESSION_KEY = `${LID_USER}_1.0`;

/**
 * Build a real libsignal SessionRecord blob.
 *
 * `migrateSession`'s migration loop deserializes the fetched PN session via
 * `libsignal.SessionRecord.deserialize(pnSession)` and only counts it as
 * migrated when `fromSession.haveOpenSession()` returns true.
 */
function makeRealSessionBlob() {
  const record = new libsignalPkg.SessionRecord();
  // Build a SessionEntry — libsignal stores them on the record keyed by
  // indexInfo.baseKey (base64). `closed: -1` keeps the session "open" so
  // `haveOpenSession()` returns true (which migrateSession requires).
  const entry = libsignalPkg.SessionRecord.createEntry();
  entry.registrationId = 12345;
  entry.currentRatchet = {
    ephemeralKeyPair: {
      pubKey: Buffer.alloc(33, 1),
      privKey: Buffer.alloc(32, 1),
    },
    lastRemoteEphemeralKey: Buffer.alloc(33, 2),
    previousCounter: 0,
    rootKey: Buffer.alloc(32, 3),
  };
  entry.indexInfo = {
    baseKey: Buffer.alloc(33, 4),
    baseKeyType: 1,
    closed: -1,
    used: Date.now(),
    created: Date.now(),
    remoteIdentityKey: Buffer.alloc(33, 5),
  };
  record.setSession(entry);
  return record.serialize();
}

describe('Baileys migrateSession — issue #2548 reproduction', () => {
  it('RED: returns {migrated:0} when device-list is empty even though PN session exists', async () => {
    // Seed: real session under PN address (what production has),
    // device-list empty (fork's Redis state when getUSyncDevices never ran).
    const sessionBlob = makeRealSessionBlob();
    const { auth, store, pnToLIDFunc } = makeAuth({
      sessions: { [PN_SESSION_KEY]: sessionBlob },
      deviceList: {}, // empty — `keys.get('device-list', [PN_USER])` → { [PN_USER]: null }
      lidForPn: { [PN_JID]: LID_JID },
    });

    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);

    // Tell repo the LID mapping (matches production "LID mapping already exists" log)
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);

    const result = await repo.migrateSession(PN_JID, LID_JID);

    // Post-fix contract — all three must hold:
    //  • migrate must succeed (migrated == 1) — the fix recovers the PN session.
    //  • LID key must be populated — downstream decryptMessage(LID) will then load it.
    //  • PN key must be cleared — the migration is a move, not a copy.
    // Without the fix (pre-patch or e450f4d1's force-null), all three fail.
    assert.equal(
      result.migrated,
      1,
      `BUG (#2548): migrated must be 1 with fix, got ${result.migrated}. ` +
        `PN session blob existed but device-list was empty → early-return blocks migration. ` +
        `Storage state: session keys = ${JSON.stringify(Object.keys(store.session))}`,
    );
    assert.ok(
      store.session[LID_SESSION_KEY],
      `BUG (#2548): LID session key "${LID_SESSION_KEY}" must be populated after migrate. ` +
        `Current session storage: ${JSON.stringify(Object.keys(store.session))}`,
    );
    assert.equal(
      store.session[PN_SESSION_KEY],
      undefined,
      'fix: PN session removed after migration (move, not copy)',
    );
  });

  it('GREEN expectation: no-op when fromJid has no PN session at all (clean early-return)', async () => {
    // Negative case — fix must NOT fabricate migrations when there's nothing to migrate.
    const { auth, store, pnToLIDFunc } = makeAuth({
      sessions: {},
      deviceList: {},
      lidForPn: { [PN_JID]: LID_JID },
    });
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);

    const result = await repo.migrateSession(PN_JID, LID_JID);

    assert.equal(result.migrated, 0, 'no PN session present → no migration');
    assert.equal(
      store.session[LID_SESSION_KEY],
      undefined,
      'no PN session → must not fabricate a LID entry',
    );
  });

  it('contract: still no-op when fromJid is not a PN user (LID→LID or unsupported)', async () => {
    const { auth, pnToLIDFunc } = makeAuth({});
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    const lidFromJid = '111111111111@lid';
    const result = await repo.migrateSession(lidFromJid, LID_JID);
    // Spec contract from libsignal.js — non-PN fromJid → skipped (total=1, migrated=0).
    assert.equal(result.migrated, 0, 'non-PN fromJid → no migration');
  });

  it('contract: still no-op when toJid is not a LID (PN→PN or unsupported)', async () => {
    const { auth, pnToLIDFunc } = makeAuth({});
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    const result = await repo.migrateSession(PN_JID, '999999999@s.whatsapp.net');
    // Spec contract: non-LID toJid → { migrated:0, skipped:0, total:0 }.
    assert.equal(result.migrated, 0, 'non-LID toJid → no migration');
    assert.equal(result.total, 0);
  });
});

/**
 * V2 contract tests — issue #2548 follow-up.
 *
 * V1 patch (commit c78e977e) added a fallback to `fromJid`'s decoded device
 * when `device-list` storage is empty. That works when the peer's active
 * device is :0 (the default), but fails for multi-device peers (Linked
 * Devices / Desktop) whose active session lives at `<user>.<N>` for N != 0
 * — the fromJid in many callers has no device suffix, so the fallback
 * forces `userDevices = ['0']` and the real session at `.N` is never
 * discovered.
 *
 * V2 widens the signature: `migrateSession(fromJid, toJid, hintDevice?)`.
 * Callers that have device context (stanza receipts, USync results, own
 * device) can pass an explicit hint. Backwards-compatible: callers that
 * still call with two args fall through V1 behavior.
 */
describe('Baileys migrateSession V2 — device-aware via hintDevice (#2548 follow-up)', () => {
  it('TS-2.1: caller passes hintDevice → migrates session at hint device key', async () => {
    // Production scenario: peer's active session is under device :10 (linked desktop),
    // device-list cache empty (no outbound has triggered USync yet), fromJid is bare PN
    // (no :10 suffix because stanza.attrs.from didn't include it). V1 patch defaults to
    // '0' which is wrong; V2 uses the hint to look up the right slot.
    const HINT_DEVICE = 10;
    const HINT_SESSION_KEY = `${PN_USER}.${HINT_DEVICE}`;
    const HINT_LID_SESSION_KEY = `${LID_USER}_1.${HINT_DEVICE}`;
    const { auth, store, pnToLIDFunc } = makeAuth({
      sessions: { [HINT_SESSION_KEY]: makeRealSessionBlob() },
      deviceList: {},
      lidForPn: { [PN_JID]: LID_JID },
    });
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);

    const result = await repo.migrateSession(PN_JID, LID_JID, HINT_DEVICE);

    assert.equal(
      result.migrated,
      1,
      `V2 hint must rescue device-${HINT_DEVICE} session. Storage state: ` +
        JSON.stringify(Object.keys(store.session)),
    );
    assert.ok(
      store.session[HINT_LID_SESSION_KEY],
      `V2: LID session key "${HINT_LID_SESSION_KEY}" must be populated. ` +
        `Current: ${JSON.stringify(Object.keys(store.session))}`,
    );
    assert.equal(
      store.session[HINT_SESSION_KEY],
      undefined,
      'V2: PN session at hint device removed after migration (move semantics)',
    );
  });

  it('TS-2.2: regression — undefined hintDevice + bare fromJid still works (V1 path)', async () => {
    // Backwards-compat: callers that don't have device context call with 2 args.
    // Should keep V1 behavior — fallback to fromJid's decoded device (default '0').
    const { auth, store, pnToLIDFunc } = makeAuth({
      sessions: { [PN_SESSION_KEY]: makeRealSessionBlob() },
      deviceList: {},
      lidForPn: { [PN_JID]: LID_JID },
    });
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);

    // Explicitly pass undefined to assert the 3-arg signature is optional.
    const result = await repo.migrateSession(PN_JID, LID_JID, undefined);

    assert.equal(result.migrated, 1, 'V1 regression: undefined hint → fromJid device fallback');
    assert.ok(store.session[LID_SESSION_KEY], 'V1 regression: LID key populated via fromJid device');
  });

  it('TS-2.3: hintDevice has priority over fromJid-decoded device', async () => {
    // fromJid suggests device :5 (from stanza.attrs.from suffix), but caller
    // explicitly passes hintDevice=10 (e.g. extracted from <enc> child or
    // receipt). Hint must win and be included in the device list.
    const FROM_JID_WITH_DEVICE = `${PN_USER}:5@s.whatsapp.net`;
    const HINT_DEVICE = 10;
    const HINT_SESSION_KEY = `${PN_USER}.${HINT_DEVICE}`;
    const HINT_LID_SESSION_KEY = `${LID_USER}_1.${HINT_DEVICE}`;
    const { auth, store, pnToLIDFunc } = makeAuth({
      // Only the hint-device session exists; the fromJid-decoded device has no session.
      sessions: { [HINT_SESSION_KEY]: makeRealSessionBlob() },
      deviceList: {},
      lidForPn: { [PN_JID]: LID_JID, [FROM_JID_WITH_DEVICE]: LID_JID },
    });
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    await repo.lidMapping.storeLIDPNMappings([
      { lid: LID_JID, pn: PN_JID },
      { lid: LID_JID, pn: FROM_JID_WITH_DEVICE },
    ]);

    const result = await repo.migrateSession(FROM_JID_WITH_DEVICE, LID_JID, HINT_DEVICE);

    assert.equal(
      result.migrated,
      1,
      `V2: hint device ${HINT_DEVICE} must rescue session even when fromJid suggests :5`,
    );
    assert.ok(
      store.session[HINT_LID_SESSION_KEY],
      `V2: hint device LID session "${HINT_LID_SESSION_KEY}" must exist`,
    );
  });

  it('TS-2.4: device-list populated → hintDevice merged into list (no duplicate)', async () => {
    // When device-list IS populated (post-outbound, USync has run), the hint
    // device should be added to the list if not already present. Pre-existing
    // sessions still migrate; hint device's session also migrates.
    const HINT_DEVICE = 10;
    const HINT_SESSION_KEY = `${PN_USER}.${HINT_DEVICE}`;
    const HINT_LID_SESSION_KEY = `${LID_USER}_1.${HINT_DEVICE}`;
    const DEVICE_5_SESSION_KEY = `${PN_USER}.5`;
    const DEVICE_5_LID_SESSION_KEY = `${LID_USER}_1.5`;
    const { auth, store, pnToLIDFunc } = makeAuth({
      sessions: {
        [PN_SESSION_KEY]: makeRealSessionBlob(),       // device 0
        [DEVICE_5_SESSION_KEY]: makeRealSessionBlob(), // device 5
        [HINT_SESSION_KEY]: makeRealSessionBlob(),     // device 10 (hint)
      },
      deviceList: { [PN_USER]: ['0', '5'] }, // hint device NOT in list
      lidForPn: { [PN_JID]: LID_JID },
    });
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);

    const result = await repo.migrateSession(PN_JID, LID_JID, HINT_DEVICE);

    assert.equal(result.migrated, 3, 'V2: all 3 devices migrate (0, 5, 10) — hint merged');
    assert.ok(store.session[LID_SESSION_KEY], 'device 0 LID session present');
    assert.ok(store.session[DEVICE_5_LID_SESSION_KEY], 'device 5 LID session present');
    assert.ok(store.session[HINT_LID_SESSION_KEY], 'device 10 (hint) LID session present');
  });

  it('TS-2.5: device-list populated + hintDevice already in list → no duplicate, still migrates', async () => {
    // Idempotency: passing a hint that's already in the cached list must not
    // cause duplicates or extra lookups; result must be deterministic.
    const HINT_DEVICE = 5;
    const DEVICE_5_SESSION_KEY = `${PN_USER}.${HINT_DEVICE}`;
    const DEVICE_5_LID_SESSION_KEY = `${LID_USER}_1.${HINT_DEVICE}`;
    const { auth, store, pnToLIDFunc } = makeAuth({
      sessions: {
        [PN_SESSION_KEY]: makeRealSessionBlob(),
        [DEVICE_5_SESSION_KEY]: makeRealSessionBlob(),
      },
      deviceList: { [PN_USER]: ['0', '5'] },
      lidForPn: { [PN_JID]: LID_JID },
    });
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);

    const result = await repo.migrateSession(PN_JID, LID_JID, HINT_DEVICE);

    assert.equal(result.migrated, 2, 'V2: both devices migrate, no duplicate from hint');
    assert.ok(store.session[LID_SESSION_KEY], 'device 0 migrated');
    assert.ok(store.session[DEVICE_5_LID_SESSION_KEY], 'device 5 migrated');
  });

  it('TS-2.6: hintDevice as string accepted (caller-friendly typing)', async () => {
    // Some callers extract device from JID via jidDecode (returns number) but
    // others may already have it stringified. Both should work.
    const HINT_DEVICE = '10';
    const HINT_SESSION_KEY = `${PN_USER}.10`;
    const HINT_LID_SESSION_KEY = `${LID_USER}_1.10`;
    const { auth, store, pnToLIDFunc } = makeAuth({
      sessions: { [HINT_SESSION_KEY]: makeRealSessionBlob() },
      deviceList: {},
      lidForPn: { [PN_JID]: LID_JID },
    });
    const repo = makeLibSignalRepository(auth, noopLogger, pnToLIDFunc);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID_JID, pn: PN_JID }]);

    const result = await repo.migrateSession(PN_JID, LID_JID, HINT_DEVICE);

    assert.equal(result.migrated, 1, 'V2: string hint device accepted');
    assert.ok(store.session[HINT_LID_SESSION_KEY], 'V2: LID session under string hint device');
  });
});
