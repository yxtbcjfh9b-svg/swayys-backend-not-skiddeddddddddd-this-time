// language: JS, file: src/discord.js, runtime: node 24
// DC commands for Project Void. Raw REST + minimal gateway (no discord.js dep).
// Gateway keeps the bot ONLINE and receives INTERACTION_CREATE directly —
// no public Interactions URL needed. Webhook POST /dc/interactions kept as fallback.
// *watch for gateway 4014 disconnects when two instances share one token — one connection per bot, always*
import { WebSocket } from "ws";
import { db, setBal } from "./store.js";

const TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const APP = process.env.DISCORD_APP_ID || "";
const API = "https://discord.com/api/v10";

const COMMANDS = [
  { name: "void-status", description: "Void backend status" },
  { name: "void-ban", description: "Ban a player", options: [{ type: 3, name: "account", description: "account id", required: true }] },
  { name: "void-unban", description: "Unban a player", options: [{ type: 3, name: "account", description: "account id", required: true }] },
  { name: "void-grant", description: "Grant cosmetic", options: [
    { type: 3, name: "account", description: "account id", required: true },
    { type: 3, name: "item", description: "item id", required: true }] },
  { name: "void-kick-party", description: "Force-disband a party", options: [{ type: 3, name: "party", description: "party id", required: true }] },
  { name: "void-shop", description: "Show current shop rotation" },
  { name: "void-hype", description: "Top hype leaderboard" },
  { name: "void-end-arena", description: "Force-close an arena session", options: [{ type: 3, name: "session", description: "session id", required: true }] },
  { name: "void-register", description: "Create your Project Void account", options: [{ type: 3, name: "username", description: "Your username.", required: true }] },
  { name: "void-vbucks", description: "Set a player's V-Buck balance", options: [
    { type: 3, name: "account", description: "account id or display name", required: true },
    { type: 4, name: "amount", description: "vbucks to set", required: true }] },
];

export async function registerCommands() {
  if (!TOKEN || !APP) { console.log("[dc] DISCORD_BOT_TOKEN/APP_ID missing — bot idle"); return; }
  const r = await fetch(`${API}/applications/${APP}/commands`, {
    method: "PUT", headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
  });
  console.log(`[dc] registered ${COMMANDS.length} commands (${r.status})`);
  connectGateway();
}

// ---- gateway: bot shows ONLINE, interactions arrive as dispatches ----
let gwSeq = null, gwBeat = null, gwWs = null;
export const dcState = { connected: false, user: null, lastHello: null, lastDispatch: null,
  lastAck: null, lastFollowup: null, lastError: null, reconnects: 0 };
async function connectGateway() {
  try {
    const g = await fetch(`${API}/gateway/bot`, { headers: { Authorization: `Bot ${TOKEN}` } }).then(r => r.json());
    if (!g.url) { console.log("[dc] gateway url missing", JSON.stringify(g).slice(0, 200)); return; }
    gwWs = new WebSocket(`${g.url}/?v=10&encoding=json`);
    gwWs.on("message", (raw) => {
      try {
        const p = JSON.parse(raw.toString());
        if (p.s) gwSeq = p.s;
        if (p.op === 10) { // HELLO
          dcState.lastHello = new Date().toISOString();
          clearInterval(gwBeat);
          gwBeat = setInterval(() => gwWs?.send(JSON.stringify({ op: 1, d: gwSeq })), p.d.heartbeat_interval);
          gwWs.send(JSON.stringify({ op: 2, d: { token: TOKEN,
            intents: 0, properties: { os: "windows", browser: "void", device: "void" } } }));
        } else if (p.op === 11) { /* heartbeat ack */ }
        else if (p.op === 0 && p.t === "READY") { dcState.connected = true; dcState.user = p.d.user.username; console.log(`[dc] ONLINE as ${p.d.user.username}`); }
        else if (p.op === 0 && p.t === "INTERACTION_CREATE") { dcState.lastDispatch = `${p.d.data?.name} @ ${new Date().toISOString()}`; onGatewayInteraction(p.d); }
        else if (p.op === 9) { dcState.reconnects++; setTimeout(connectGateway, 5000); } // invalid session, retry
      } catch {}
    });
    gwWs.on("close", () => { clearInterval(gwBeat); console.log("[dc] gateway closed, retrying…"); setTimeout(connectGateway, 5000); });
    gwWs.on("error", () => {});
  } catch (e) { console.log("[dc] gateway fail", e.message); }
}

async function onGatewayInteraction(ix) {
  console.log(`[dc] interaction: ${ix.data?.name} from ${ix.member?.user?.username || ix.user?.username}`);
  // ack within 3s via callback, then follow up through webhook
  let ack;
  try {
    ack = await fetch(`${API}/interactions/${ix.id}/${ix.token}/callback`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 5 }) });
    console.log(`[dc] ack ${ix.data?.name} -> ${ack.status}`);
  } catch (e) { dcState.lastError = `ack: ${e.message}`; console.log(`[dc] ack FAILED ${ix.data?.name}: ${e.message}`); return; }
  dcState.lastAck = `${ix.data?.name} -> ${ack.status}`;
  if (!ack.ok) { console.log(`[dc] ack rejected: ${await ack.text().catch(() => "")}`.slice(0, 300)); return; }
  const send = async (msg) => {
    const r = await fetch(`${API}/webhooks/${APP}/${ix.token}/messages/@original`, { method: "PATCH",
      headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(msg).slice(0, 1900) }) }).catch((e) => { console.log(`[dc] followup FAILED: ${e.message}`); return null; });
    console.log(`[dc] followup ${ix.data?.name} -> ${r?.status}`);
    dcState.lastFollowup = `${ix.data?.name} -> ${r?.status}`;
  };
  await runCommand(ix, send);
}

