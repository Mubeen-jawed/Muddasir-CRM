// =====================================================
// AUTHENTICATION
// =====================================================
// The ADMIN's credentials live in .env, never in the repo:
//   AUTH_USERNAME       plain username
//   AUTH_PASSWORD_HASH  scrypt$N$r$p$saltB64$hashB64
//   SESSION_SECRET      random, signs session cookies
//
// Every other login is a CLIENT, stored in users.json (see users.js) and
// scoped to the ad account(s) it may view. Two roles, and only two:
//   admin  — sees every workspace, and is the only one who can change any
//   client — sees exactly the workspaces listed on its record
//
// Sessions are stateless HMAC-signed cookies, so they survive a pm2 restart.
// Rotating SESSION_SECRET invalidates every session. The cookie carries a
// username and a fingerprint of the password it was issued against — nothing
// else. Role and scope are re-read from the store on every request, so
// deleting, re-scoping, or resetting the password on a login takes effect
// immediately, without waiting for the session to expire.
// =====================================================

const crypto = require("crypto");
const users = require("./users");

const AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || "12", 10);
const COOKIE_NAME = "dash_session";

const AUTH_ENABLED = Boolean(AUTH_USERNAME && AUTH_PASSWORD_HASH && SESSION_SECRET);

// ── Constant-time helpers ──
// Length differences leak through timingSafeEqual (it throws), so compare
// digests of equal length instead of the raw strings.
function safeEqualStr(a, b) {
  const ah = crypto.createHash("sha256").update(String(a)).digest();
  const bh = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// Hash format and verification are shared with the client store, so an
// admin hash from .env and a client hash from users.json are interchangeable.
const verifyPassword = users.verifyPassword;

const ADMIN = Object.freeze({ username: AUTH_USERNAME, role: "admin", workspaces: null });

// Resolves a username to the session identity behind it, or null. `workspaces`
// is null for the admin — meaning "not scoped", i.e. every workspace — and an
// array of workspace ids for a client.
function resolveUser(username) {
  const name = String(username || "");
  if (!name) return null;
  if (AUTH_USERNAME && safeEqualStr(name, AUTH_USERNAME)) return ADMIN;

  const record = users.findUser(name);
  if (!record) return null;
  return { username: record.username, role: "client", workspaces: record.workspaces.slice() };
}

// Both the admin check and the client check always run to completion —
// short-circuiting on the username would let an attacker distinguish
// "no such user" from "wrong password" by response time. An unknown username
// is hashed against a throwaway hash so it costs the same as a real one.
function verifyCredentials(username, password) {
  const name = String(username || "");
  const pw = String(password || "");

  const adminNameOk = safeEqualStr(name, AUTH_USERNAME);
  const adminPassOk = verifyPassword(pw, AUTH_PASSWORD_HASH);

  const record = users.findUser(name);
  const clientPassOk = verifyPassword(pw, record ? record.passwordHash : users.DUMMY_HASH);

  if (adminNameOk && adminPassOk) return ADMIN;
  if (record && clientPassOk) {
    return { username: record.username, role: "client", workspaces: record.workspaces.slice() };
  }
  return null;
}

// ── Session tokens ──
function sign(payloadB64) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
}

// A short fingerprint of the password hash the session was issued against.
// Carried in the token so that changing a password ends every session opened
// with the old one — which is the whole point of resetting a leaked password.
// It is derived from a hash, never the password, and truncated so the cookie
// gives away nothing useful about it.
function passwordFingerprint(user) {
  const stored = user.role === "admin" ? AUTH_PASSWORD_HASH : (users.findUser(user.username) || {}).passwordHash;
  if (!stored) return null;
  return crypto.createHash("sha256").update(String(stored)).digest("base64url").slice(0, 16);
}

function issueToken(username) {
  const user = resolveUser(username);
  if (!user) return null;
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      u: user.username,
      k: passwordFingerprint(user),
      iat: now,
      exp: now + SESSION_HOURS * 3600 * 1000,
    })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;

  const payloadB64 = token.slice(0, idx);
  const sigA = Buffer.from(token.slice(idx + 1));
  const sigB = Buffer.from(sign(payloadB64));
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  // Resolved fresh every request, so changing AUTH_USERNAME retires every
  // session signed for the old one, and deleting a client login logs it out
  // on its very next request rather than whenever the cookie happens to expire.
  const user = resolveUser(payload.u);
  if (!user) return null;

  // Same for a password change: the fingerprint no longer matches, so every
  // session opened with the old password is refused from here on.
  const current = passwordFingerprint(user);
  if (!current || payload.k !== current) return null;
  return user;
}

// ── Cookies ──
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function isSecureRequest(req) {
  const forced = String(process.env.COOKIE_SECURE || "").toLowerCase();
  if (forced === "true") return true;
  if (forced === "false") return false;
  return req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req, res, token) {
  const bits = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  if (isSecureRequest(req)) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function clearSessionCookie(req, res) {
  const bits = [`${COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (isSecureRequest(req)) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

// Returns the identity object ({ username, role, workspaces }) or null.
function sessionUser(req) {
  if (!AUTH_ENABLED) return null;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return token ? readToken(token) : null;
}

// ── Login rate limiting (per client IP, in memory) ──
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

function clientKey(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function rateLimitStatus(req) {
  const rec = attempts.get(clientKey(req));
  if (rec && rec.lockedUntil > Date.now()) {
    return { allowed: false, retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

function recordFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const rec = attempts.get(key);

  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(key, { first: now, count: 1, lockedUntil: 0 });
    return { locked: false, remaining: MAX_FAILURES - 1 };
  }

  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.lockedUntil = now + LOCKOUT_MS;
    rec.count = 0;
    rec.first = now;
    return { locked: true, remaining: 0 };
  }
  return { locked: false, remaining: MAX_FAILURES - rec.count };
}

function recordSuccess(req) {
  attempts.delete(clientKey(req));
}

// Keep the map from growing without bound on a long-lived process.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (rec.lockedUntil < now && now - rec.first > WINDOW_MS) attempts.delete(key);
  }
}, 30 * 60 * 1000);
if (typeof sweeper.unref === "function") sweeper.unref();

// ── Loopback detection ──
// Lets CI smoke-test /api/health without a login. A request proxied by Nginx
// also arrives from 127.0.0.1, but it carries X-Forwarded-For — so the header's
// presence is what separates "genuinely local" from "someone on the internet".
function isLoopbackDirect(req) {
  if (req.headers["x-forwarded-for"]) return false;
  const addr = req.socket.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

module.exports = {
  AUTH_ENABLED,
  AUTH_USERNAME,
  COOKIE_NAME,
  SESSION_HOURS,
  verifyCredentials,
  resolveUser,
  issueToken,
  readToken,
  sessionUser,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  rateLimitStatus,
  recordFailure,
  recordSuccess,
  isLoopbackDirect,
};
