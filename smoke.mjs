// language: JS, file: tests/smoke.mjs, runtime: node 24
// boots the server on a temp port, exercises auth -> party -> arena -> shop
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PORT = 35599;
const srv = spawn(process.execPath, ["src/index.js"], { env: { ...process.env, PORT }, cwd: ROOT });
await new Promise(r => setTimeout(r, 1500));
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "::", e.message); }
}
const j = (r) => r.json();

let token, me, party, session;
await t("health", async () => { const r = await fetch(`${B}/health`).then(j); if (!r.ok) throw new Error("down"); });
await t("oauth", async () => {
  const r = await fetch(`${B}/account/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "VoidTest" }) }).then(j);
  if (!r.access_token) throw new Error("no token"); token = r.access_token; me = r.account_id;
});
const H = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
await t("party create", async () => {
  const r = await fetch(`${B}/party/api/v1/Fortnite/parties`, { method: "POST", headers: H(), body: "{}" }).then(j);
  if (!r.id) throw new Error("no party"); party = r.id;
});
await t("party get", async () => {
  const r = await fetch(`${B}/party/api/v1/Fortnite/parties/${party}`, { headers: H() }).then(j);
  if (r.members.length !== 1) throw new Error("member count");
});
await t("arena create+join", async () => {
  const s = await fetch(`${B}/arena/sessions`, { method: "POST", headers: H(), body: JSON.stringify({ maxPlayers: 16 }) }).then(j);
  if (!s.id) throw new Error("no session"); session = s.id;
  const r = await fetch(`${B}/arena/sessions/${session}/join`, { method: "POST", headers: H() }).then(j);
  if (r.players !== 1) throw new Error("join failed");
});
await t("shop catalog", async () => {
  const r = await fetch(`${B}/fortnite/api/storefront/v2/catalog`, { headers: H() }).then(j);
  if (!r.storefronts) throw new Error("no shop");
});
await t("profile equip", async () => {
  const r = await fetch(`${B}/fortnite/api/game/v2/profile/${me}/client/EquipBattleRoyaleCustomization`, { method: "POST", headers: H(), body: JSON.stringify({ slotName: "character", item: "CID_004_Void_Walker" }) }).then(j);
  if (!r.profileRevision) throw new Error("no rvn");
});
console.log(`\n${pass} passed, ${fail} failed`);
srv.kill();
process.exit(fail ? 1 : 0);
