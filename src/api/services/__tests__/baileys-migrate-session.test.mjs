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

    // The smoking gun for the unpatched / pre-fix world: session still under PN key.
    assert.ok(store.session[PN_SESSION_KEY], 'PN session must still be in storage');

    // Post-fix, BOTH assertions should hold:
    //  • migrate must succeed (migrated >= 1) — the fix recovers the session.
    //  • LID key must be populated — downstream decryptMessage(LID) will then load it.
    // Without the fix, both fail (the bug state) — this is the RED proof.
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
