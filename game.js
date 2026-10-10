// language: JS, file: src/game.js, runtime: node 24
// Account, profile, friends, shop, stats, matchmaking ticket, lightswitch, waiting room.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "./store.js";
import { authRequired, mintToken, godAccounts } from "./auth.js";
import { findOffer } from "./shop.js";
import { getBal, setBal } from "./store.js";

export const game = Router();
godAccounts();

// ---- account / oauth (Retrac parity, no fake verify) ----
game.post("/account/api/oauth/token", (req, res) => {
  const b = req.body || {};
  // grant_type=password (email+password from /void-register) or exchange_code, or bare launcher login
  if (b.grant_type === "exchange_code" && b.exchange_code) {
    const sess = db.tokens.get("xc_" + b.exchange_code);
    if (!sess) return res.status(400).json({ error: "invalid_exchange" });
    const acc = db.accounts.get(sess.accountId);
    const token = mintToken(acc.id);
    return res.json({ access_token: token, expires_in: 28800, token_type: "bearer",
      account_id: acc.id, displayName: acc.displayName });
  }
  const login = b.username || b.email || b.displayName || "";
  const pass = b.password || "";
  let acc = [...db.accounts.values()].find(a =>
    a.displayName.toLowerCase() === String(login).toLowerCase() ||
    (a.email && a.email.toLowerCase() === String(login).toLowerCase()));
  if (acc && acc.password && pass && acc.password !== pass)
    return res.status(401).json({ error: "invalid_credentials" });
  if (!acc) {
    const name = b.displayName || login || "VoidPlayer" + Math.floor(Math.random() * 9999);
    const id = randomUUID();
    acc = { id, displayName: name, created: new Date().toISOString(), banned: false, admin: false };
    db.accounts.set(id, acc);
    db.profiles.set(id, { rvn: 0, items: { "athena:pickaxe:default": 1 }, stats: {} });
  }
  if (acc.banned) return res.status(403).json({ error: "banned" });
  const token = mintToken(acc.id);
  res.json({ access_token: token, expires_in: 28800, token_type: "bearer",
    account_id: acc.id, displayName: acc.displayName, expires_at: new Date(Date.now() + 28800_000).toISOString() });
});
game.get("/account/api/oauth/exchange", authRequired, (req, res) => {
  const code = randomUUID().replaceAll("-", "");
  db.tokens.set("xc_" + code, { accountId: req.account.id, expires: Date.now() + 60_000 });
  res.json({ expiresInSeconds: 60, code, creatingClientId: "void" });
});
game.get("/account/api/oauth/verify", authRequired, (req, res) =>
  res.json({ token: "valid", account_id: req.account.id, displayName: req.account.displayName }));
game.get("/account/api/public/account", (req, res) => {
  const ids = (req.query.accountId || "").split(",").filter(Boolean);
  res.json(ids.map(id => db.accounts.get(id)).filter(Boolean).map(a => ({ id: a.id, displayName: a.displayName, avatarInfos: [] })));
});
game.get("/account/api/public/account/:id", (req, res) => {
  const a = db.accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not_found" });
  res.json({ id: a.id, displayName: a.displayName, avatarInfos: [] });
});
game.get("/account/api/public/account/displayName/:name", (req, res) => {
  const a = [...db.accounts.values()].find(a => a.displayName.toLowerCase() === req.params.name.toLowerCase());
  if (!a) return res.status(404).json({ error: "not_found" });
  res.json({ id: a.id, displayName: a.displayName, avatarInfos: [] });
});
game.get("/account/api/public/account/:id/externalAuths", (_, res) => res.json([]));
game.delete("/account/api/oauth/sessions/kill/:token", authRequired, (req, res) => {
  db.tokens.delete(req.params.token); res.status(204).end();
});
game.delete("/account/api/oauth/sessions/kill", authRequired, (req, res) => {
  // killType=OTHERS_ACCOUNT_CLIENT_SERVICE — drop all other tokens for this account
  const mine = (req.headers.authorization || "").slice(7);
  for (const [t, s] of db.tokens)
    if (s.accountId === req.account.id && t !== mine && !t.startsWith("xc_")) db.tokens.delete(t);
  res.status(204).end();
});
game.post("/api/v1/user/setting", authRequired, (_, res) => res.json({}));
// ---- discord-linked registration (void-register) ----
game.post("/account/api/register", (req, res) => {
  const { discordId, username, email, password } = req.body || {};
  if (!username || username.length < 3) return res.status(400).json({ error: "username_min_3" });
  if (username.length > 20) return res.status(400).json({ error: "username_max_20" });
  if ([...db.accounts.values()].some(a => a.email === email))
    return res.status(409).json({ error: "discord_already_registered" });
  if ([...db.accounts.values()].some(a => a.displayName.toLowerCase() === String(username).toLowerCase()))
    return res.status(409).json({ error: "username_taken" });
  const id = randomUUID();
  db.accounts.set(id, { id, displayName: username, email, password, discordId,
    created: new Date().toISOString(), banned: false, admin: false });
  db.profiles.set(id, { rvn: 0, items: { "athena:pickaxe:default": 1 }, stats: {} });
  res.status(201).json({ id, displayName: username });
});

