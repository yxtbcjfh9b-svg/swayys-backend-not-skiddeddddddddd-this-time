// language: JS, file: src/auth.js, runtime: node 24
// Token auth: bearer <token>. God accounts seeded for admins (Retrac parity).
import { randomUUID } from "node:crypto";
import { db } from "./store.js";

export function godAccounts() {
  for (const [id, name] of [["void_admin", "VoidAdmin"], ["void_god", "VoidGod"]]) {
    if (!db.accounts.has(id)) {
      db.accounts.set(id, { id, displayName: name, created: new Date().toISOString(), banned: false, admin: true });
      db.profiles.set(id, { rvn: 0, items: {}, stats: { wins: 999, kills: 9999 } });
    }
  }
}

export function mintToken(accountId, ttlMs = 8 * 3600_000) {
  const token = randomUUID().replaceAll("-", "");
  db.tokens.set(token, { accountId, expires: Date.now() + ttlMs });
  return token;
}

export function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  // Epic/Reboot clients send lowercase "bearer" — match case-insensitively
  const m = h.match(/^bearer\s+(.+)$/i);
  const token = m ? m[1] : req.query.token;
  const sess = token && db.tokens.get(token);
  if (!sess || sess.expires < Date.now()) return res.status(401).json({ error: "invalid_token" });
  const acc = db.accounts.get(sess.accountId);
  if (!acc || acc.banned) return res.status(403).json({ error: "access_denied" });
  req.account = acc;
  next();
}

export function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (!req.account.admin) return res.status(403).json({ error: "admin_only" });
    next();
  });
}
