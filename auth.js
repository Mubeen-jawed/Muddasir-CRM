// =====================================================
// AUTHENTICATION
// =====================================================
// Credentials live in .env, never in the repo:
//   AUTH_USERNAME       plain username
//   AUTH_PASSWORD_HASH  scrypt$N$r$p$saltB64$hashB64
//   SESSION_SECRET      random, signs session cookies
//
// Sessions are stateless HMAC-signed cookies, so they survive a
// pm2 restart. Rotating SESSION_SECRET invalidates every session.
// =====================================================

const crypto = require("crypto");

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

function verifyPassword(plain, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");

  let actual;
  try {
    actual = crypto.scryptSync(String(plain), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Both checks always run — short-circuiting on the username would let an
// attacker distinguish "no such user" from "wrong password" by response time.
function verifyCredentials(username, password) {
  const userOk = safeEqualStr(username || "", AUTH_USERNAME);
  const passOk = verifyPassword(password || "", AUTH_PASSWORD_HASH);
  return userOk && passOk;
}

// ── Session tokens ──
function sign(payloadB64) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
}

function issueToken(username) {
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({ u: username, iat: now, exp: now + SESSION_HOURS * 3600 * 1000 })
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
  // Changing AUTH_USERNAME retires every session signed for the old one.
  if (!safeEqualStr(payload.u || "", AUTH_USERNAME)) return null;
  return payload.u;
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