// Real 12.41 templateIds (verified vs fortnite-api): CID_001..008 defaults,
// AthenaPickaxe:DefaultPickaxe, AthenaGlider:DefaultGlider, AthenaDance:EID_DanceMoves
const DEFAULT_CHARS = [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
  `AthenaCharacter:CID_00${n}_Athena_Commando_${n % 2 ? "F" : "M"}_Default`);
const D_PICK = "AthenaPickaxe:DefaultPickaxe";
const D_GLIDE = "AthenaGlider:DefaultGlider";
const D_DANCE = "AthenaDance:EID_DanceMoves";
function defaultItems() {
  const items = {};
  for (const c of DEFAULT_CHARS)
    items[c] = { templateId: c, attributes: { favorite: false, item_seen: true, variants: [] }, quantity: 1 };
  items[D_PICK] = { templateId: D_PICK, attributes: { favorite: false, item_seen: true }, quantity: 1 };
  items[D_GLIDE] = { templateId: D_GLIDE, attributes: { favorite: false, item_seen: true }, quantity: 1 };
  items[D_DANCE] = { templateId: D_DANCE, attributes: { favorite: false, item_seen: true }, quantity: 1 };
  items["Currency:MtxPurchased"] = { templateId: "Currency:MtxPurchased", attributes: { platform: "EpicPC" }, quantity: 5000 };
  items["AthenaBattlePass:spbattlepasserseason12"] = { templateId: "AthenaBattlePass:spbattlepasserseason12", attributes: { book_purchased: true, book_level: 1 }, quantity: 1 };
  return items;
}
function defaultLocker() {
  return { templateId: "CosmeticLocker:cosmeticlocker_athena", attributes: {
    locker_slots_data: { slots: {
      Character: { items: [DEFAULT_CHARS[0]] },
      Pickaxe: { items: [D_PICK] },
      Glider: { items: [D_GLIDE] },
      Dance: { items: [D_DANCE] },
      ItemWrap: { items: [] } } },
    banner_icon_template: "BannerIcon:BR_Season_01", banner_color_template: "BannerColor:DefaultColor1",
    locker_name: "locker" }, quantity: 1 };
}
function athenaInit() {
  const now = new Date().toISOString();
  const lockerId = randomUUID();
  const items = defaultItems();
  items[lockerId] = defaultLocker();
  return {
    created: now, updated: now, rvn: 0, wipeNumber: 1,
    accountId: "", profileId: "athena",
    version: "void_1", lockerId,
    items,
    stats: { attributes: { level: 1, xp: 0, battlestars: 0, battlestars_season_total: 0,
      loadouts: [lockerId], active_loadout_index: 0,
      book_level: 1, book_xp: 0, book_purchased: true, season_match_boost: 0, mfa_enabled: false,
      favorite_character: "AthenaCharacter:CID_001_Athena_Commando_F_Default",
      favorite_pickaxe: "AthenaPickaxe:DefaultPickaxe",
      favorite_glider: "AthenaGlider:DefaultGlider",
      favorite_dance: ["AthenaDance:EID_DanceMoves"], favorite_itemwraps: [],
      last_applied_loadout: "locker", hide_other_console_users_name: false, intro_game_completed: true,
      impostors_completed: 0, monthly_active_squad_count: 0, homescreen_season: 12 } },
    commandRevision: 0,
  };
}
function mcpResp(prof, changes) {
  prof.commandRevision = (prof.commandRevision || 0) + 1;
  return { profileRevision: prof.rvn, profileId: "athena",
    profileChangesBaseRevision: prof.rvn - (changes.length ? 1 : 0),
    profileChanges: changes, profileCommandRevision: prof.commandRevision,
    serverTime: new Date().toISOString(), responseVersion: 1 };
}
game.post("/fortnite/api/game/v2/profile/:accountId/client/:action", authRequired, (req, res) => {
  const { accountId, action } = req.params;
  // common_core holds the vbuck wallet — separate light profile, shared balance
  if (req.query.profileId === "common_core") {
    const bal = getBal(accountId);
    const items = { "Currency:MtxPurchased": { templateId: "Currency:MtxPurchased", attributes: { platform: "EpicPC" }, quantity: bal } };
    return res.json(action === "QueryProfile"
      ? { profileRevision: 1, profileId: "common_core", profileChangesBaseRevision: 0,
          profileChanges: [{ changeType: "fullProfileUpdate", profile: { _type: "Account Item Store", created: new Date().toISOString(), updated: new Date().toISOString(), rvn: 0, wipeNumber: 1, accountId, profileId: "common_core", version: "void_1", items, stats: { attributes: {} }, commandRevision: 0 } }],
          profileCommandRevision: 0, serverTime: new Date().toISOString(), responseVersion: 1 }
      : { profileRevision: 1, profileId: "common_core", profileChangesBaseRevision: 1, profileChanges: [], profileCommandRevision: 1, serverTime: new Date().toISOString(), responseVersion: 1 });
  }
  let prof = db.profiles.get(accountId);
  // legacy "locker"-keyed or fake-ID profiles get rebuilt (stats/xp kept)
  const hasFake = prof && prof.items && Object.keys(prof.items).some(k => k.includes("_Tester") || k.includes("asset_"));
  const lockerOk = prof && prof.items && prof.lockerId && prof.items[prof.lockerId];
  if (!lockerOk || hasFake) {
    const keepStats = prof?.stats, keepRvn = prof?.rvn || 0;
    prof = athenaInit(); prof.accountId = accountId;
    if (keepStats) prof.stats = keepStats;
    prof.rvn = keepRvn;
    db.profiles.set(accountId, prof);
  }
  const L = prof.items[prof.lockerId];
  // backfill newer attrs onto older profiles without wiping progress
  prof.stats = prof.stats || {};
  prof.stats.attributes = prof.stats.attributes || {};
  prof.stats.attributes.book_purchased = true;
  // 12.41 reads the active loadout from stats — backfill if missing
  if (!Array.isArray(prof.stats.attributes.loadouts) || !prof.stats.attributes.loadouts.includes(prof.lockerId)) {
    prof.stats.attributes.loadouts = [prof.lockerId];
    prof.stats.attributes.active_loadout_index = 0;
  }
  if (!prof.items["AthenaBattlePass:spbattlepasserseason12"])
    prof.items["AthenaBattlePass:spbattlepasserseason12"] = { templateId: "AthenaBattlePass:spbattlepasserseason12", attributes: { book_purchased: true, book_level: prof.stats.attributes.book_level || 1 }, quantity: 1 };
  const b = req.body || {};
  let changes = [];
  if (action === "QueryProfile") { /* full state ships below */ }
  else if (action === "SetCosmeticLockerSlot" || action === "EquipBattleRoyaleCustomization") {
    const slot = b.slotName || b.category || "Character";
    const item = b.itemToSlot || b.item || b.itemId || "";
    const slots = L.attributes.locker_slots_data.slots;
    if (slots[slot]) { slots[slot].items = [item]; changes = [{ changeType: "itemAttrChanged", itemId: prof.lockerId, attributeName: "slots" }]; }
    if (slot === "Character") prof.stats.attributes.favorite_character = item;
    prof.rvn++;
  }
  else if (action === "SetActiveLoadout") {
    const idx = b.targetIndex ?? b.index ?? 0;
    if (prof.stats.attributes.loadouts?.[idx]) {
      prof.stats.attributes.active_loadout_index = idx;
      changes = [{ changeType: "statModified", name: "active_loadout_index", value: idx }];
    }
    prof.rvn++;
  }
  else if (action === "CopyCosmeticLoadout") {
    const src = prof.items[prof.stats.attributes.loadouts?.[b.sourceIndex ?? 0]];
    if (src) {
      const nid = randomUUID();
      prof.items[nid] = JSON.parse(JSON.stringify(src));
      prof.stats.attributes.loadouts.push(nid);
      changes = [{ changeType: "itemAdded", itemId: nid, item: prof.items[nid] },
        { changeType: "statModified", name: "loadouts", value: prof.stats.attributes.loadouts }];
    }
    prof.rvn++;
  }
  else if (action === "DeleteCosmeticLoadout") {
    const gone = prof.stats.attributes.loadouts?.splice(b.index ?? b.fallbackLoadoutIndex ?? -1, 1);
    if (gone?.[0]) { delete prof.items[gone[0]]; changes = [{ changeType: "itemRemoved", itemId: gone[0] }]; }
    if (prof.stats.attributes.active_loadout_index >= prof.stats.attributes.loadouts.length)
      prof.stats.attributes.active_loadout_index = 0;
    prof.rvn++;
  }
  else if (action === "SetCosmeticLockerName") {
    const L2 = prof.items[prof.stats.attributes.loadouts?.[b.loadoutIndex ?? prof.stats.attributes.active_loadout_index ?? 0]];
    if (L2) { L2.attributes.locker_name = b.name || L2.attributes.locker_name; changes = [{ changeType: "itemAttrChanged", itemId: prof.stats.attributes.loadouts[prof.stats.attributes.active_loadout_index], attributeName: "locker_name" }]; }
    prof.rvn++;
  }
  else if (action === "SetCosmeticLockerBanner") {
    prof.items[prof.lockerId].attributes.banner_icon_template = b.bannerIconTemplateName || L.attributes.banner_icon_template;
    prof.items[prof.lockerId].attributes.banner_color_template = b.bannerColorTemplateName || L.attributes.banner_color_template;
    changes = [{ changeType: "itemAttrChanged", itemId: prof.lockerId, attributeName: "banner" }];
    prof.rvn++;
  }
  else if (action === "PurchaseCatalogEntry") {
    const offer = findOffer(b.offerId);
    if (!offer) { prof.rvn++; }
    else {
      const bal = getBal(accountId);
      if (bal < offer.price) { prof.rvn++; }
      else {
        setBal(accountId, bal - offer.price);
        prof.items["Currency:MtxPurchased"].quantity = bal - offer.price;
        prof.items[offer.id] = { templateId: offer.id,
          attributes: { favorite: false, item_seen: false, variants: [] }, quantity: 1 };
        changes = [{ changeType: "itemAdded", itemId: offer.id, item: prof.items[offer.id] }];
        prof.rvn++;
      }
    }
  }
  else if (action === "ClaimLoginReward" || action === "ClaimMcpConsent" || action === "SetMcpConsent"
    || action === "MarkNewQuestSeen" || action === "SetHomeTheater" || action === "ClientQuestLogin"
    || action === "RefreshExpeditions" || action === "GetMcpTimeForLogin") { prof.rvn++; }
  else { prof.rvn++; } // unknown actions: bump rvn, return full state — never 404 mid-login
  const out = mcpResp(prof, changes);
  // equip + purchase return the full profile — 12.41 ignores bare deltas on these
  if (action === "QueryProfile" || action === "SetCosmeticLockerSlot" || action === "EquipBattleRoyaleCustomization"
    || action === "PurchaseCatalogEntry" || action === "SetActiveLoadout" || action === "CopyCosmeticLoadout") {
    out.profileChanges = [{ changeType: "fullProfileUpdate", profile: {
      created: prof.created, updated: new Date().toISOString(), rvn: prof.rvn, wipeNumber: 1,
      accountId, profileId: "athena", version: "void_1",
      items: prof.items, stats: prof.stats, commandRevision: prof.commandRevision } }];
    out.profileChangesBaseRevision = 0;
  }
  res.json(out);
});

