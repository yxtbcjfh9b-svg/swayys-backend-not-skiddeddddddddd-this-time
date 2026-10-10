// language: JS, file: src/index.js, runtime: node 24
// Project Void backend — express + ws. Better Retrac: single hub, TTL sweeps, arena, honest errors.
// Run: npm i && npm start (PORT=35540). Discord: set DISCORD_BOT_TOKEN + DISCORD_APP_ID.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// minimal .env loader (no deps): KEY=value lines, no interpolation
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (existsSync(envPath))
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
} catch {}
import express from "express";
import { createServer } from "node:http";
import { restore } from "./store.js";
import { game } from "./game.js";
import { reload } from "./reload.js";
import { parties } from "./parties.js";
import { arena } from "./arena.js";
import { initSockets, fanoutCount } from "./sockets.js";
import { registerCommands, interactions, dcState } from "./discord.js";
import { db } from "./store.js";

restore();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((_, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "*"); next(); });

app.get("/", (_, res) => res.json({ game: "void", live: true }));
app.get("/launcher/ping", (_, res) => res.json({ ok: true }));
app.get("/health", (_, res) => res.json({ ok: true, game: "void", accounts: db.accounts.size,
  parties: db.parties.size, sessions: db.sessions.size, sockets: fanoutCount() }));
app.use(game);
app.use(reload); // Better-Reload-compatible shapes win over stubs
app.use("/party/api/v1/Fortnite", parties);
app.use("/arena", arena);
app.use((req, _, next) => { if (!req.originalUrl.includes("datarouter")) console.log(`[req] ${req.method} ${req.originalUrl}`); next(); });
app.post("/dc/interactions", interactions);
app.get("/dc/debug", (_, res) => res.json({ ...dcState, tokenSet: !!process.env.DISCORD_BOT_TOKEN, appSet: !!process.env.DISCORD_APP_ID }));
app.use((req, res) => { console.log(`[404] ${req.method} ${req.originalUrl}`); res.status(404).json({ error: "unknown_route" }); });

const server = createServer(app);
initSockets(server);
const PORT = process.env.PORT || 35540;
server.listen(PORT, () => console.log(`[void] live on :${PORT}`));
registerCommands();
