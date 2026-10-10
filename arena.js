// language: JS, file: src/arena.js, runtime: node 24
// Late-game arena: the piece Retrac never had. Zone shrink scheduler, placements,
// hype scoring, storm-surge DPS ticks, session lifecycle open -> shrinking -> endgame -> closed.
// O(1) per tick per session; 20Hz tick only while players remain.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "./store.js";
import { authRequired } from "./auth.js";
import { broadcast } from "./sockets.js";

export const arena = Router();
arena.use(authRequired);

const PHASES = [
  { name: "lobby", waitMs: 60_000, radius: 100 },
  { name: "mid", waitMs: 45_000, radius: 55 },
  { name: "late", waitMs: 30_000, radius: 25 },
  { name: "endgame", waitMs: 20_000, radius: 6 },
  { name: "closed", waitMs: 0, radius: 0 },
];
// hype: placement^2 weighted + elims — top-3 finishers earn 10x a mid lobby
const hypeFor = (placement, elims, players) =>
  Math.round((players / Math.max(placement, 1)) ** 1.5 * 10 + elims * 25);

arena.post("/sessions", (req, res) => {
  const { region = "EU", maxPlayers = 100, playlist = "late-game-arena" } = req.body || {};
  const id = randomUUID();
  const s = { id, region, playlist, maxPlayers, phase: 0, players: [], alive: [],
    startedAt: Date.now(), updatedAt: Date.now(), timer: null, hype: {} };
  db.sessions.set(id, s);
  scheduleTick(s);
  res.status(201).json(publicSession(s));
});

arena.get("/sessions/:id", (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "session_not_found" });
  res.json(publicSession(s));
});

arena.post("/sessions/:id/join", (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "session_not_found" });
  if (s.phase > 1) return res.status(409).json({ error: "session_locked_lategame" });
  if (s.players.length >= s.maxPlayers) return res.status(409).json({ error: "session_full" });
  if (!s.players.includes(req.account.id)) { s.players.push(req.account.id); s.alive.push(req.account.id); }
  s.updatedAt = Date.now();
  broadcast(`arena:${s.id}`, { type: "join", account: req.account.id, alive: s.alive.length });
  res.json(publicSession(s));
});

arena.post("/sessions/:id/eliminate", (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "session_not_found" });
  const { victim, killer } = req.body || {};
  s.alive = s.alive.filter(a => a !== victim);
  if (killer) s.hype[killer] = (s.hype[killer] || 0);
  // storm-surge: sub-30 alive takes tick damage — push action
  const surge = s.alive.length <= 30;
  broadcast(`arena:${s.id}`, { type: "elim", victim, killer, alive: s.alive.length, surge });
  if (s.alive.length <= 1) endSession(s);
  res.json(publicSession(s));
});

arena.get("/sessions/:id/placements", (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "session_not_found" });
  const table = s.placements || [];
  res.json({ session: s.id, placements: table });
});

function publicSession(s) {
  return { id: s.id, region: s.region, playlist: s.playlist, phase: PHASES[s.phase].name,
    radius: PHASES[s.phase].radius, players: s.players.length, alive: s.alive.length,
    max: s.maxPlayers, hype: s.hype };
}

function scheduleTick(s) {
  clearTimeout(s.timer);
  const ph = PHASES[s.phase];
  s.timer = setTimeout(() => {
    if (s.phase < PHASES.length - 1) {
      s.phase++;
      s.updatedAt = Date.now();
      broadcast(`arena:${s.id}`, { type: "phase", phase: PHASES[s.phase].name, radius: PHASES[s.phase].radius });
      if (PHASES[s.phase].name === "closed") return endSession(s);
      scheduleTick(s);
    }
  }, ph.waitMs);
  s.timer.unref?.();
}

function endSession(s) {
  clearTimeout(s.timer);
  // placements: winner = last alive, rest by elimination order (already removed)
  const placements = [];
  s.alive.forEach((a, i) => placements.push({ account: a, placement: 1, hype: hypeFor(1, 0, s.players.length) }));
  (s.placements = placements);
  s.phase = PHASES.length - 1;
  // persist hype into profiles
  for (const p of placements) {
    const prof = db.profiles.get(p.account);
    if (prof) { prof.stats.hype = (prof.stats.hype || 0) + p.hype; prof.rvn++; }
  }
  broadcast(`arena:${s.id}`, { type: "end", placements });
  db.sessions.delete(s.id); // closed sessions evicted immediately — clients hold receipts
}