// ---- friends ----
game.get("/friends/api/public/friends/:id", authRequired, (req, res) =>
  res.json([...(db.friends.get(req.params.id) || [])].map(fid => ({ accountId: fid, status: "ACCEPTED", direction: "BOTH" }))));
game.post("/friends/api/public/friends/:id/:wanted", authRequired, (req, res) => {
  if (!db.friends.has(req.params.id)) db.friends.set(req.params.id, new Set());
  if (!db.friends.has(req.params.wanted)) db.friends.set(req.params.wanted, new Set());
  db.friends.get(req.params.id).add(req.params.wanted);
  db.friends.get(req.params.wanted).add(req.params.id);
  res.status(204).end();
});
game.delete("/friends/api/public/friends/:id/:wanted", authRequired, (req, res) => {
  db.friends.get(req.params.id)?.delete(req.params.wanted);
  db.friends.get(req.params.wanted)?.delete(req.params.id);
  res.status(204).end();
});
game.get("/friends/api/:v/:id/summary", authRequired, (_, res) => res.json({ friends: [], incoming: [], outgoing: [] }));

// NOTE: catalog/keychain/bulk-offers served by reload.js from Better-Reload vendored files

// ---- stats + events ----
game.get("/statsproxy/api/statsv2/account/:id", (req, res) =>
  res.json({ accountId: req.params.id, stats: db.profiles.get(req.params.id)?.stats || {} }));
