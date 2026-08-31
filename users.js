// =====================================================
// DASHBOARD LOGINS
// =====================================================
// The admin login lives in .env (AUTH_USERNAME / AUTH_PASSWORD_HASH) and can
// see every workspace. THIS file holds the per-client logins — one per ad
// account — each scoped to the workspace(s) it is allowed to view.
//
// Storage mirrors accounts.json / budgets.json: a JSON file next to the code,
// written by the server, never committed. Passwords are stored as scrypt
// hashes in the same `scrypt$N$r$p$salt$hash` format .env uses.
// =====================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USERS_FILE = path.join(__dirname, "users.json");

// Cost parameters for every hash written here. They are embedded in the
// stored string, so raising them later still verifies older hashes.
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32, saltLen: 16 };
const MIN_PASSWORD = 6;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

// ── Hashing ──
function hashPassword(plain) {
  const salt = crypto.randomBytes(SCRYPT.saltLen);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
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

// An unknown username must cost the same as a wrong password, or the response
// time tells an attacker which half was wrong. verifyCredentials hashes
// against this when no such login exists.
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString("hex"));

// ── Seed ──
// Written once, on the first run that finds no users.json: the initial logins
// for the two accounts that already existed. Stored as hashes, not plaintext,
// so the repo never carries a usable password — rotate them from the
// dashboard (Dashboard logins) once each client has signed in.
const SEED_USERS = [
  {
    username: "ben",
    workspaces: ["ben-adu"],
    passwordHash:
      "scrypt$16384$8$1$K0T9neFBLWxulbjBwkQ67g==$PTsKOSrPzaoY5j4LM4LuOAQKMpxlA+Cm/dhXWPNnIJ0=",
  },
  {
    username: "perstrive",
    workspaces: ["perstrive"],
    passwordHash:
      "scrypt$16384$8$1$P8265qyqvoyF/bTcfGbD4A==$NNT9ibZ7DTnfZLTKeTMr6QU3KlmUycatBL+oGB+7PkM=",
  },
];

let store = loadStore();

function normalizeRecord(u) {
  if (!u || typeof u.username !== "string" || typeof u.passwordHash !== "string") return null;
  return {
    username: u.username.toLowerCase(),
    passwordHash: u.passwordHash,
    // A stored login is only ever scoped to workspaces; "admin" comes from .env.
    workspaces: Array.isArray(u.workspaces) ? u.workspaces.filter((w) => typeof w === "string") : [],
    createdAt: u.createdAt || new Date().toISOString(),
  };
}

function loadStore() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
      const list = Array.isArray(parsed && parsed.users) ? parsed.users : [];
      return { users: list.map(normalizeRecord).filter(Boolean) };
    }
  } catch (err) {
    // A corrupt file must not lock the admin out — .env still signs them in.
    console.error(`[USERS] users.json unreadable, ignoring it: ${err.message}`);
    return { users: [] };
  }

  const seeded = { users: SEED_USERS.map(normalizeRecord).filter(Boolean) };
  fs.writeFileSync(USERS_FILE, JSON.stringify(seeded, null, 2));
  console.log(`[USERS] seeded ${seeded.users.length} client login(s) into users.json`);
  return seeded;
}

function saveStore() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2));
}

// ── Reads ──
function findUser(username) {
  const key = String(username || "").toLowerCase();
  return store.users.find((u) => u.username === key) || null;
}

// Never leaks passwordHash — this is what the admin UI renders.
function listUsers() {
  return store.users.map((u) => ({
    username: u.username,
    workspaces: u.workspaces.slice(),
    createdAt: u.createdAt,
  }));
}

function usersForWorkspace(workspaceId) {
  return store.users.filter((u) => u.workspaces.includes(workspaceId)).map((u) => u.username);
}

// ── Validation ──
// Both run before an ad account is created, so a rejected login never leaves
// a half-built workspace behind.
function validateUsername(raw, { reservedAdmin } = {}) {
  const username = String(raw || "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new Error(
      "Username must be 2–32 characters — lowercase letters, digits, dot, dash or underscore, starting with a letter or digit"
    );
  }
  if (reservedAdmin && username === String(reservedAdmin).toLowerCase()) {
    throw new Error(`"${username}" is the admin login and cannot be reused`);
  }
  if (findUser(username)) throw new Error(`Username "${username}" is already taken`);
  return username;
}

function validatePassword(raw) {
  const password = String(raw == null ? "" : raw);
  if (password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  return password;
}

// ── Writes ──
function addUser({ username, password, workspaces, reservedAdmin }) {
  const name = validateUsername(username, { reservedAdmin });
  const pw = validatePassword(password);
  const scope = Array.isArray(workspaces) ? workspaces.filter(Boolean) : [];
  if (!scope.length) throw new Error("A login must be scoped to at least one account");

  const record = {
    username: name,
    passwordHash: hashPassword(pw),
    workspaces: scope,
    createdAt: new Date().toISOString(),
  };
  store.users = store.users.concat(record);
  saveStore();
  return { username: record.username, workspaces: record.workspaces.slice(), createdAt: record.createdAt };
}

function setPassword(username, password) {
  const user = findUser(username);
  if (!user) throw new Error(`No such login "${username}"`);
  user.passwordHash = hashPassword(validatePassword(password));
  saveStore();
  return { username: user.username, workspaces: user.workspaces.slice() };
}

function setWorkspaces(username, workspaces) {
  const user = findUser(username);
  if (!user) throw new Error(`No such login "${username}"`);
  const scope = Array.isArray(workspaces) ? workspaces.filter(Boolean) : [];
  if (!scope.length) throw new Error("A login must be scoped to at least one account");
  user.workspaces = scope;
  saveStore();
  return { username: user.username, workspaces: user.workspaces.slice() };
}

function removeUser(username) {
  const user = findUser(username);
  if (!user) throw new Error(`No such login "${username}"`);
  store.users = store.users.filter((u) => u.username !== user.username);
  saveStore();
  return { username: user.username, workspaces: user.workspaces.slice() };
}

// Removing an ad account takes its logins with it — but only the ones that
// exist solely for it. A login scoped to several accounts just loses that one.
function detachWorkspace(workspaceId) {
  const dropped = [];
  const kept = [];
  store.users.forEach((u) => {
    if (!u.workspaces.includes(workspaceId)) {
      kept.push(u);
      return;
    }
    const rest = u.workspaces.filter((w) => w !== workspaceId);
    if (rest.length) {
      u.workspaces = rest;
      kept.push(u);
    } else {
      dropped.push(u.username);
    }
  });
  if (kept.length !== store.users.length || dropped.length) {
    store.users = kept;
    saveStore();
  }
  return dropped;
}

module.exports = {
  DUMMY_HASH,
  MIN_PASSWORD,
  hashPassword,
  verifyPassword,
  findUser,
  listUsers,
  usersForWorkspace,
  validateUsername,
  validatePassword,
  addUser,
  setPassword,
  setWorkspaces,
  removeUser,
  detachWorkspace,
};
