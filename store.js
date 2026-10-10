// language: JS, file: src/store.js, runtime: node 24
// In-memory store with JSON snapshot. Swap for postgres when you outgrow single-box.
// *watch for unbounded growth on parties/sessions maps — TTL sweep runs every 60s, tune PARTY_TTL_MS for your CCU*
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SNAP = "./void-snap.json";
export const db = {
  accounts: new Map(),   // id -> { id, displayName, created, banned, admin }
  tokens: new Map(),     // token -> { accountId, expires }
  profiles: new Map(),   // accountId -> { rvn, items: {}, stats: {} }
  parties: new Map(),    // partyId -> party
  sessions: new Map(),   // sessionId -> matchmaking session
  servers: new Map(),    // serverId -> { id, region, status, players:[], max }
  friends: new Map(),    // accountId -> Set(accountId)
  shop: { catalog: null, expires: 0 },
  balances: new Map(),   // accountId -> MtxPurchased qty (shared by athena + common_core)
};

export const getBal = (id) => db.balances.get(id) ?? 5000;
export const setBal = (id, qty) => { db.balances.set(id, Math.max(0, qty)); };

export function snapshot() {
  try {
    writeFileSync(SNAP, JSON.stringify({
      accounts: [...db.accounts], profiles: [...db.profiles],
      friends: [...db.friends].map(([k, v]) => [k, [...v]]),
      balances: [...db.balances],
    }));
  } catch {}
}
export function restore() {
  try {
    if (!existsSync(SNAP)) return;
    const s = JSON.parse(readFileSync(SNAP, "utf8"));
    db.accounts = new Map(s.accounts || []);
    db.profiles = new Map(s.profiles || []);
    db.friends = new Map((s.friends || []).map(([k, v]) => [k, new Set(v)]));
    db.balances = new Map(s.balances || []);
  } catch {}
}
setInterval(snapshot, 30_000).unref();

// TTL sweep for stale parties/sessions (Retrac leaked these — we don't)
const PARTY_TTL = 6 * 3600_000, SESSION_TTL = 30 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of db.parties)
    if (now - p.updatedAt > PARTY_TTL || p.members.length === 0) db.parties.delete(id);
  for (const [id, s] of db.sessions)
    if (now - s.updatedAt > SESSION_TTL) db.sessions.delete(id);
}, 60_000).unref();