game.post("/statsproxy/api/statsv2/query", authRequired, (req, res) => {
  const owners = req.body?.owners || [];
  res.json(owners.map(id => ({ accountId: id, stats: db.profiles.get(id)?.stats || {} })));
});
game.get("/api/v1/events/Fortnite/download/:id", authRequired, (_, res) =>
  res.json([{ eventId: "void-late-game-cup", name: "Void Late Game Cup", scoring: { VictoryRoyale: 10, Elimination: 1 } }]));

// ---- game feature gates (missing these hangs the client on "checking for updates") ----
game.get("/fortnite/api/game/v2/enabled_features", (_, res) => res.json([]));
// NOTE: tryPlayOnPlatform lives in reload.js (text/plain true, Better-Reload parity)
game.post("/fortnite/api/game/v2/checkPlatformPlayAllowed/account/:id", authRequired, (_, res) => res.json({}));
game.post("/fortnite/api/game/v2/grant_access/:id", authRequired, (_, res) => res.json({}));
game.post("/fortnite/api/game/v2/profileToken/verify/:id", authRequired, (_, res) => res.json({}));
game.get("/fortnite/api/receipts/v1/account/:id/receipts", authRequired, (_, res) => res.json([]));
game.get("/fortnite/api/cloudstorage/system/config", (_, res) => res.json({}));
game.get("/fortnite/api/cloudstorage/system/:f", (req, res) => res.json({}));
game.put("/fortnite/api/game/v2/profile/:id/client/:a", authRequired, (_, res) => res.json({}));
// ---- pre-lobby parity pt.2 (every one of these gets probed before lobby renders) ----
game.post("/fortnite/api/game/v2/profile/:accountId/dedicated_server/:action", authRequired, (req, res) => {
  const prof = db.profiles.get(req.params.accountId) || { rvn: 0, items: {}, stats: {} };
  prof.rvn++;
  res.json({ profileRevision: prof.rvn, profileId: "athena", profileChangesBaseRevision: prof.rvn - 1,
    profileChanges: [], profileCommandRevision: prof.rvn, serverTime: new Date().toISOString(), responseVersion: 1 });
});
game.get("/fortnite/api/cloudstorage/user/:id", authRequired, (_, res) => res.json([]));
game.get("/fortnite/api/cloudstorage/user/:id/:f", authRequired, (_, res) => res.json({}));
game.put("/fortnite/api/cloudstorage/user/:id/:f", authRequired, (_, res) => res.json({}));
game.get("/profile/privacy_settings", authRequired, (_, res) => res.json({}));
game.put("/profile/play_region", authRequired, (_, res) => res.status(204).end());
game.get("/affiliate/api/public/affiliates/slug/:s", (req, res) => res.json({ slug: req.params.s, id: "void" }));
// NOTE: bulk offers served by reload.js
game.get("/friends/api/v1/:id/blocklist", authRequired, (_, res) => res.json([]));
game.get("/friends/api/v1/:id/recent/:ns", authRequired, (_, res) => res.json([]));
game.get("/presence/api/v1/_/:id/settings/subscriptions", authRequired, (_, res) => res.json([]));
game.get("/presence/api/v1/_/:id/subscriptions", authRequired, (_, res) => res.json([]));
game.get("/presence/api/v1/:ns/:id/subscriptions/nudged", authRequired, (_, res) => res.json({}));
game.get("/fortnite/api/game/v2/privacy/account/:id", authRequired, (_, res) => res.json({}));
game.get("/api/v1/:ns/get", authRequired, (_, res) => res.json({}));
game.get("/fortnite/api/statsv2/account/:id", (req, res) =>
  res.json({ startTime: 0, endTime: 0, stats: db.profiles.get(req.params.id)?.stats?.attributes || {}, accountId: req.params.id }));
