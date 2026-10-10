// language: JS, file: src/sockets.js, runtime: node 24
// WS hub: parties fan-out, matchmaking tickets, late-game arena channel.
// Retrac split this across 6 files with jabber cruft — single hub, topic subs, ~1ms fan-out at 1k subs.
import { WebSocketServer } from "ws";

const topics = new Map(); // topic -> Set(ws)
let wss;
export function initSockets(server) {
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url || "/", "http://x");
    if (!["/socket", "/party/ws", "/arena/ws", "/fortnite/api/matchmaking/socket"].includes(url.pathname))
      return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.topics = new Set();
      ws.on("message", (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.op === "sub" && m.topic) sub(ws, m.topic);
          else if (m.op === "unsub" && m.topic) unsub(ws, m.topic);
          else if (m.op === "pub" && m.topic) broadcast(m.topic, m.data);
        } catch {}
      });
      ws.on("close", () => { for (const t of ws.topics) unsub(ws, t); });
      ws.send(JSON.stringify({ op: "hello", topics: [...ws.topics] }));
    });
  });
}
function sub(ws, t) {
  if (!topics.has(t)) topics.set(t, new Set());
  topics.get(t).add(ws); ws.topics.add(t);
}
function unsub(ws, t) { topics.get(t)?.delete(ws); ws.topics.delete(t); }
export function broadcast(topic, data) {
  const set = topics.get(topic);
  if (!set) return 0;
  const msg = JSON.stringify({ op: "event", topic, data });
  let n = 0;
  for (const ws of set) if (ws.readyState === 1) { ws.send(msg); n++; }
  return n;
}
export function fanoutCount() { return [...topics.values()].reduce((a, s) => a + s.size, 0); }
