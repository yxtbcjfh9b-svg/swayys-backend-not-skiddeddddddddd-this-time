// language: JS, file: src/parties.js, runtime: node 24
// Party management: create/invite/join/promote/kick/patch + member meta + pings.
// Improves Retrac: revision counters, captain auto-failover, max-size guard, per-party sockets fan-out.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "./store.js";
import { authRequired } from "./auth.js";
import { broadcast } from "./sockets.js";

export const parties = Router();
parties.use(authRequired);
const MAX = 16;

function touch(p) { p.updatedAt = Date.now(); p.revision++; return p; }
function pub(p) {
  return { id: p.id, revision: p.revision, created_at: p.createdAt, updated_at: new Date(p.updatedAt).toISOString(),
    config: p.config, members: p.members, invites: p.invites, intentions: p.intentions };
}

parties.get("/user/:accountId", (req, res) => {
  const mine = [...db.parties.values()].filter(p => p.members.some(m => m.account_id === req.params.accountId));
  res.json({ current: mine.map(pub), pending: [], invitations: [], ping: [] });
});
parties.get("/user/:accountId/settings/privacy", (_, res) => res.json({ privacy: "public" }));
parties.get("/user/:accountId/notifications/undelivered/count", (_, res) => res.json(0));
parties.get("/user/:accountId/pings/:friendId/parties", (_, res) => res.json([]));
parties.post("/user/:accountId/pings/:friendId/join", (req, res) => {
  const p = [...db.parties.values()].find(p => p.members.some(m => m.account_id === req.params.friendId));
  if (!p) return res.status(404).json({ error: "no_party" });
  return res.json(pub(joinMember(p, req.params.accountId)));
});
parties.delete("/user/:accountId/pings/:friendId", (_, res) => res.json({}));

parties.get("/parties/:partyId", (req, res) => {
  const p = db.parties.get(req.params.partyId);
  if (!p) return res.status(404).json({ error: "party_not_found" });
  res.json(pub(p));
});

parties.post("/parties", (req, res) => {
  const id = randomUUID();
  const me = req.account.id;
  const p = { id, revision: 0, createdAt: new Date().toISOString(), updatedAt: Date.now(),
    config: { joinability: "OPEN", discoverability: "ALL", max_size: MAX, ...(req.body?.config || {}) },
    members: [{ account_id: me, role: "CAPTAIN", joined_at: new Date().toISOString(), meta: {} }],
    invites: [], intentions: [] };
  db.parties.set(id, p);
  broadcast(`party:${id}`, { type: "party_created", party: pub(p) });
  res.status(201).json(pub(p));
});

parties.post("/parties/:partyId/invites/:accountId", (req, res) => {
  const p = db.parties.get(req.params.partyId);
  if (!p) return res.status(404).json({ error: "party_not_found" });
  p.invites.push({ sent_by: req.account.id, sent_to: req.params.accountId, sent_at: new Date().toISOString() });
  broadcast(`user:${req.params.accountId}`, { type: "invite", party_id: p.id });
  res.json(pub(touch(p)));
});

function joinMember(p, accountId) {
  if (p.members.some(m => m.account_id === accountId)) return touch(p);
  if (p.members.length >= (p.config.max_size || MAX)) throw new Error("party_full");
  p.members.push({ account_id: accountId, role: "MEMBER", joined_at: new Date().toISOString(), meta: {} });
  broadcast(`party:${p.id}`, { type: "member_joined", account_id: accountId, party: pub(touch(p)) });
  return p;
}
parties.post("/parties/:partyId/members/:accountId/join", (req, res) => {
  const p = db.parties.get(req.params.partyId);
  if (!p) return res.status(404).json({ error: "party_not_found" });
  try { res.json(pub(joinMember(p, req.params.accountId))); }
  catch { res.status(409).json({ error: "party_full" }); }
});
parties.post("/parties/:partyId/members/:accountId/promote", (req, res) => {
  const p = db.parties.get(req.params.partyId);
  if (!p) return res.status(404).json({ error: "party_not_found" });
  for (const m of p.members) m.role = m.account_id === req.params.accountId ? "CAPTAIN" : "MEMBER";
  broadcast(`party:${p.id}`, { type: "promoted", account_id: req.params.accountId });
  res.json(pub(touch(p)));
});
parties.patch("/parties/:partyId", (req, res) => {
  const p = db.parties.get(req.params.partyId);
  if (!p) return res.status(404).json({ error: "party_not_found" });
  Object.assign(p.config, req.body?.config || req.body || {});
  broadcast(`party:${p.id}`, { type: "party_updated", party: pub(touch(p)) });
  res.json(pub(p));
});
parties.patch("/parties/:partyId/members/:accountId/meta", (req, res) => {
  const p = db.parties.get(req.params.partyId);
  if (!p) return res.status(404).json({ error: "party_not_found" });
  const m = p.members.find(m => m.account_id === req.params.accountId);
  if (!m) return res.status(404).json({ error: "member_not_found" });
  const { delete: del, update } = req.body || {};
  m.meta = m.meta || {};
  for (const k of del || []) delete m.meta[k];
  Object.assign(m.meta, update || {});
  broadcast(`party:${p.id}`, { type: "member_meta", account_id: m.account_id, meta: m.meta });
  res.json(pub(touch(p)));
});
parties.delete("/parties/:partyId/members/:accountId", (req, res) => {
  const p = db.parties.get(req.params.partyId);
  if (!p) return res.status(404).json({ error: "party_not_found" });
  const wasCaptain = p.members.find(m => m.account_id === req.params.accountId)?.role === "CAPTAIN";
  p.members = p.members.filter(m => m.account_id !== req.params.accountId);
  if (wasCaptain && p.members.length) p.members[0].role = "CAPTAIN"; // auto-failover (Retrac didn't)
  broadcast(`party:${p.id}`, { type: "member_left", account_id: req.params.accountId });
  if (!p.members.length) db.parties.delete(p.id);
  res.status(204).end();
});
parties.post("/members/:friendId/intentions/:accountId", (req, res) => {
  res.json({ intention_id: randomUUID(), requester: req.params.accountId, target: req.params.friendId });
});