game.get("/friends/api/v1/:id/settings", authRequired, (_, res) => res.json({}));
game.get("/discovery/api/v1/creative/discovery_surface", authRequired, (_, res) => res.json({ panels: [] }));
game.post("/fortnite/api/feedback/Player", authRequired, (_, res) => res.status(204).end());
game.post("/fortnite/api/game/v2/toxicity/account/:a/report/:b", authRequired, (_, res) => res.status(204).end());
game.get("/presence/api/v1/_/:id/last-online", authRequired, (_, res) => res.json({}));
game.get("/fortnite/api/game/v2/matchmakingservice/ticket/player/:id", authRequired, (req, res) => {
  const port = process.env.PORT || 35540;
  return res.json({ serviceUrl: `ws://127.0.0.1:${port}/arena/ws`, ticketType: "mms-player",
    payload: "void-ticket", signature: req.params.id });
});
// matchmaking parity (Better-Reload shapes; needs a UE gameserver to actually play)
game.get("/fortnite/api/matchmaking/session/findPlayer/:id", authRequired, (_, res) => res.status(200).end());
game.get("/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId", (req, res) =>
  res.json({ accountId: req.params.accountId, sessionId: req.params.sessionId, key: "none" }));
game.get("/fortnite/api/matchmaking/session/:sessionId", authRequired, (req, res) =>
  res.json({ id: req.params.sessionId, ownerId: "VOIDDS", ownerName: "[DS]void",
    serverName: "[DS]void", serverAddress: "127.0.0.1", serverPort: 7777,
    maxPublicPlayers: 100, openPublicPlayers: 99, maxPrivatePlayers: 0, openPrivatePlayers: 0,
    attributes: { REGION_s: "EU", GAMEMODE_s: "FORTATHENA", PLAYLISTNAME_s: "Playlist_DefaultSolo",
      TENANT_s: "Fortnite", BEACONPORT_i: 15009 },
    publicPlayers: [], privatePlayers: [], totalPlayers: 1, allowJoinInProgress: false,
    shouldAdvertise: false, isDedicated: false, usesStats: false, allowInvites: false,
    usesPresence: false, allowJoinViaPresence: true, allowJoinViaPresenceFriendsOnly: false,
    buildUniqueId: "12.41", lastUpdated: new Date().toISOString(), started: false }));
