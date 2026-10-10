// language: JS, file: src/shop.js, runtime: node 24
// C2S2 item shop driven by catalog_config.json (hot-reloaded, no restart).
// id = backend templateId (verify new ones at https://fortnite-api.com).
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CFG = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog_config.json");
let cache = null;
function config() {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(CFG, "utf8")); }
    catch (e) { console.log("[shop] catalog_config.json invalid:", e.message); cache = { featured: [], daily: [] }; }
  }
  return cache;
}
try { watch(CFG, () => { try { cache = JSON.parse(readFileSync(CFG, "utf8")); console.log("[shop] catalog reloaded"); } catch (e) { console.log("[shop] bad edit, kept last good:", e.message); } }); } catch {}
config();

const pretty = (id) => String(id).split(":").pop()
  .replace(/^(CID_\d+_Athena_Commando_[MF]_|cid_\d+_athena_commando_[mf]_|bid_\d+_|pickaxe_id_\d+_|glider_id_\d+_|wrap_\d+_|eid_|spid_\d+_|trails_id_\d+_|lsid_\d+_|musicpack_\d+_|Default)/i, "")
  .replace(/_/g, " ").trim() || String(id);

const V = "MtxCurrency";
// stable offerIds (hash of templateId) so purchase-by-offerId matches across requests
const offerIdFor = (templateId) => `v2:/${createHash("sha1").update(String(templateId)).digest("hex")}`;

function normalize(c) {
  if (!c || c.daily || c.featured) return c || { featured: [], daily: [] };
  // flat shape: daily1..6 / featured1..2 with { itemGrants:[...], price }
  const pull = (prefix) => Object.keys(c).filter(k => k.startsWith(prefix)).sort()
    .map(k => ({ name: pretty(c[k].itemGrants?.[0] || k), id: c[k].itemGrants?.[0], price: c[k].price || 1200 }))
    .filter(o => o.id);
  return { featured: pull("featured"), daily: pull("daily") };
}
const entry = (name, templateId, price, panel, exp) => ({
  devName: `[VIRTUAL]1 x ${name} for ${price} ${V}`,
  offerId: offerIdFor(templateId),
  fulfillmentIds: [], dailyLimit: -1, weeklyLimit: -1, monthlyLimit: -1,
  categories: [panel],
  prices: [{ currencyType: V, currencySubType: "", regularPrice: price, finalPrice: price,
    saleExpiration: exp, basePrice: price }],
  meta: {}, matchFilter: "", filterWeight: 0, appStoreId: [],
  requirements: [{ requirementType: "DenyOnItemOwnership", requiredId: templateId, minQuantity: 1 }],
  offerType: "StaticPrice", giftInfo: { bIsEnabled: false }, refundable: true, metaInfo: [],
  displayAssetPath: "",
  itemGrants: [{ templateId, quantity: 1 }],
  sortPriority: 0, catalogGroupPriority: 0,
});

export function findOffer(offerId) {
  const c = normalize(config());
  const all = [...(c.featured || []), ...(c.daily || [])];
  return all.find(o => offerIdFor(o.id) === offerId) || null;
}

export function buildCatalog() {
  const c = normalize(config());
  const soon = new Date(Date.now() + 5 * 60_000).toISOString(); // 5-min TTL: config edits appear fast
  const week = new Date(Date.now() + 7 * 86400_000).toISOString();
  return {
    refreshIntervalHrs: 24, dailyPurchaseHrs: 24,
    expiration: soon,
    storefronts: [
      { name: "BRDailyStorefront", expiration: soon,
        catalogEntries: (c.daily || []).slice(0, 6).map((o, i) => entry(o.name, o.id, o.price, `Panel ${i + 1}`, soon)) },
      { name: "BRWeeklyStorefront", expiration: soon,
        catalogEntries: (c.daily || []).slice(6).map((o, i) => entry(o.name, o.id, o.price, `Panel ${i + 1}`, soon)) },
      { name: "BRSeasonStorefront", expiration: week,
        catalogEntries: (c.featured || []).map((o, i) => ({ ...entry(o.name, o.id, o.price, `Panel ${i + 1}`, week),
          expiration: week })) },
    ],
  };
}