export async function interactions(req, res) {
  const ix = req.body;
  if (ix?.type === 1) return res.json({ type: 1 }); // PING
  res.json({ type: 5 }); // DEFERRED webhook path
  if (ix?.type !== 2) return;
  const send = async (msg) => {
    await fetch(`${API}/webhooks/${APP}/${ix.token}/messages/@original`, { method: "PATCH",
      headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(msg).slice(0, 1900) }) }).catch(() => {});
  };
  await runCommand(ix, send);
}

async function runCommand(ix, send) {
  const name = ix.data?.name;
  const opt = Object.fromEntries((ix.data?.options || []).map(o => [o.name, o.value]));

// POST /account/api/register on this same backend (PORT-aware for tests)
const BACKEND = () => `http://127.0.0.1:${process.env.PORT || 35540}/account/api/register`;

async function voidRegister(ix, opt, send) {
  const username = String(opt.username || "");
  const discordId = ix.member?.user?.id || ix.user?.id || "unknown";
  const dcName = ix.member?.user?.username || ix.user?.username || "player";
  if (username.length < 3) return send("Your username must be at least 3 characters long.");
  if (username.length > 20) return send("Your username must be 20 characters or less.");
  const email = `${dcName}@gmail.com`.toLowerCase();
  const password = (await import("node:crypto")).randomBytes(6).toString("hex");

  const r = await fetch(BACKEND(), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ discordId, username, email, password }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = body.error === "discord_already_registered"
      ? "An account with your Discord username already exists!"
      : body.error === "username_taken"
        ? "Username already exists. Please choose a different one."
        : `Register failed (${body.error || r.status})`;
    return send(msg);
  }

  // DM the credentials (v14-style embed payload via raw REST)
  const embed = { color: 0x56ff00, fields: [
      { name: "Username", value: username, inline: true },
      { name: "Email", value: email, inline: true },
      { name: "Password", value: `||${password}||`, inline: true }],
    timestamp: new Date().toISOString(), footer: { text: "Void" } };
  let dmSent = true;
  if (TOKEN) {
    try {
      const ch = await fetch(`${API}/users/@me/channels`, { method: "POST",
        headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient_id: discordId }) }).then(r => r.json());
      const dm = await fetch(`${API}/channels/${ch.id}/messages`, { method: "POST",
        headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: `Hello ${dcName}, here are your account details for Project Void:`, embeds: [embed] }) });
      if (!dm.ok) dmSent = false;
    } catch { dmSent = false; }
  }
  await send(dmSent
    ? "Account created successfully! I have also sent your details to your DMs."
    : "Account created successfully! (Note: I couldn't DM you, please make sure your DMs are open next time)");
}
  const find = (id) => db.accounts.get(id) || [...db.accounts.values()].find(a => a.displayName.toLowerCase() === String(id).toLowerCase());

  if (name === "void-status") {
    const now = Date.now();
    const who = new Set();
    for (const s of db.tokens.values())
      if (!s.accountId.startsWith("xc_") && s.expires > now) who.add(s.accountId);
    await send(`**VOID LIVE** — online ${who.size} · parties ${db.parties.size} · arena ${db.sessions.size} · accounts ${db.accounts.size}`);
  }
  else if (name === "void-ban") { const a = find(opt.account); if (a) { a.banned = true; await send(`banned ${a.displayName}`); } else await send("not found"); }
  else if (name === "void-unban") { const a = find(opt.account); if (a) { a.banned = false; await send(`unbanned ${a.displayName}`); } else await send("not found"); }
  else if (name === "void-grant") { const p = db.profiles.get(find(opt.account)?.id); if (p) { p.items[opt.item] = 1; p.rvn++; await send(`granted ${opt.item}`); } else await send("not found"); }
  else if (name === "void-kick-party") { const ok = db.parties.delete(opt.party); await send(ok ? `disbanded ${opt.party}` : "not found"); }
  else if (name === "void-shop") {
    const s = db.shop.catalog;
    await send(s ? s.storefronts.map(o => `${o.offerId} — ${o.prices[0].regularPrice} vbucks`).join("\n") : "shop not generated yet");
  }
  else if (name === "void-hype") {
    const top = [...db.profiles.entries()].map(([id, p]) => ({ id, hype: p.stats.hype || 0 }))
      .sort((a, b) => b.hype - a.hype).slice(0, 10);
    await send(top.map((t, i) => `${i + 1}. ${db.accounts.get(t.id)?.displayName || t.id} — ${t.hype} hype`).join("\n") || "no hype yet");
  }
  else if (name === "void-end-arena") { const ok = db.sessions.delete(opt.session); await send(ok ? `closed ${opt.session}` : "not found"); }
  else if (name === "void-register") await voidRegister(ix, opt, send);
  else if (name === "void-vbucks") {
    const a = find(opt.account);
    const p = a && db.profiles.get(a.id);
    if (!a || !p) await send("not found (they must log in once first)");
    else {
      const qty = Math.max(0, Math.min(99999999, Number(opt.amount) || 0));
      setBal(a.id, qty);
      if (p.items?.["Currency:MtxPurchased"]) { p.items["Currency:MtxPurchased"].quantity = qty; p.rvn++; }
      await send(`${a.displayName} now has ${qty.toLocaleString()} V-Bucks`);
    }
  }
  else await send("unknown command");
}