game.post("/fortnite/api/matchmaking/session/:sessionId/join", authRequired, (_, res) => res.status(204).end());
game.post("/fortnite/api/matchmaking/session/matchMakingRequest", authRequired, (_, res) => res.json([]));

// ---- lightswitch / waiting room / content pages ----
game.get("/lightswitch/api/service/bulk/status", authRequired, (_, res) =>
  res.json([{ serviceInstanceId: "fortnite", status: "UP", message: "Void is live", maintenanceUri: null,
    overrideCatalogIds: ["a7f138b2e51945ffbfdacc1afb9b9c73"], allowedActions: ["PLAY", "DOWNLOAD"], launcherInfoDTO: { appName: "Fortnite", catalogId: "fn", namespace: "fn" } }]));
game.get("/waitingroom/api/waitingroom", (_, res) => res.json(null));
game.get("/content/api/pages/fortnite-game", (_, res) => res.json({ "battleroyalenews": { news: { motds: [{ title: "PROJECT VOID LIVE", body: "Late-game arena + parties + DC commands online." }] } } }));
// NOTE: timeline served by reload.js (C2S2 seasonNumber 12)
game.get("/fortnite/api/v2/versioncheck/:v", (req, res) => res.json({ type: "NO_UPDATE" }));
game.get("/fortnite/api/cloudstorage/system", (_, res) => res.json([]));
game.get("/region", (_, res) => res.json({ region: "EU" }));
// telemetry sink — clients fire-and-forget, never block on it
// XP pipeline: match/elim events -> xp + book_xp, level-ups at 80k/season-level curve
const xpForLevel = (lvl) => 80000; // flat curve keeps the bar moving every match
function grantXp(accountId, xp, bookXp) {
  const prof = db.profiles.get(accountId);
  if (!prof || !prof.stats?.attributes) return null;
  const a = prof.stats.attributes;
  a.xp = (a.xp || 0) + xp;
  a.book_xp = (a.book_xp || 0) + bookXp;
  let ups = 0;
  while (a.xp >= xpForLevel(a.level || 1)) { a.xp -= xpForLevel(a.level || 1); a.level = (a.level || 1) + 1; ups++; }
  while (a.book_xp >= 100000) { a.book_xp -= 100000; a.book_level = (a.book_level || 1) + 1; }
  prof.rvn++;
  return { level: a.level, ups, book_level: a.book_level };
}
// accountId lookup from datarouter UserID pipe-format: "a|b|c" (first segment is ours)
function acctFromUserId(uid) {
  const first = String(uid || "").split("|")[0];
  if (db.accounts.has(first)) return first;
  return [...db.accounts.values()].find(a => a.id.startsWith(first.slice(0, 8)))?.id || null;
}
game.post("/datarouter/api/v1/public/data", (req, res) => {
  try {
    const id = acctFromUserId(req.query.UserID);
    const events = req.body?.Events;
    if (id && Array.isArray(events))
      for (const e of events) {
        if (e.ProviderType !== "Client" || !e.EventName) continue;
        const kills = Number(e.PlayerKilledPlayerEventCount) || 0;
        if (e.EventName === "Athena.ClientWonMatch") grantXp(id, 15000, 15000);
        else if (e.EventName === "Combat.AthenaClientEngagement" && kills > 0) grantXp(id, kills * 1500, kills * 1500);
        else if (e.EventName === "Combat.ClientPlayerDeath") grantXp(id, 2500, 2500); // participation
      }
    res.status(204).end();
  } catch { res.status(204).end(); }
});
// manual XP (admin/test): POST /admin/xp/:id { xp, bookXp }
game.post("/admin/xp/:id", adminRequired, (req, res) => {
  const r = grantXp(req.params.id, req.body?.xp || 0, req.body?.bookXp || 0);
  if (!r) return res.status(404).json({ error: "not_found" });
  res.json(r);
});
// top-up vbucks: POST /admin/vbucks/:id { amount }
game.post("/admin/vbucks/:id", adminRequired, (req, res) => {
  const prof = db.profiles.get(req.params.id);
  if (!prof?.items) return res.status(404).json({ error: "not_found" });
  const qty = req.body?.amount ?? 5000;
  setBal(req.params.id, qty);
  if (prof.items["Currency:MtxPurchased"]) prof.items["Currency:MtxPurchased"].quantity = qty;
  prof.rvn++;
  res.json({ vbucks: qty });
});

// ---- admin (DC commands call these) ----
import { adminRequired } from "./auth.js";
game.get("/admin/players", adminRequired, (_, res) => res.json([...db.accounts.values()]));
game.post("/admin/ban/:id", adminRequired, (req, res) => {
  const a = db.accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not_found" });
  a.banned = true; res.json({ banned: a.id });
});
game.post("/admin/unban/:id", adminRequired, (req, res) => {
  const a = db.accounts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not_found" });
  a.banned = false; res.json({ unbanned: a.id });
});
game.post("/admin/grant/:id", adminRequired, (req, res) => {
  const prof = db.profiles.get(req.params.id);
  if (!prof) return res.status(404).json({ error: "not_found" });
  prof.items[req.body?.item || "athena:character:void"] = 1; prof.rvn++;
  res.json({ granted: req.body?.item, rvn: prof.rvn });
});
game.get("/admin/servers", adminRequired, (_, res) => res.json([...db.servers.values()]));
game.get("/admin/parties", adminRequired, (_, res) => res.json([...db.parties.values()].map(p => ({ id: p.id, members: p.members.length, rev: p.revision }))));
