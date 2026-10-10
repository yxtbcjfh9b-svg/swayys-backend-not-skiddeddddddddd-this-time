// language: JS, file: src/reload.js, runtime: node 24
// Better-Reload-compatible responses: vendored JSONs + exact shapes proven against real clients.
// Overrides game.js stubs where they differ (tryPlay text/plain, setting [], waitingroom 204,
// enabled_features list, socialban, epic-settings, discovery assets, br-inventory, world/info).
import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { authRequired } from "./auth.js";
import { buildCatalog } from "./shop.js";

export const reload = Router();
const V = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "better-reload");
const load = (n) => { try { return JSON.parse(readFileSync(join(V, n), "utf8")); } catch { return null; } };
const contentpages = load("responses_contentpages.json");
const catalog = load("responses_catalog.json");
// backfill empty daily/weekly storefronts from the season pool (empty = "No Offers Available")
try {
  const pool = (catalog?.storefronts || []).flatMap(s => s.catalogEntries || []);
  for (const s of catalog?.storefronts || []) {
    if ((s.catalogEntries || []).length === 0 && pool.length) {
      s.catalogEntries = pool.slice(0, s.name.includes("Daily") ? 6 : 4);
      // stagger panels so daily/weekly don't mirror each other exactly
      if (s.name.includes("Weekly")) s.catalogEntries = pool.slice(6, 10);
    }
  }
} catch {}
const keychain = load("responses_keychain.json");
const epicSettings = load("responses_epic-settings.json");
let timelineSrc = null;
try { timelineSrc = readFileSync(join(V, "routes_timeline.js"), "utf8"); } catch {}

// exact-shape overrides (Better-Reload parity)
reload.post("/fortnite/api/game/v2/tryPlayOnPlatform/account/:id", (_, res) => {
  res.setHeader("Content-Type", "text/plain"); res.send("true");
});
reload.post("/api/v1/user/setting", authRequired, (_, res) => res.json([]));
reload.get("/waitingroom/api/waitingroom", (_, res) => res.status(204).end());
reload.get("/fortnite/api/game/v2/enabled_features", (_, res) =>
  res.json(["LiveEvents", "BattleRoyale", "Creative", "SaveTheWorld"]));
reload.get("/socialban/api/public/v1/:rest(*)", (_, res) => res.json({ bans: [], warnings: [] }));
reload.all("/v1/epic-settings/public/users/:rest(*)", (_, res) => res.json(epicSettings || {}));
reload.post("/api/v1/assets/Fortnite/:rest(*)", (req, res) => {
  if (req.body?.FortCreativeDiscoverySurface == 0)
    return res.json({ FortCreativeDiscoverySurface: { meta: { promotion: 0 }, assets: {} } });
  res.json({ FortCreativeDiscoverySurface: { meta: { promotion: req.body?.FortCreativeDiscoverySurface || 0 }, assets: {} } });
});
reload.get("/fortnite/api/game/v2/br-inventory/account/:id", (_, res) => res.json({ stash: { globalcash: 0 } }));
reload.get("/fortnite/api/game/v2/world/info", (_, res) => res.json({}));
reload.get("/fortnite/api/game/v2/twitch/:rest(*)", (_, res) => res.status(200).end());
reload.post("/fortnite/api/game/v2/chat/:rest(*)", (_, res) => res.json({ GlobalChatRooms: [{ roomName: "voidglobal" }] }));
reload.get("/fortnite/api/game/v2/leaderboards/cohort/:rest(*)", (_, res) => res.json([]));
reload.get("/fortnite/api/game/v2/events/tournamentandhistory/:rest(*)", (_, res) => res.json({}));
reload.post("/fortnite/api/game/v2/events/v2/setSubgroup/:rest(*)", (_, res) => res.status(204).end());
reload.get("/fortnite/api/stats/accountId/:id/bulk/window/alltime", (req, res) =>
  res.json({ startTime: 0, endTime: 0, stats: {}, accountId: req.params.id }));

// vendored file responses (contentpages + keychain stay; catalog built fresh in shop.js)
if (contentpages) reload.get("/content/api/pages/fortnite-game", (_, res) => res.json(contentpages));
// fresh C2S2 shop (replaces vendored current-season catalog)
reload.get("/fortnite/api/storefront/v2/catalog", authRequired, (_, res) => res.json(buildCatalog()));
reload.get("/catalog/api/shared/bulk/offers", authRequired, (_, res) => res.json(buildCatalog()));
if (keychain) reload.get("/fortnite/api/storefront/v2/keychain", authRequired, (_, res) => res.json(keychain));
// Chapter 2 Season 2 timeline: seasonNumber 12 drives lobby CHAPTER/SEASON text,
// BP tab tiers, and event flags (SpyGames + StormTheAgency era)
reload.get("/fortnite/api/calendar/v1/timeline", (_, res) => {
  const state = {
    activeStorefronts: [], eventNamedWeights: {},
    seasonNumber: 12, seasonTemplateId: "AthenaSeason:athenaseason12",
    matchXpBonusPoints: 0, seasonBegin: "2020-02-20T13:00:00Z",
    seasonEnd: "9999-01-01T14:00:00Z", seasonDisplayedEnd: "9999-01-01T07:30:00Z",
    weeklyStoreEnd: "9999-01-01T00:00:00.000Z",
    sectionStoreEnds: { Featured: "9999-01-01T00:00:00.000Z" },
    dailyStoreEnd: "9999-01-01T00:00:00.000Z",
  };
  const ev = (t) => ({ eventType: t, activeUntil: "9999-01-01T00:00:00.000Z", activeSince: "2020-01-01T00:00:00.000Z" });
  const seasonState = [{ validFrom: "0001-01-01T00:00:00.000Z",
    activeEvents: [ev("EventFlag.Season12"), ev("EventFlag.LTE_SpyGames"),
      ev("EventFlag.LTE_JerkyChallenges"), ev("EventFlag.LTE_Oro"), ev("EventFlag.LTE_StormTheAgency")],
    state }];
  res.json({
    channels: {
      "client-matchmaking": { states: seasonState, cacheExpire: "9999-01-01T00:00:00.000Z" },
      "client-events": { states: seasonState, cacheExpire: "9999-01-01T00:00:00.000Z" },
    },
    eventsTimeOffsetHrs: 0, cacheIntervalMins: 10, currentTime: new Date().toISOString(),
  });
});
