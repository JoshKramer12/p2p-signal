//p2p-signal/server.js
//test

const http = require("http");
const http2 = require("http2");
const WebSocket = require("ws");
const { randomUUID, createHash, createHmac, timingSafeEqual, createSign } = require("crypto");
const net = require("net");
const yauzl = require("yauzl");

const PORT = process.env.PORT || 8080;

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MIN_INTENT_TTL_MS = Math.max(60 * 1000, Number(process.env.MIN_INTENT_TTL_MS || 60 * 1000));
const TRANSFER_IDLE_TIMEOUT_MS = Number(process.env.TRANSFER_IDLE_TIMEOUT_MS || 3 * 60 * 1000);
const TRANSFER_SWEEP_INTERVAL_MS = Number(process.env.TRANSFER_SWEEP_INTERVAL_MS || 15 * 1000);
const USER_STORAGE_QUOTA_BYTES = Number(process.env.USER_STORAGE_QUOTA_BYTES || 5 * 1024 * 1024 * 1024);
const ARCHIVE_PREVIEW_MAX_BYTES = Math.max(
  Number(process.env.ARCHIVE_PREVIEW_MAX_BYTES || 0) || 0,
  10 * 1024 * 1024 * 1024
);
const PREVIEW_CACHE_TTL_MS = Number(process.env.PREVIEW_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const ARCHIVE_INDEX_CACHE_TTL_MS = Number(process.env.ARCHIVE_INDEX_CACHE_TTL_MS || 15 * 60 * 1000);
const ARCHIVE_PREVIEW_WARMUP_MAX_BYTES = Math.max(
  0,
  Number(process.env.ARCHIVE_PREVIEW_WARMUP_MAX_BYTES || 3 * 1024 * 1024 * 1024)
);
const ARCHIVE_PREVIEW_WARMUP_MAX_ENTRIES = Math.max(
  0,
  Number(process.env.ARCHIVE_PREVIEW_WARMUP_MAX_ENTRIES || 12)
);
const ARCHIVE_PREVIEW_WARMUP_ENTRY_MAX_BYTES = Math.max(
  512 * 1024,
  Number(process.env.ARCHIVE_PREVIEW_WARMUP_ENTRY_MAX_BYTES || 40 * 1024 * 1024)
);
const WS_MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 64 * 1024 * 1024);
const INLINE_TINY_INTENT_MAX_BYTES = Math.max(
  1024,
  Math.min(1024 * 1024, Number(process.env.INLINE_TINY_INTENT_MAX_BYTES || 1024 * 1024))
);
const INTENT_LIST_CACHE_TTL_MS = Math.max(250, Number(process.env.INTENT_LIST_CACHE_TTL_MS || 10 * 1000));
// Keep Office-native preview compatibility by default.
// Set REQUIRE_E2EE=1 in env if you want to force encrypted file/message payloads again.
const REQUIRE_E2EE = String(process.env.REQUIRE_E2EE || "0") !== "0";
const OFFLINE_UPLOAD_STREAM_HWM_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.OFFLINE_UPLOAD_STREAM_HWM_BYTES || 16 * 1024 * 1024)
);
const OBJECT_MULTIPART_THRESHOLD_BYTES = Math.max(
  5 * 1024 * 1024,
  Number(process.env.OBJECT_MULTIPART_THRESHOLD_BYTES || 8 * 1024 * 1024)
);
const OBJECT_MULTIPART_PART_SIZE_BYTES = Math.max(
  5 * 1024 * 1024,
  Number(process.env.OBJECT_MULTIPART_PART_SIZE_BYTES || 8 * 1024 * 1024)
);
const OBJECT_MULTIPART_MAX_PARTS = 10000;
const OBJECT_MULTIPART_CLIENT_CONCURRENCY = Math.max(
  1,
  Math.min(10, Number(process.env.OBJECT_MULTIPART_CLIENT_CONCURRENCY || 10))
);
const INBOX_REQUEST_MIN_INTERVAL_MS = Math.max(0, Number(process.env.INBOX_REQUEST_MIN_INTERVAL_MS || 500));
const UPLOAD_CHECKPOINT_EVERY_BYTES = Math.max(
  256 * 1024,
  Number(process.env.UPLOAD_CHECKPOINT_EVERY_BYTES || 8 * 1024 * 1024)
);
const UPLOAD_CHECKPOINT_MIN_INTERVAL_MS = Math.max(
  250,
  Number(process.env.UPLOAD_CHECKPOINT_MIN_INTERVAL_MS || 2500)
);
const INTENT_UNLOCK_TTL_ONCE_MS = Math.max(
  60 * 1000,
  Number(process.env.INTENT_UNLOCK_TTL_ONCE_MS || 12 * 60 * 60 * 1000)
);
const INTENT_UNLOCK_TTL_ALWAYS_MS = Math.max(
  10 * 1000,
  Number(process.env.INTENT_UNLOCK_TTL_ALWAYS_MS || 2 * 60 * 1000)
);
const INTENT_UNLOCK_SECRET = String(process.env.INTENT_UNLOCK_SECRET || randomUUID() + randomUUID());
const GUEST_TRANSFER_REQUEST_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.GUEST_TRANSFER_REQUEST_TTL_MS || 24 * 60 * 60 * 1000)
);
const GUEST_APP_BASE_URL = String(process.env.GUEST_APP_BASE_URL || "https://merm.fly.dev").trim();
const GUEST_BRIDGE_SECRET = String(process.env.GUEST_BRIDGE_SECRET || "").trim();
const ADMIN_USERNAMES = new Set(
  String(process.env.ADMIN_USERNAMES || "Josh")
    .split(",")
    .map((raw) => String(raw || "").trim().replace(/^@+/, "").toLowerCase())
    .filter(Boolean)
);
const CHAT_STATE_MAX_KEYS = Math.max(128, Number(process.env.CHAT_STATE_MAX_KEYS || 2000));
const QUICK_CHATS_MAX_ITEMS = Math.max(50, Number(process.env.QUICK_CHATS_MAX_ITEMS || 500));
const CHAT_STATE_MAX_NICKNAMES = Math.max(64, Number(process.env.CHAT_STATE_MAX_NICKNAMES || 1000));
const CHAT_STATE_MAX_ALIASES = Math.max(64, Number(process.env.CHAT_STATE_MAX_ALIASES || 1000));
const FILE_HOLDER_MAX_ITEMS = Math.max(20, Number(process.env.FILE_HOLDER_MAX_ITEMS || 200));
const FILE_HOLDER_MAX_FILE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.FILE_HOLDER_MAX_FILE_BYTES || 20 * 1024 * 1024 * 1024)
);
const PUSH_DEVICE_MAX_PER_USER = Math.max(1, Number(process.env.PUSH_DEVICE_MAX_PER_USER || 8));
const MAX_SESSION_TOKENS = Math.max(8, Number(process.env.MAX_SESSION_TOKENS || 40));
const APNS_TEAM_ID = String(process.env.APNS_TEAM_ID || "").trim();
const APNS_KEY_ID = String(process.env.APNS_KEY_ID || "").trim();
const APNS_TOPIC = String(process.env.APNS_TOPIC || process.env.APNS_BUNDLE_ID || "test.P2PTest").trim();
const APNS_PRIVATE_KEY = String(process.env.APNS_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
const APNS_USE_SANDBOX = String(process.env.APNS_USE_SANDBOX || "1").trim() !== "0";
const APNS_HOST_SANDBOX = "https://api.sandbox.push.apple.com";
const APNS_HOST_PRODUCTION = "https://api.push.apple.com";
const APNS_DEFAULT_HOST = APNS_USE_SANDBOX ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;
const APNS_ENABLED = Boolean(APNS_TEAM_ID && APNS_KEY_ID && APNS_TOPIC && APNS_PRIVATE_KEY);

function isAdminUsername(username = "") {
  const normalized = String(username || "").trim().replace(/^@+/, "").toLowerCase();
  return Boolean(normalized) && ADMIN_USERNAMES.has(normalized);
}

function isAdminSocket(ws = null) {
  return Boolean(ws && isAdminUsername(ws.username));
}

// username -> ws
const online = new Map();
// username -> Set<ws> (multi-device support)
const onlineSockets = new Map();

// username -> [intent, intent, intent]
const inboxes = new Map();

// intentId -> { tcp: net.Socket, bytesExpected, bytesSent, senderWs, receiverWs }
const activeTransfers = new Map();
const archiveIndexCache = new Map(); // intentId -> { entries, archiveSize, archiveMtimeMs, cachedAt }
const archiveIndexBuildJobs = new Map(); // `${intentId}:${archiveSize}:${archiveMtimeMs}` -> Promise<entries[]>
const archivePreviewWarmupJobs = new Map(); // intentId -> Promise<void>
const previewExtractJobs = new Map(); // cachePath -> Promise<void>
const intentObjectCacheJobs = new Map(); // outputPath -> Promise<string>
const intentListCacheByUser = new Map(); // username -> { ts, items }

function getOnlineSocketSet(username = "") {
  const name = String(username || "").trim();
  if (!name) return null;
  let set = onlineSockets.get(name);
  if (!set) {
    set = new Set();
    onlineSockets.set(name, set);
  }
  return set;
}

function registerOnlineSocket(username = "", ws = null) {
  const name = String(username || "").trim();
  if (!name || !ws) return;
  const set = getOnlineSocketSet(name);
  set.add(ws);
  online.set(name, ws);
}

function getOnlineSocketsForUser(username = "") {
  const name = String(username || "").trim();
  if (!name) return [];
  const set = onlineSockets.get(name);
  if (!set || !set.size) return [];
  const alive = [];
  for (const sock of Array.from(set)) {
    if (sock && sock.readyState === WebSocket.OPEN) {
      alive.push(sock);
    } else {
      set.delete(sock);
    }
  }
  if (!set.size) {
    onlineSockets.delete(name);
  }
  return alive;
}

function isUserOnline(username = "") {
  return getOnlineSocketsForUser(username).length > 0;
}

function sendToUser(username = "", payload = null, options = {}) {
  const name = String(username || "").trim();
  if (!name || !payload) return false;
  const excludeWs = options?.excludeWs || null;
  const sockets = getOnlineSocketsForUser(name);
  let sent = false;
  sockets.forEach((sock) => {
    if (!sock || sock === excludeWs) return;
    if (send(sock, payload)) sent = true;
  });
  return sent;
}

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ""), "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

let apnsJwtCache = { token: "", expiresAtMs: 0 };
const apnsClients = new Map(); // host -> { client, healthy }

function closeApnsClient(host = "") {
  const target = String(host || "").trim();
  if (target) {
    const existing = apnsClients.get(target);
    if (!existing?.client) {
      apnsClients.delete(target);
      return;
    }
    try { existing.client.close(); } catch {}
    try { existing.client.destroy(); } catch {}
    apnsClients.delete(target);
    return;
  }
  Array.from(apnsClients.keys()).forEach((key) => closeApnsClient(key));
}

function buildApnsJwt() {
  if (!APNS_ENABLED) return "";
  const nowMs = Date.now();
  if (apnsJwtCache.token && nowMs < apnsJwtCache.expiresAtMs) {
    return apnsJwtCache.token;
  }
  const nowSec = Math.floor(nowMs / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID }));
  const payload = base64UrlEncode(JSON.stringify({ iss: APNS_TEAM_ID, iat: nowSec }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(APNS_PRIVATE_KEY);
  const token = `${signingInput}.${base64UrlEncode(signature)}`;
  apnsJwtCache = {
    token,
    expiresAtMs: nowMs + (50 * 60 * 1000) // Apple allows up to 60 minutes; refresh a bit earlier.
  };
  return token;
}

function apnsHostForEnvironment(environment = "") {
  const normalized = normalizePushEnvironment(environment || (APNS_USE_SANDBOX ? "sandbox" : "production"));
  return normalized === "production" ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
}

function getApnsClient(host = APNS_DEFAULT_HOST) {
  if (!APNS_ENABLED) return null;
  const target = String(host || APNS_DEFAULT_HOST).trim() || APNS_DEFAULT_HOST;
  const existing = apnsClients.get(target);
  if (existing?.client && existing.healthy) return existing.client;
  closeApnsClient(target);
  const client = http2.connect(target);
  const state = { client, healthy: true };
  apnsClients.set(target, state);
  client.on("error", () => {
    state.healthy = false;
    closeApnsClient(target);
  });
  client.on("goaway", () => {
    state.healthy = false;
    closeApnsClient(target);
  });
  client.on("close", () => {
    state.healthy = false;
  });
  return client;
}

function normalizePushDeviceToken(value = "") {
  const token = String(value || "").replace(/[<>\s]/g, "").trim().toLowerCase();
  return /^[a-f0-9]{64,256}$/.test(token) ? token : "";
}

function normalizePushEnvironment(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "prod" || raw === "production") return "production";
  return "sandbox";
}

function normalizePushDevices(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const token = normalizePushDeviceToken(raw?.token || raw?.deviceToken || raw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push({
      token,
      platform: String(raw?.platform || "ios").trim().slice(0, 32) || "ios",
      bundleId: String(raw?.bundleId || APNS_TOPIC).trim().slice(0, 128) || APNS_TOPIC,
      environment: normalizePushEnvironment(raw?.environment || (APNS_USE_SANDBOX ? "sandbox" : "production")),
      updatedAt: Number(raw?.updatedAt || Date.now()) || Date.now(),
      lastSuccessAt: Number(raw?.lastSuccessAt || 0) || 0,
      failureCount: Math.max(0, Number(raw?.failureCount || 0) || 0),
      disabled: Boolean(raw?.disabled)
    });
    if (out.length >= PUSH_DEVICE_MAX_PER_USER) break;
  }
  return out;
}

function userDisplayName(username = "") {
  const name = String(username || "").trim();
  if (!name) return "";
  const user = loadUser(name);
  const profile = user?.profile || {};
  const first = String(profile.firstName || "").trim();
  const last = String(profile.lastName || "").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  if (full) return full;
  const legacy = String(profile.name || "").trim();
  if (legacy) return legacy;
  return name;
}

function updateUserPushDevices(username = "", mutator = null) {
  const name = String(username || "").trim();
  if (!name || typeof mutator !== "function") return { ok: false, changed: false, devices: [] };
  const raw = loadUser(name);
  if (!raw) return { ok: false, changed: false, devices: [] };
  const user = ensureUserShape(raw);
  const draft = normalizePushDevices(user.pushDevices || []);
  const changed = Boolean(mutator(draft, user));
  if (!changed) return { ok: true, changed: false, devices: draft };
  user.pushDevices = normalizePushDevices(draft);
  saveUser(user);
  return { ok: true, changed: true, devices: user.pushDevices.slice() };
}

function upsertUserPushDevice(username = "", payload = {}) {
  const name = String(username || "").trim();
  const token = normalizePushDeviceToken(payload?.deviceToken || payload?.token || "");
  if (!name || !token) return { ok: false, changed: false, devices: [] };
  const now = Date.now();
  return updateUserPushDevices(name, (draft) => {
    const idx = draft.findIndex((entry) => entry.token === token);
    const next = {
      token,
      platform: "ios",
      bundleId: String(payload?.bundleId || APNS_TOPIC).trim().slice(0, 128) || APNS_TOPIC,
      environment: normalizePushEnvironment(payload?.environment || (APNS_USE_SANDBOX ? "sandbox" : "production")),
      updatedAt: now,
      lastSuccessAt: idx >= 0 ? Number(draft[idx]?.lastSuccessAt || 0) : 0,
      failureCount: 0,
      disabled: false
    };
    if (idx >= 0) draft.splice(idx, 1);
    draft.unshift(next);
    while (draft.length > PUSH_DEVICE_MAX_PER_USER) draft.pop();
    return true;
  });
}

function removeUserPushDevice(username = "", deviceToken = "") {
  const name = String(username || "").trim();
  const token = normalizePushDeviceToken(deviceToken);
  if (!name || !token) return { ok: false, changed: false, devices: [] };
  return updateUserPushDevices(name, (draft) => {
    const next = draft.filter((entry) => entry.token !== token);
    if (next.length === draft.length) return false;
    draft.splice(0, draft.length, ...next);
    return true;
  });
}

function markUserPushDeviceResult(username = "", token = "", { ok = false, disable = false } = {}) {
  const name = String(username || "").trim();
  const normalizedToken = normalizePushDeviceToken(token);
  if (!name || !normalizedToken) return;
  updateUserPushDevices(name, (draft) => {
    const idx = draft.findIndex((entry) => entry.token === normalizedToken);
    if (idx < 0) return false;
    const current = draft[idx] || {};
    const next = { ...current };
    if (ok) {
      next.failureCount = 0;
      next.lastSuccessAt = Date.now();
      next.disabled = false;
    } else {
      next.failureCount = Math.max(0, Number(current.failureCount || 0)) + 1;
      if (disable) next.disabled = true;
    }
    draft[idx] = next;
    return true;
  });
}

function isPermanentApnsFailure(result = {}) {
  const status = Number(result?.status || 0) || 0;
  const reason = String(result?.reason || "");
  if ([400, 410].includes(status)) {
    return ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "TopicDisallowed"].includes(reason);
  }
  return ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "TopicDisallowed"].includes(reason);
}

function isTransientApnsFailure(result = {}) {
  const status = Number(result?.status || 0) || 0;
  const reason = String(result?.reason || "");
  if (status === 0 || status === 429 || status >= 500) return true;
  return [
    "TooManyRequests",
    "InternalServerError",
    "ServiceUnavailable",
    "Shutdown",
    "IdleTimeout",
    "ExpiredProviderToken"
  ].includes(reason);
}

function waitMs(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function sendApnsToDevice({ token, topic, payload, host = "", collapseId = "" }) {
  return new Promise((resolve) => {
    if (!APNS_ENABLED) {
      resolve({ ok: false, status: 0, reason: "apns-disabled" });
      return;
    }
    const targetHost = String(host || APNS_DEFAULT_HOST).trim() || APNS_DEFAULT_HOST;
    const client = getApnsClient(targetHost);
    const jwt = buildApnsJwt();
    if (!client || !jwt) {
      resolve({ ok: false, status: 0, reason: "apns-unavailable" });
      return;
    }

    const headers = {
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "apns-topic": topic || APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "authorization": `bearer ${jwt}`
    };
    const collapse = String(collapseId || "").trim();
    if (collapse) headers["apns-collapse-id"] = collapse.slice(0, 64);

    const req = client.request(headers);

    let status = 0;
    let responseBody = "";
    req.setEncoding("utf8");
    req.on("response", (headers) => {
      status = Number(headers?.[":status"] || 0) || 0;
    });
    req.on("data", (chunk) => {
      responseBody += String(chunk || "");
    });
    req.on("error", () => {
      resolve({ ok: false, status: 0, reason: "request-error" });
    });
    req.on("end", () => {
      if (status === 200) {
        resolve({ ok: true, status, reason: "" });
        return;
      }
      let reason = "";
      try {
        const parsed = JSON.parse(responseBody || "{}");
        reason = String(parsed?.reason || "");
      } catch {}
      resolve({ ok: false, status, reason, host: targetHost });
    });

    req.end(JSON.stringify(payload || {}));
  });
}

function queuePushNotificationForUser(username = "", payload = {}) {
  if (!APNS_ENABLED) return false;
  const name = String(username || "").trim();
  if (!name) return false;
  const user = loadUser(name);
  if (!user) return false;
  const devices = normalizePushDevices(ensureUserShape(user).pushDevices || [])
    .filter((entry) => !entry.disabled && String(entry.platform || "").toLowerCase() === "ios");
  if (!devices.length) return false;

  const unreadChats = countUnreadChatsForUser(name, user);
  const pendingRequests = countPendingRequestsForUser(name);
  const guestTransferRequests = listGuestTransferRequestsForUser(name).length;
  const badgeCount = Math.max(0, unreadChats + pendingRequests + guestTransferRequests);

  const title = String(payload?.title || "Merm").trim().slice(0, 120) || "Merm";
  const body = String(payload?.body || "You have a new message.").trim().slice(0, 220) || "You have a new message.";
  const intentId = String(payload?.intentId || "").trim();
  const chatKey = String(payload?.chatKey || "").trim();
  const sender = String(payload?.sender || "").trim();
  const groupId = String(payload?.groupId || "").trim();

  const apnsPayload = {
    aps: {
      alert: { title, body },
      badge: badgeCount,
      sound: "default",
      "content-available": 1,
      "thread-id": chatKey || sender || "merm"
    },
    merm: {
      intentId,
      chatKey,
      sender,
      groupId
    }
  };

  setImmediate(async () => {
    const pushEventId = (intentId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 64);
    for (const device of devices) {
      const token = normalizePushDeviceToken(device.token);
      if (!token) continue;
      const topic = String(device.bundleId || APNS_TOPIC).trim() || APNS_TOPIC;
      const preferredHost = apnsHostForEnvironment(device.environment);
      const alternateHost = preferredHost === APNS_HOST_PRODUCTION ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;

      let result = await sendApnsToDevice({
        token,
        topic,
        payload: apnsPayload,
        host: preferredHost,
        collapseId: pushEventId
      });

      if (!result.ok && isTransientApnsFailure(result)) {
        let attempt = 0;
        while (!result.ok && isTransientApnsFailure(result) && attempt < 3) {
          attempt += 1;
          await waitMs(220 * Math.pow(2, attempt - 1));
          result = await sendApnsToDevice({
            token,
            topic,
            payload: apnsPayload,
            host: preferredHost,
            collapseId: pushEventId
          });
        }
      }

      // If device environment was stale/mismatched, try the other APNs host once.
      if (!result.ok && isPermanentApnsFailure(result) && String(result?.reason || "") === "BadDeviceToken") {
        const retryOtherHost = await sendApnsToDevice({
          token,
          topic,
          payload: apnsPayload,
          host: alternateHost,
          collapseId: pushEventId
        });
        if (retryOtherHost.ok) {
          result = retryOtherHost;
        }
      }

      if (result.ok) {
        markUserPushDeviceResult(name, token, { ok: true });
        continue;
      }
      const disable = isPermanentApnsFailure(result);
      markUserPushDeviceResult(name, token, { ok: false, disable });
    }
  });
  return true;
}

function unregisterOnlineSocket(username = "", ws = null) {
  const name = String(username || "").trim();
  if (!name || !ws) return false;
  const set = onlineSockets.get(name);
  if (set) {
    set.delete(ws);
    for (const sock of Array.from(set)) {
      if (!sock || sock.readyState !== WebSocket.OPEN) set.delete(sock);
    }
    if (!set.size) onlineSockets.delete(name);
  }
  const current = online.get(name);
  if (!current || current === ws || current.readyState !== WebSocket.OPEN) {
    const replacement = getOnlineSocketsForUser(name)[0] || null;
    if (replacement) online.set(name, replacement);
    else online.delete(name);
  }
  return isUserOnline(name);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,X-Merm-Password,X-Merm-Unlock,X-Merm-Session,X-Merm-Username,X-Merm-File-Name,X-Merm-File-Mime");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Disposition,Content-Range,Accept-Ranges,X-Merm-Unlock,X-Merm-Unlock-Exp");
}

function extractSessionTokenFromRequest(req, url) {
  const headerRaw = req?.headers?.["x-merm-session"];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (headerValue != null) return String(headerValue || "").trim();
  const queryValue = url?.searchParams?.get("sessionToken");
  if (queryValue != null) return String(queryValue || "").trim();
  return "";
}

function extractUsernameFromRequest(req, url) {
  const headerRaw = req?.headers?.["x-merm-username"];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (headerValue != null) return String(headerValue || "").trim();
  const queryValue = url?.searchParams?.get("username");
  if (queryValue != null) return String(queryValue || "").trim();
  return "";
}

function verifyAccountSession(username = "", sessionToken = "") {
  const name = String(username || "").trim();
  const token = String(sessionToken || "").trim();
  if (!name || !token) return null;
  const raw = loadUser(name);
  if (!raw) return null;
  const user = ensureUserShape(raw);
  if (!Array.isArray(user.sessionTokens) || !user.sessionTokens.includes(token)) return null;
  if (touchUserSessionToken(user, token)) {
    saveUser(user);
  }
  return user;
}

function resolveAuthenticatedUsernameFromRequest(req, url) {
  const username = extractUsernameFromRequest(req, url);
  const sessionToken = extractSessionTokenFromRequest(req, url);
  if (!username || !sessionToken) return "";
  const user = verifyAccountSession(username, sessionToken);
  return String(user?.username || "").trim();
}

function markIntentDownloadedByRecipient(intent = null, downloaderUsername = "", options = {}) {
  if (!intent || typeof intent !== "object") return false;
  if (intent.isTextOnly || String(intent.messageType || "").toLowerCase() === "text") return false;

  const by = String(downloaderUsername || "").trim();
  const sender = String(intent.from || "").trim();
  const recipient = String(intent.to || "").trim();
  if (!by || !sender || !recipient) return false;
  if (by !== recipient) return false;
  if (by === sender) return false;

  const existing = Number(intent.downloadedByRecipientAt || 0);
  if (Number.isFinite(existing) && existing > 0) return false;

  const now = Math.max(1, Number(options?.downloadedAt || Date.now()) || Date.now());
  intent.downloadedByRecipientAt = now;
  intent.downloadedByRecipientBy = by;
  intent.updatedAt = now;
  saveIntent(intent);

  let senderEventIntentId = String(intent.id || "").trim();
  const groupPrimaryIntentId = String(intent.groupPrimaryIntentId || "").trim();
  if (groupPrimaryIntentId) {
    const primary = loadIntent(groupPrimaryIntentId);
    if (primary && String(primary.from || "").trim() === sender) {
      const primaryExisting = Number(primary.downloadedByRecipientAt || 0);
      if (!(Number.isFinite(primaryExisting) && primaryExisting > 0)) {
        primary.downloadedByRecipientAt = now;
        primary.downloadedByRecipientBy = by;
        primary.updatedAt = now;
        saveIntent(primary);
      }
      senderEventIntentId = String(primary.id || groupPrimaryIntentId).trim() || senderEventIntentId;
    }
  }

  sendToUser(sender, {
    type: "intent_downloaded",
    intentId: senderEventIntentId,
    downloadedAt: now,
    by,
    from: sender,
    to: recipient,
    groupId: String(intent.groupId || "").trim(),
    source: String(options?.source || "download").trim() || "download"
  });
  return true;
}

function maybeMarkIntentDownloadedFromRequest(intent = null, req = null, url = null, options = {}) {
  if (!intent || typeof intent !== "object") return false;
  if (String(url?.searchParams?.get("track") || "") !== "1") return false;
  const method = String(req?.method || "GET").trim().toUpperCase();
  if (method === "HEAD") return false;
  const dispositionType = String(options?.dispositionType || "").trim().toLowerCase();
  if (dispositionType && dispositionType !== "attachment") return false;
  const downloaderUsername = resolveAuthenticatedUsernameFromRequest(req, url);
  if (!downloaderUsername) return false;
  return markIntentDownloadedByRecipient(intent, downloaderUsername, options);
}

function intentChatKeyForUser(intent = {}, username = "") {
  const name = String(username || "").trim();
  if (!name || !intent || typeof intent !== "object") return "";
  const groupId = String(intent.groupId || "").trim();
  if (groupId) return groupChatKey(groupId);
  const from = String(intent.from || "").trim();
  const to = String(intent.to || "").trim();
  if (from === name) return to || from;
  if (to === name) return from || to;
  return from || to || "";
}

function countUnreadChatsForUser(username = "", userRecord = null) {
  const name = String(username || "").trim();
  if (!name) return 0;
  const user = ensureUserShape(userRecord || loadUser(name) || {});
  const unreadChatKeys = new Set(
    filterChatKeysForUser(user, user?.chatState?.manualUnread || [])
  );
  const intents = loadIntentsForUser(name);
  intents.forEach((intent) => {
    if (!intent || typeof intent !== "object") return;
    const to = String(intent.to || "").trim();
    if (to !== name) return;
    if (intent.isSystemEvent || String(intent.messageType || "").toLowerCase() === "system") return;
    const readAt = Number(intent.readByRecipientAt || intent.recipientReadAt || intent.readAt || 0);
    if (Number.isFinite(readAt) && readAt > 0) return;
    const key = intentChatKeyForUser(intent, name);
    if (key) unreadChatKeys.add(key);
  });
  return unreadChatKeys.size;
}

function contentTypeForName(name = "") {
  const ext = String(path.extname(name || "") || "").toLowerCase();
  const map = {
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".rtf": "application/rtf",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".flac": "audio/flac",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docm": "application/vnd.ms-word.document.macroEnabled.12",
    ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    ".dotm": "application/vnd.ms-word.template.macroEnabled.12",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    ".xlt": "application/vnd.ms-excel",
    ".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    ".xltm": "application/vnd.ms-excel.template.macroEnabled.12",
    ".xla": "application/vnd.ms-excel",
    ".xlam": "application/vnd.ms-excel.addin.macroEnabled.12",
    ".xcl": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
    ".pps": "application/vnd.ms-powerpoint",
    ".ppsx": "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ".ppsm": "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".folder": "application/x-merm-folder"
  };
  return map[ext] || "application/octet-stream";
}

function generateDownloadToken() {
  return randomUUID() + randomUUID();
}

function normalizeZipPath(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function openZipFile(filePath, options = {}) {
  const opts = {
    lazyEntries: true,
    autoClose: true,
    decodeStrings: true,
    validateEntrySizes: true,
    ...options
  };
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, opts, (err, zipFile) => {
      if (err || !zipFile) {
        reject(err || new Error("Could not open package"));
        return;
      }
      resolve(zipFile);
    });
  });
}

function parseHttpRange(rangeRaw = "", totalSize = 0) {
  const raw = String(rangeRaw || "").trim();
  if (!raw) return { ok: true, hasRange: false, start: 0, end: Math.max(0, totalSize - 1) };
  const bytesMatch = /^bytes\s*=\s*(.+)$/i.exec(raw);
  if (!bytesMatch) return { ok: false };

  // Some clients request multiple ranges in one header (e.g. "bytes=0-1023, 4096-8191").
  // Serve the first valid range instead of failing with 416.
  const firstRange = String(bytesMatch[1] || "")
    .split(",")
    .map((part) => String(part || "").trim())
    .find(Boolean);
  if (!firstRange) return { ok: false };

  const match = /^(\d*)-(\d*)$/.exec(firstRange);
  if (!match) return { ok: false };

  let start = 0;
  let end = Math.max(0, totalSize - 1);
  const startRaw = match[1];
  const endRaw = match[2];

  if (startRaw === "" && endRaw === "") return { ok: false };

  if (startRaw !== "") {
    start = Number(startRaw);
    end = endRaw !== "" ? Number(endRaw) : end;
  } else {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { ok: false };
    start = Math.max(0, totalSize - suffixLength);
    end = Math.max(0, totalSize - 1);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= totalSize
  ) {
    return { ok: false };
  }

  end = Math.min(end, Math.max(0, totalSize - 1));
  return {
    ok: true,
    hasRange: true,
    start,
    end
  };
}

function readJsonBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const limit = Math.max(1024, Number(maxBytes || 0));
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || "");
      total += buf.length;
      if (total > limit) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(buf);
    });
    req.on("error", (err) => reject(err));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
  });
}

function streamRequestBodyToFile(req, outputPath, maxBytes = FILE_HOLDER_MAX_FILE_BYTES) {
  return new Promise((resolve, reject) => {
    const limit = Math.max(1024, Number(maxBytes || FILE_HOLDER_MAX_FILE_BYTES || 0));
    const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ws = fs.createWriteStream(tmpPath, { flags: "w", mode: 0o644 });
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("error", onReqError);
      req.removeListener("aborted", onReqAborted);
      req.removeListener("end", onReqEnd);
      ws.removeListener("error", onWriteError);
      ws.removeListener("finish", onFinish);
      try { req.unpipe(ws); } catch {}
    };

    const fail = (err, status = 500) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { ws.destroy(); } catch {}
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      const outErr = err instanceof Error ? err : new Error(String(err || "Upload failed"));
      outErr.status = Number(status || outErr.status || 500);
      reject(outErr);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {}
      try {
        fs.renameSync(tmpPath, outputPath);
      } catch (err) {
        fail(err || new Error("Could not save upload"), 500);
        return;
      }
      resolve({ bytes: total });
    };

    const onData = (chunk) => {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk || "");
      total += size;
      if (total <= limit) return;
      fail(new Error("Payload too large"), 413);
      try { req.destroy(); } catch {}
    };
    const onReqError = (err) => fail(err || new Error("Upload stream failed"), 400);
    const onReqAborted = () => fail(new Error("Upload aborted"), 499);
    const onReqEnd = () => {
      try { ws.end(); } catch {}
    };
    const onWriteError = (err) => fail(err || new Error("Could not write upload"), 500);
    const onFinish = () => {
      if (total <= 0) {
        fail(new Error("Empty upload"), 400);
        return;
      }
      succeed();
    };

    req.on("data", onData);
    req.on("error", onReqError);
    req.on("aborted", onReqAborted);
    req.on("end", onReqEnd);
    ws.on("error", onWriteError);
    ws.on("finish", onFinish);
    req.pipe(ws);
  });
}

function isGuestBridgeAuthorized(req) {
  if (!GUEST_BRIDGE_SECRET) return true;
  const incoming = String(req.headers["x-merm-bridge-secret"] || "");
  if (!incoming) return false;
  const incomingHash = createHash("sha256").update(incoming).digest();
  const expectedHash = createHash("sha256").update(GUEST_BRIDGE_SECRET).digest();
  try {
    return timingSafeEqual(incomingHash, expectedHash);
  } catch {
    return false;
  }
}

function pruneArchiveIndexCache(maxEntries = 200) {
  if (archiveIndexCache.size <= maxEntries) return;
  const now = Date.now();
  const rows = Array.from(archiveIndexCache.entries());
  rows.sort((a, b) => {
    const aTs = Number(a?.[1]?.cachedAt || 0);
    const bTs = Number(b?.[1]?.cachedAt || 0);
    return aTs - bTs;
  });
  while (archiveIndexCache.size > maxEntries && rows.length) {
    const item = rows.shift();
    if (!item) break;
    archiveIndexCache.delete(item[0]);
  }
  // Drop stale entries even if cache is small.
  for (const [key, value] of archiveIndexCache.entries()) {
    const cachedAt = Number(value?.cachedAt || 0);
    if (!cachedAt || now - cachedAt > ARCHIVE_INDEX_CACHE_TTL_MS) {
      archiveIndexCache.delete(key);
    }
  }
}

function getCachedArchiveIndex(intentId, archiveStat) {
  const key = String(intentId || "");
  if (!key) return null;
  const cached = archiveIndexCache.get(key);
  if (!cached) return null;

  const now = Date.now();
  if (!cached.cachedAt || now - cached.cachedAt > ARCHIVE_INDEX_CACHE_TTL_MS) {
    archiveIndexCache.delete(key);
    return null;
  }
  if (Number(cached.archiveSize || 0) !== Number(archiveStat?.size || 0)) {
    archiveIndexCache.delete(key);
    return null;
  }
  if (Number(cached.archiveMtimeMs || 0) !== Number(archiveStat?.mtimeMs || 0)) {
    archiveIndexCache.delete(key);
    return null;
  }
  return Array.isArray(cached.entries) ? cached.entries : null;
}

function setCachedArchiveIndex(intentId, archiveStat, entries = []) {
  const key = String(intentId || "");
  if (!key) return;
  archiveIndexCache.set(key, {
    entries: Array.isArray(entries) ? entries : [],
    archiveSize: Number(archiveStat?.size || 0),
    archiveMtimeMs: Number(archiveStat?.mtimeMs || 0),
    cachedAt: Date.now()
  });
  pruneArchiveIndexCache();
}

function archiveIndexBuildJobKey(intentId, archiveStat = null) {
  const id = String(intentId || "").trim();
  if (!id) return "";
  const size = Math.max(0, Number(archiveStat?.size || 0));
  const mtimeMs = Math.max(0, Number(archiveStat?.mtimeMs || 0));
  return `${id}:${size}:${mtimeMs}`;
}

function clearArchiveIndexBuildJobsForIntent(intentId = "") {
  const id = String(intentId || "").trim();
  if (!id) return;
  const prefix = `${id}:`;
  Array.from(archiveIndexBuildJobs.keys()).forEach((key) => {
    if (String(key || "").startsWith(prefix)) {
      archiveIndexBuildJobs.delete(key);
    }
  });
}

function isArchivePreviewPackageIntent(intent = null) {
  const ext = String(path.extname(intent?.fileName || "") || "").toLowerCase();
  return ext === ".zip" || ext === ".folder";
}

function isImageArchiveEntryName(name = "") {
  const ext = String(path.extname(String(name || "").trim()) || "").toLowerCase();
  return [
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg",
    ".heic", ".heif", ".avif", ".tif", ".tiff"
  ].includes(ext);
}

async function buildArchiveIndexEntries(zipPath = "") {
  let zipFile;
  try {
    zipFile = await openZipFile(zipPath, { lazyEntries: true, autoClose: true });
  } catch (err) {
    const nextErr = err instanceof Error ? err : new Error("Could not read package");
    nextErr.status = 500;
    throw nextErr;
  }

  const entries = await new Promise((resolve, reject) => {
    const out = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      zipFile.removeAllListeners("entry");
      zipFile.removeAllListeners("error");
      zipFile.removeAllListeners("end");
      if (err) reject(err);
      else resolve(out);
    };

    zipFile.on("entry", (entry) => {
      const rawName = normalizeZipPath(entry?.fileName || "");
      if (!rawName || rawName.includes("\0")) {
        zipFile.readEntry();
        return;
      }

      const dir = /\/$/.test(rawName);
      const name = dir ? rawName : rawName.replace(/\/+$/, "");
      const size = Number(entry?.uncompressedSize || 0);
      const lastMod = entry?.getLastModDate instanceof Function ? entry.getLastModDate() : null;
      const dateMs = lastMod instanceof Date ? lastMod.getTime() : 0;
      out.push({
        name,
        dir,
        size: Number.isFinite(size) && size >= 0 ? size : 0,
        date: Number.isFinite(dateMs) && dateMs > 0 ? dateMs : 0
      });
      zipFile.readEntry();
    });

    zipFile.once("end", () => finish(null));
    zipFile.once("error", (err) => finish(err));
    zipFile.readEntry();
  }).catch((err) => {
    const nextErr = err instanceof Error ? err : new Error("Could not read package");
    nextErr.status = 500;
    throw nextErr;
  });

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return entries;
}

async function getArchiveIndexEntries(intentId, zipPath, archiveStat) {
  const cached = getCachedArchiveIndex(intentId, archiveStat);
  if (cached) return cached;

  const key = archiveIndexBuildJobKey(intentId, archiveStat);
  if (!key) {
    return buildArchiveIndexEntries(zipPath);
  }

  let job = archiveIndexBuildJobs.get(key);
  if (!job) {
    job = (async () => {
      const existing = getCachedArchiveIndex(intentId, archiveStat);
      if (existing) return existing;
      const rows = await buildArchiveIndexEntries(zipPath);
      setCachedArchiveIndex(intentId, archiveStat, rows);
      return rows;
    })().finally(() => {
      archiveIndexBuildJobs.delete(key);
    });
    archiveIndexBuildJobs.set(key, job);
  }
  return job;
}

function pickArchivePreviewWarmupEntries(entries = []) {
  const limit = Math.max(0, Number(ARCHIVE_PREVIEW_WARMUP_MAX_ENTRIES || 0));
  if (!limit || !Array.isArray(entries) || !entries.length) return [];
  const images = [];
  const others = [];
  for (const row of entries) {
    if (!row || row.dir) continue;
    const name = String(row.name || "").replace(/\\/g, "/");
    if (!name || name.includes("\0") || name.includes("..")) continue;
    const size = Math.max(0, Number(row?.size || 0));
    if (size > ARCHIVE_PREVIEW_WARMUP_ENTRY_MAX_BYTES) continue;
    if (isImageArchiveEntryName(name)) {
      images.push(row);
      continue;
    }
    if (others.length < limit) {
      others.push(row);
    }
  }
  const preferred = images.slice(0, limit);
  if (preferred.length >= limit) return preferred;
  const remaining = limit - preferred.length;
  return preferred.concat(others.slice(0, remaining));
}

async function warmIntentArchivePreview(intent = null) {
  if (!intent || !intent.id || !hasStoredAsset(intent)) return;
  if (!isArchivePreviewPackageIntent(intent)) return;

  const expectedBytes = Math.max(
    0,
    Number(intent?.storedBytes || intent?.uploadBytesExpected || intent?.fileSize || 0)
  );
  if (expectedBytes > ARCHIVE_PREVIEW_WARMUP_MAX_BYTES) return;

  const filePath = await ensureIntentStoredFilePath(intent);
  if (!filePath) return;

  let archiveStat;
  try {
    archiveStat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (!archiveStat?.isFile?.()) return;
  if (Math.max(0, Number(archiveStat.size || 0)) > ARCHIVE_PREVIEW_MAX_BYTES) return;

  let entries = [];
  try {
    entries = await getArchiveIndexEntries(intent.id, filePath, archiveStat);
  } catch {
    return;
  }

  const warmRows = pickArchivePreviewWarmupEntries(entries);
  if (!warmRows.length) return;

  for (const row of warmRows) {
    const entryPath = String(row?.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!entryPath || entryPath.includes("..") || entryPath.includes("\0")) continue;
    const safeName = safeBasename(path.basename(entryPath) || "file");
    try {
      await ensureZipEntryExtracted(intent.id, filePath, entryPath, safeName);
    } catch {}
  }
}

function queueIntentArchivePreviewWarmup(intent = null) {
  const id = String(intent?.id || "").trim();
  if (!id) return;
  if (archivePreviewWarmupJobs.has(id)) return;
  const job = (async () => {
    const latest = loadIntent(id) || intent;
    await warmIntentArchivePreview(latest);
  })().catch(() => {
    // Keep preview warmup best-effort and non-blocking.
  }).finally(() => {
    archivePreviewWarmupJobs.delete(id);
  });
  archivePreviewWarmupJobs.set(id, job);
}

function buildPreviewEntryCachePath(intentId, entryPath, safeName = "file") {
  const key = `${String(intentId || "")}\n${String(entryPath || "")}`;
  const hash = createHash("sha1").update(key).digest("hex");
  const extRaw = String(path.extname(safeName || "") || "").toLowerCase();
  const ext = /^[a-z0-9.]{1,20}$/.test(extRaw) ? extRaw : "";
  return path.join(PREVIEW_CACHE_DIR, `${intentId}--${hash}${ext}`);
}

function touchFile(filePath) {
  try {
    const now = new Date();
    fs.utimesSync(filePath, now, now);
  } catch {}
}

function removePreviewCacheForIntent(intentId) {
  const id = String(intentId || "").trim();
  if (!id) return;
  try {
    const names = fs.readdirSync(PREVIEW_CACHE_DIR);
    const prefix = `${id}--`;
    names.forEach((name) => {
      if (!name.startsWith(prefix)) return;
      try {
        fs.unlinkSync(path.join(PREVIEW_CACHE_DIR, name));
      } catch {}
    });
  } catch {}
}

function cleanupPreviewCache() {
  try {
    const ttl = Math.max(5 * 60 * 1000, Number(PREVIEW_CACHE_TTL_MS || 0));
    const now = Date.now();
    const names = fs.readdirSync(PREVIEW_CACHE_DIR);
    names.forEach((name) => {
      const full = path.join(PREVIEW_CACHE_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) return;
        const touchedAt = Math.max(Number(stat.mtimeMs || 0), Number(stat.atimeMs || 0));
        if (!touchedAt || now - touchedAt > ttl) {
          fs.unlinkSync(full);
        }
      } catch {}
    });
  } catch {}
}

function serveFileFromDisk(req, res, filePath, safeName, dispositionType = "attachment") {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("File missing");
    return;
  }

  const totalSize = Number(stat?.size || 0);
  const baseHeaders = {
    "content-type": contentTypeForName(safeName),
    "accept-ranges": "bytes",
    "content-disposition": `${dispositionType}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
  };

  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    res.writeHead(200, {
      ...baseHeaders,
      "content-length": 0
    });
    res.end();
    return;
  }

  const parsedRange = parseHttpRange(req.headers.range, totalSize);
  if (!parsedRange.ok) {
    res.writeHead(416, {
      ...baseHeaders,
      "content-range": `bytes */${totalSize}`
    });
    res.end();
    return;
  }

  const start = parsedRange.start;
  const end = parsedRange.end;
  const hasRange = parsedRange.hasRange;
  const headers = {
    ...baseHeaders,
    "content-length": hasRange ? Math.max(0, end - start + 1) : totalSize
  };
  if (hasRange) {
    headers["content-range"] = `bytes ${start}-${end}/${totalSize}`;
  }
  res.writeHead(hasRange ? 206 : 200, headers);

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const rs = fs.createReadStream(filePath, { start, end });
  rs.on("error", () => {
    try { res.end(); } catch {}
  });
  rs.pipe(res);
}

async function serveFileFromObjectStorage(req, res, objectKey, safeName, dispositionType = "attachment") {
  const key = String(objectKey || "").trim();
  if (!key || !objectStorage.isEnabled()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("File missing");
    return;
  }

  let meta = null;
  try {
    meta = await objectStorage.headObject(key);
  } catch {
    meta = null;
  }
  if (!meta) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("File missing");
    return;
  }

  const totalSize = Math.max(0, Number(meta.size || 0));
  const baseHeaders = {
    "content-type": meta.contentType || contentTypeForName(safeName),
    "accept-ranges": "bytes",
    "content-disposition": `${dispositionType}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
  };

  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    res.writeHead(200, {
      ...baseHeaders,
      "content-length": 0
    });
    res.end();
    return;
  }

  const parsedRange = parseHttpRange(req.headers.range, totalSize);
  if (!parsedRange.ok) {
    res.writeHead(416, {
      ...baseHeaders,
      "content-range": `bytes */${totalSize}`
    });
    res.end();
    return;
  }

  const start = parsedRange.start;
  const end = parsedRange.end;
  const hasRange = parsedRange.hasRange;
  const headers = {
    ...baseHeaders,
    "content-length": hasRange ? Math.max(0, end - start + 1) : totalSize
  };
  if (hasRange) {
    headers["content-range"] = `bytes ${start}-${end}/${totalSize}`;
  }
  res.writeHead(hasRange ? 206 : 200, headers);

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const remote = await objectStorage.getObjectStream(key, hasRange ? { range: { start, end } } : {});
  const body = remote?.body || null;
  if (!body) {
    try { res.end(); } catch {}
    return;
  }
  body.on("error", () => {
    try { res.end(); } catch {}
  });
  body.pipe(res);
}

async function ensureIntentStoredFilePath(intent = null) {
  if (!intent || typeof intent !== "object") return "";
  const storedObjectKey = String(intent.storedObjectKey || "").trim();
  if (storedObjectKey && objectStorage.isEnabled()) {
    const outputPath = resolveIntentObjectCachePath(intent);
    if (!outputPath) return "";
    let remoteMeta = null;
    try {
      remoteMeta = await objectStorage.headObject(storedObjectKey);
    } catch {
      remoteMeta = null;
    }
    if (!remoteMeta) return "";
    const expectedSize = Math.max(0, Number(remoteMeta.size || 0));
    let shouldDownload = true;
    try {
      const localStat = fs.statSync(outputPath);
      shouldDownload = Math.max(0, Number(localStat?.size || 0)) !== expectedSize;
    } catch {
      shouldDownload = true;
    }
    if (shouldDownload) {
      const cacheKey = String(outputPath || "").trim();
      let job = intentObjectCacheJobs.get(cacheKey);
      if (!job) {
        job = (async () => {
          let tmpPath = "";
          try {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          } catch {}
          try {
            tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            await objectStorage.downloadObjectToFile(storedObjectKey, tmpPath);
            try {
              if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch {}
            fs.renameSync(tmpPath, outputPath);
            return outputPath;
          } finally {
            if (tmpPath) {
              try {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
              } catch {}
            }
          }
        })().finally(() => {
          intentObjectCacheJobs.delete(cacheKey);
        });
        intentObjectCacheJobs.set(cacheKey, job);
      }
      try {
        await job;
      } catch {
        return "";
      }
      try {
        const localStat = fs.statSync(outputPath);
        if (Math.max(0, Number(localStat?.size || 0)) !== expectedSize) {
          return "";
        }
      } catch {
        return "";
      }
    }
    return outputPath;
  }
  const storedFile = String(intent.storedFile || "").trim();
  if (!storedFile) return "";
  const localPath = path.join(FILES_DIR, storedFile);
  return fs.existsSync(localPath) ? localPath : "";
}

async function serveStoredIntentDownload(req, res, intent = null, dispositionType = "attachment") {
  const safeName = safeBasename(String(intent?.fileName || "file"));
  const storedObjectKey = String(intent?.storedObjectKey || "").trim();
  if (storedObjectKey && objectStorage.isEnabled()) {
    await serveFileFromObjectStorage(req, res, storedObjectKey, safeName, dispositionType);
    return;
  }
  const storedFile = String(intent?.storedFile || "").trim();
  const filePath = storedFile ? path.join(FILES_DIR, storedFile) : "";
  serveFileFromDisk(req, res, filePath, safeName, dispositionType);
}

function extractZipEntryToPath(zipPath, entryPath, outputPath) {
  const normalizedEntry = normalizeZipPath(entryPath);
  if (!normalizedEntry) {
    const err = new Error("Entry not found");
    err.status = 404;
    return Promise.reject(err);
  }

  const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise(async (resolve, reject) => {
    let zipFile;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      try { if (zipFile) zipFile.close(); } catch {}
      if (err) reject(err);
      else resolve();
    };

    try {
      zipFile = await openZipFile(zipPath, { lazyEntries: true, autoClose: false });
    } catch (err) {
      finish(err || new Error("Could not open package"));
      return;
    }

    const fail = (message, status = 500) => {
      const err = message instanceof Error ? message : new Error(String(message || "Could not read package"));
      err.status = status;
      finish(err);
    };

    const onZipError = (err) => fail(err || new Error("Could not read package"), 500);
    const onZipEnd = () => fail("Entry not found", 404);

    zipFile.once("error", onZipError);
    zipFile.once("end", onZipEnd);
    zipFile.on("entry", (entry) => {
      const name = normalizeZipPath(entry?.fileName || "");
      if (name !== normalizedEntry) {
        zipFile.readEntry();
        return;
      }

      zipFile.removeListener("end", onZipEnd);
      if (/\/$/.test(name)) {
        fail("Entry not found", 404);
        return;
      }

      zipFile.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          fail(err || new Error("Could not extract file"), 500);
          return;
        }

        try {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        } catch (mkErr) {
          fail(mkErr || new Error("Could not prepare preview cache"), 500);
          return;
        }

        const ws = fs.createWriteStream(tmpPath, { flags: "w", mode: 0o644 });
        let done = false;
        const complete = (writeErr) => {
          if (done) return;
          done = true;
          try { stream.destroy(); } catch {}
          try { ws.destroy(); } catch {}
          if (writeErr) {
            fail(writeErr, 500);
            return;
          }
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch {}
          try {
            fs.renameSync(tmpPath, outputPath);
            finish(null);
          } catch (renameErr) {
            fail(renameErr || new Error("Could not cache preview"), 500);
          }
        };

        stream.on("error", (streamErr) => complete(streamErr));
        ws.on("error", (writeErr) => complete(writeErr));
        ws.on("finish", () => complete(null));
        stream.pipe(ws);
      });
    });

    zipFile.readEntry();
  });
}

async function ensureZipEntryExtracted(intentId, zipPath, entryPath, safeName) {
  const cachePath = buildPreviewEntryCachePath(intentId, entryPath, safeName);
  try {
    const stat = fs.statSync(cachePath);
    if (stat.isFile()) {
      touchFile(cachePath);
      return { cachePath, size: Number(stat.size || 0) };
    }
  } catch {}

  let job = previewExtractJobs.get(cachePath);
  if (!job) {
    job = extractZipEntryToPath(zipPath, entryPath, cachePath)
      .finally(() => previewExtractJobs.delete(cachePath));
    previewExtractJobs.set(cachePath, job);
  }
  await job;

  const stat = fs.statSync(cachePath);
  touchFile(cachePath);
  return { cachePath, size: Number(stat?.size || 0) };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/account/badge") {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      const unreadChats = countUnreadChatsForUser(username, user);
      const pendingRequests = countPendingRequestsForUser(username);
      const guestTransferRequests = listGuestTransferRequestsForUser(username).length;
      const total = Math.max(0, unreadChats + pendingRequests + guestTransferRequests);

      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        badge: {
          total,
          unreadChats,
          pendingRequests,
          guestTransferRequests
        }
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/account/push/register") {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req, 16 * 1024);
      } catch (err) {
        const status = Number(err?.status || 400);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: String(err?.message || "Invalid request body") }));
        return;
      }

      const deviceToken = normalizePushDeviceToken(body?.deviceToken || "");
      if (!deviceToken) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Missing or invalid device token" }));
        return;
      }

      const result = upsertUserPushDevice(username, {
        deviceToken,
        bundleId: String(body?.bundleId || APNS_TOPIC).trim() || APNS_TOPIC,
        environment: normalizePushEnvironment(body?.environment || (APNS_USE_SANDBOX ? "sandbox" : "production"))
      });
      const refreshed = loadUser(username);
      const devices = normalizePushDevices(refreshed?.pushDevices || []);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        apnsConfigured: APNS_ENABLED,
        registered: Boolean(result?.ok),
        deviceCount: devices.length
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/account/push/unregister") {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req, 16 * 1024);
      } catch {}
      const deviceToken = normalizePushDeviceToken(body?.deviceToken || "");
      if (!deviceToken) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Missing or invalid device token" }));
        return;
      }

      removeUserPushDevice(username, deviceToken);
      const refreshed = loadUser(username);
      const devices = normalizePushDevices(refreshed?.pushDevices || []);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        deviceCount: devices.length
      }));
      return;
    }

    const accountIntentUploadInitMatch = req.method === "POST"
      ? url.pathname.match(/^\/api\/intents\/([^/]+)\/object-upload\/init$/i)
      : null;
    if (accountIntentUploadInitMatch) {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }
      if (!objectStorage.isEnabled()) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, enabled: false }));
        return;
      }

      const intentId = String(accountIntentUploadInitMatch[1] || "").trim();
      const intent = loadIntent(intentId);
      if (!intent) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Intent not found" }));
        return;
      }
      if (intent.from !== username) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Not authorized" }));
        return;
      }
      if (intent.isTextOnly || String(intent.messageType || "").toLowerCase() === "text") {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Text intents do not need file upload" }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req, 64 * 1024);
      } catch (err) {
        const status = Number(err?.status || 400);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: String(err?.message || "Invalid request body") }));
        return;
      }

      const expectedBytes = Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0);
      if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Intent has invalid upload size" }));
        return;
      }

      const requestBytes = Math.max(0, Number(body?.size || 0));
      if (requestBytes > 0 && requestBytes !== expectedBytes) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Upload size does not match intent" }));
        return;
      }

      if (intent.stored && hasStoredAsset(intent) && String(intent.transferState || "") !== "uploading") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          enabled: true,
          intentId,
          alreadyStored: true,
          bytesExpected: expectedBytes,
          plainBytesExpected: Number(intent.fileSize || 0)
        }));
        return;
      }

      const safeName = safeBasename(String(body?.name || intent.fileName || "file"));
      const mime = contentTypeForName(safeName);
      const storedFileName = String(intent.storedFile || "").trim() || `${intentId}__${safeName}`;
      const objectKey = objectStorage.buildIntentObjectKey(intentId, storedFileName);
      const hintedUploadId = String(body?.uploadId || "").trim();
      let existingSession = normalizeObjectUploadSession(intent.objectUploadSession);
      let canReuseExisting = Boolean(
        existingSession &&
        String(intent.storedObjectKey || "").trim() &&
        existingSession.objectKey === String(intent.storedObjectKey || "").trim()
      );

      if (canReuseExisting && existingSession?.mode === "multipart" && hintedUploadId) {
        if (hintedUploadId !== String(existingSession.uploadId || "").trim()) {
          canReuseExisting = false;
        }
      }

      if (canReuseExisting && existingSession) {
        try {
          if (existingSession.mode === "multipart") {
            const listedParts = await objectStorage.listMultipartUploadParts(
              existingSession.objectKey,
              existingSession.uploadId
            ).catch((err) => {
              const msg = String(err?.message || "").toLowerCase();
              if (msg.includes("no such upload") || msg.includes("uploadid")) return null;
              throw err;
            });
            if (!listedParts) {
              canReuseExisting = false;
            } else {
              existingSession = mergeObjectMultipartPartsIntoSession(existingSession, listedParts);
            }
          } else {
            const head = await objectStorage.headObject(existingSession.objectKey).catch(() => null);
            const confirmed = Math.max(0, Number(head?.size || 0));
            existingSession.uploadedBytesConfirmed = Math.max(0, Math.min(expectedBytes, confirmed));
            existingSession.updatedAt = Date.now();
          }
        } catch {
          canReuseExisting = false;
        }
      }

      if (canReuseExisting && existingSession) {
        let uploadPlan = null;
        if (existingSession.mode === "multipart") {
          uploadPlan = {
            mode: "multipart",
            uploadId: existingSession.uploadId,
            partSize: existingSession.partSize,
            totalParts: Math.max(1, Number(existingSession.totalParts || 1)),
            maxConcurrency: Math.max(1, Number(existingSession.maxConcurrency || 1))
          };
        } else {
          const singleUploadPlan = await objectStorage.createUploadUrl(
            existingSession.objectKey,
            String(existingSession.contentType || mime || "application/octet-stream")
          );
          if (!singleUploadPlan?.url) {
            res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, message: "Could not create upload URL" }));
            return;
          }
          uploadPlan = {
            mode: "single",
            ...singleUploadPlan
          };
        }

        const statusPayload = buildIntentObjectUploadStatusPayload(intent, existingSession) || null;
        const confirmedBytes = Math.max(0, Number(statusPayload?.bytesUploadedConfirmed || 0));
        intent.stored = false;
        intent.storedFile = storedFileName;
        intent.storedObjectKey = existingSession.objectKey;
        intent.objectUploadSession = existingSession;
        intent.storedBytes = confirmedBytes;
        intent.plainStoredBytes = uploadBytesToPlainBytes(intent, confirmedBytes);
        intent.status = "uploading";
        intent.transferState = "uploading";
        intent.updatedAt = Date.now();
        saveIntent(intent);
        emitTransferState(intent, "uploading", {
          sentBytes: confirmedBytes,
          totalBytes: expectedBytes,
          plainSentBytes: intent.plainStoredBytes,
          plainTotalBytes: Number(intent.fileSize || 0)
        });

        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          enabled: true,
          resumed: true,
          intentId,
          upload: uploadPlan,
          status: statusPayload,
          bytesExpected: expectedBytes,
          plainBytesExpected: Number(intent.fileSize || 0),
          storedFile: storedFileName
        }));
        return;
      }

      await clearIntentObjectUploadSession(intent, { abortRemote: true });
      if (intent.storedObjectKey) {
        try { await objectStorage.deleteObject(intent.storedObjectKey); } catch {}
      }
      removeIntentCachedObjectFile(intent.id);

      const useMultipart = expectedBytes >= OBJECT_MULTIPART_THRESHOLD_BYTES;
      let uploadPlan = null;
      let objectUploadSession = null;
      if (useMultipart) {
        const maxPartSizeByCount = Math.max(
          5 * 1024 * 1024,
          Math.ceil(expectedBytes / OBJECT_MULTIPART_MAX_PARTS)
        );
        let tunedPartSize = OBJECT_MULTIPART_PART_SIZE_BYTES;
        if (expectedBytes >= 8 * 1024 * 1024 * 1024) {
          tunedPartSize = Math.max(tunedPartSize, 40 * 1024 * 1024);
        } else if (expectedBytes >= 4 * 1024 * 1024 * 1024) {
          tunedPartSize = Math.max(tunedPartSize, 36 * 1024 * 1024);
        } else if (expectedBytes >= 2 * 1024 * 1024 * 1024) {
          tunedPartSize = Math.max(tunedPartSize, 32 * 1024 * 1024);
        } else if (expectedBytes >= 1024 * 1024 * 1024) {
          tunedPartSize = Math.max(tunedPartSize, 24 * 1024 * 1024);
        } else if (expectedBytes >= 512 * 1024 * 1024) {
          tunedPartSize = Math.max(tunedPartSize, 20 * 1024 * 1024);
        } else if (expectedBytes >= 128 * 1024 * 1024) {
          tunedPartSize = Math.max(tunedPartSize, 16 * 1024 * 1024);
        } else if (expectedBytes >= 32 * 1024 * 1024) {
          tunedPartSize = Math.max(tunedPartSize, 10 * 1024 * 1024);
        }
        const partSize = Math.max(tunedPartSize, maxPartSizeByCount);
        const totalParts = Math.max(1, Math.ceil(expectedBytes / partSize));
        const recommendedConcurrency = expectedBytes >= 4 * 1024 * 1024 * 1024
          ? 10
          : (expectedBytes >= 2 * 1024 * 1024 * 1024
            ? 9
            : (expectedBytes >= 768 * 1024 * 1024
              ? 8
              : (expectedBytes >= 256 * 1024 * 1024
                ? 7
                : (expectedBytes >= 64 * 1024 * 1024 ? 6 : 5))));
        const maxConcurrency = Math.max(
          1,
          Math.min(OBJECT_MULTIPART_CLIENT_CONCURRENCY, recommendedConcurrency, totalParts)
        );
        const multipart = await objectStorage.createMultipartUpload(objectKey, mime);
        if (!multipart?.uploadId) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, message: "Could not initialize multipart upload" }));
          return;
        }
        objectUploadSession = {
          mode: "multipart",
          objectKey,
          uploadId: multipart.uploadId,
          contentType: mime,
          partSize,
          totalParts,
          maxConcurrency,
          uploadedBytesConfirmed: 0,
          completedPartsByNumber: {},
          finalizing: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        uploadPlan = {
          mode: "multipart",
          uploadId: multipart.uploadId,
          partSize,
          totalParts,
          maxConcurrency
        };
      } else {
        const singleUploadPlan = await objectStorage.createUploadUrl(objectKey, mime);
        if (!singleUploadPlan?.url) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, message: "Could not create upload URL" }));
          return;
        }
        objectUploadSession = {
          mode: "single",
          objectKey,
          contentType: mime,
          uploadedBytesConfirmed: 0,
          finalizing: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        uploadPlan = {
          mode: "single",
          ...singleUploadPlan
        };
      }

      intent.stored = false;
      intent.storedFile = storedFileName;
      intent.storedObjectKey = objectKey;
      intent.objectUploadSession = objectUploadSession;
      intent.storedBytes = 0;
      intent.plainStoredBytes = 0;
      intent.status = "uploading";
      intent.transferState = "uploading";
      intent.updatedAt = Date.now();
      saveIntent(intent);
      emitTransferState(intent, "uploading", {
        sentBytes: 0,
        totalBytes: expectedBytes,
        plainSentBytes: 0,
        plainTotalBytes: Number(intent.fileSize || 0)
      });

      const statusPayload = buildIntentObjectUploadStatusPayload(intent, objectUploadSession) || null;

      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        enabled: true,
        resumed: false,
        intentId,
        upload: uploadPlan,
        status: statusPayload,
        bytesExpected: expectedBytes,
        plainBytesExpected: Number(intent.fileSize || 0),
        storedFile: storedFileName
      }));
      return;
    }

    const accountIntentUploadPartMatch = req.method === "POST"
      ? url.pathname.match(/^\/api\/intents\/([^/]+)\/object-upload\/part$/i)
      : null;
    if (accountIntentUploadPartMatch) {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }
      if (!objectStorage.isEnabled()) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Object storage is not configured" }));
        return;
      }

      const intentId = String(accountIntentUploadPartMatch[1] || "").trim();
      const intent = loadIntent(intentId);
      if (!intent) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Intent not found" }));
        return;
      }
      if (intent.from !== username) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Not authorized" }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req, 64 * 1024);
      } catch (err) {
        const status = Number(err?.status || 400);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: String(err?.message || "Invalid request body") }));
        return;
      }

      const session = normalizeObjectUploadSession(intent.objectUploadSession);
      if (!session || session.mode !== "multipart") {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Multipart upload is not initialized" }));
        return;
      }
      const expectedUploadId = String(body?.uploadId || "").trim();
      if (expectedUploadId && expectedUploadId !== session.uploadId) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Upload session changed" }));
        return;
      }

      const partNumber = Math.max(1, Math.min(OBJECT_MULTIPART_MAX_PARTS, Number(body?.partNumber || 0)));
      if (!Number.isFinite(partNumber)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Invalid part number" }));
        return;
      }

      let partPlan = null;
      try {
        partPlan = await objectStorage.createMultipartUploadPartUrl(
          session.objectKey,
          session.uploadId,
          partNumber
        );
      } catch (err) {
        const msg = String(err?.message || "");
        const lowered = msg.toLowerCase();
        if (
          lowered.includes("no such upload") ||
          lowered.includes("uploadid") ||
          lowered.includes("invalidpart")
        ) {
          intent.objectUploadSession = null;
          saveIntent(intent);
          res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, message: "Upload session expired, retry send" }));
          return;
        }
        throw err;
      }
      if (!partPlan?.url) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Could not create part upload URL" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        intentId,
        uploadId: session.uploadId,
        partNumber,
        upload: partPlan
      }));
      return;
    }

    const accountIntentUploadStatusMatch = req.method === "POST"
      ? url.pathname.match(/^\/api\/intents\/([^/]+)\/object-upload\/status$/i)
      : null;
    if (accountIntentUploadStatusMatch) {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }
      if (!objectStorage.isEnabled()) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Object storage is not configured" }));
        return;
      }

      const intentId = String(accountIntentUploadStatusMatch[1] || "").trim();
      const intent = loadIntent(intentId);
      if (!intent) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Intent not found" }));
        return;
      }
      if (intent.from !== username) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Not authorized" }));
        return;
      }

      if (intent.stored && hasStoredAsset(intent) && String(intent.transferState || "").toLowerCase() !== "uploading") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          intentId: intent.id,
          finalized: true,
          alreadyStored: true,
          bytesExpected: Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0),
          bytesUploadedConfirmed: Number(intent.storedBytes || 0),
          plainBytesExpected: Number(intent.fileSize || 0),
          completedParts: [],
          canFinalize: false
        }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req, 64 * 1024);
      } catch (err) {
        const status = Number(err?.status || 400);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: String(err?.message || "Invalid request body") }));
        return;
      }

      let session = normalizeObjectUploadSession(intent.objectUploadSession);
      if (!session) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Upload session expired, retry send" }));
        return;
      }
      const expectedUploadId = String(body?.uploadId || "").trim();
      if (session.mode === "multipart" && expectedUploadId && expectedUploadId !== session.uploadId) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Upload session changed" }));
        return;
      }

      try {
        if (session.mode === "multipart") {
          const listedParts = await objectStorage.listMultipartUploadParts(session.objectKey, session.uploadId).catch((err) => {
            const msg = String(err?.message || "").toLowerCase();
            if (msg.includes("no such upload") || msg.includes("uploadid")) return null;
            throw err;
          });
          if (!listedParts) {
            intent.objectUploadSession = null;
            saveIntent(intent);
            res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, message: "Upload session expired, retry send" }));
            return;
          }
          session = mergeObjectMultipartPartsIntoSession(session, listedParts);
        } else {
          const head = await objectStorage.headObject(session.objectKey).catch(() => null);
          const expectedBytes = Math.max(0, Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0));
          session.uploadedBytesConfirmed = Math.max(
            0,
            Math.min(expectedBytes || Number.MAX_SAFE_INTEGER, Number(head?.size || 0))
          );
          session.updatedAt = Date.now();
        }

        intent.objectUploadSession = session;
        const confirmedBytes = Math.max(0, Number(session.uploadedBytesConfirmed || 0));
        const expectedBytes = Math.max(0, Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0));
        intent.storedBytes = confirmedBytes;
        intent.plainStoredBytes = uploadBytesToPlainBytes(intent, confirmedBytes);
        intent.status = "uploading";
        intent.transferState = "uploading";
        intent.updatedAt = Date.now();
        saveIntent(intent);

        const payload = buildIntentObjectUploadStatusPayload(intent, session) || { ok: false };
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ...payload,
          bytesExpected: expectedBytes,
          bytesUploadedConfirmed: Number(payload?.bytesUploadedConfirmed || confirmedBytes)
        }));
        return;
      } catch {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Could not load upload status" }));
        return;
      }
    }

    const accountIntentUploadCompleteMatch = req.method === "POST"
      ? url.pathname.match(/^\/api\/intents\/([^/]+)\/object-upload\/complete$/i)
      : null;
    if (accountIntentUploadCompleteMatch) {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }
      if (!objectStorage.isEnabled()) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Object storage is not configured" }));
        return;
      }

      const intentId = String(accountIntentUploadCompleteMatch[1] || "").trim();
      const intent = loadIntent(intentId);
      if (!intent) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Intent not found" }));
        return;
      }
      if (intent.from !== username) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Not authorized" }));
        return;
      }
      if (!intent.storedObjectKey) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Upload has not been initialized" }));
        return;
      }
      if (intent.stored && hasStoredAsset(intent) && String(intent.transferState || "").toLowerCase() !== "uploading") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          intentId: intent.id,
          storedFile: intent.storedFile || null,
          bytesStored: Number(intent.storedBytes || 0),
          deliveryHeld: isIntentDeliveryHeld(intent),
          alreadyStored: true
        }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req, 64 * 1024);
      } catch (err) {
        const status = Number(err?.status || 400);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: String(err?.message || "Invalid request body") }));
        return;
      }

      const expectedBytes = Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0);
      let session = normalizeObjectUploadSession(intent.objectUploadSession);
      if (!session) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Upload session expired, retry send" }));
        return;
      }
      if (session.finalizing) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Upload is already finalizing" }));
        return;
      }
      session.finalizing = true;
      session.updatedAt = Date.now();
      intent.objectUploadSession = session;
      saveIntent(intent);
      const clearFinalizing = () => {
        const latestIntent = loadIntent(intentId) || intent;
        const latestSession = normalizeObjectUploadSession(latestIntent.objectUploadSession);
        if (!latestSession) return;
        latestSession.finalizing = false;
        latestSession.updatedAt = Date.now();
        latestIntent.objectUploadSession = latestSession;
        latestIntent.updatedAt = Date.now();
        saveIntent(latestIntent);
      };

      let completionParts = [];
      try {
        if (session.mode === "multipart") {
          const bodyUploadId = String(body?.uploadId || "").trim();
          if (bodyUploadId && bodyUploadId !== session.uploadId) {
            clearFinalizing();
            res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, message: "Upload session changed" }));
            return;
          }
          const requestedParts = Array.isArray(body?.parts)
            ? body.parts
              .map((part) => ({
                partNumber: Math.max(1, Math.min(OBJECT_MULTIPART_MAX_PARTS, Number(part?.partNumber || part?.PartNumber || 0))),
                etag: String(part?.etag || part?.ETag || "").trim().replace(/"/g, ""),
                size: Math.max(0, Number(part?.size || part?.Size || 0))
              }))
              .filter((part) => Number.isFinite(part.partNumber))
              .sort((a, b) => a.partNumber - b.partNumber)
            : [];

          let listedParts = [];
          const needsLookup = !requestedParts.length || requestedParts.some((part) => !part.etag);
          if (needsLookup) {
            listedParts = await objectStorage.listMultipartUploadParts(session.objectKey, session.uploadId).catch(() => []);
          }

          const listedByPartNumber = new Map();
          listedParts.forEach((part) => {
            const number = Math.max(1, Math.min(OBJECT_MULTIPART_MAX_PARTS, Number(part?.PartNumber || part?.partNumber || 0)));
            const etag = String(part?.ETag || part?.etag || "").trim().replace(/"/g, "");
            if (!Number.isFinite(number) || !etag) return;
            listedByPartNumber.set(number, {
              etag,
              size: Math.max(0, Number(part?.Size || part?.size || 0))
            });
          });

          completionParts = requestedParts.length
            ? requestedParts
              .map((part) => {
                const listed = listedByPartNumber.get(part.partNumber) || null;
                return {
                  partNumber: part.partNumber,
                  etag: String(part.etag || listed?.etag || "").trim(),
                  size: Math.max(0, Number(part.size || listed?.size || 0))
                };
              })
              .filter((part) => Number.isFinite(part.partNumber) && part.etag)
              .sort((a, b) => a.partNumber - b.partNumber)
            : Array.from(listedByPartNumber.entries())
              .map(([partNumber, part]) => ({
                partNumber,
                etag: String(part?.etag || "").trim(),
                size: Math.max(0, Number(part?.size || 0))
              }))
              .filter((part) => Number.isFinite(part.partNumber) && part.etag)
              .sort((a, b) => a.partNumber - b.partNumber);

          if (!completionParts.length) {
            clearFinalizing();
            res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, message: "No uploaded multipart parts were found" }));
            return;
          }

          const knownPartBytes = completionParts.reduce((sum, part) => sum + Math.max(0, Number(part.size || 0)), 0);
          if (expectedBytes > 0 && knownPartBytes > 0 && knownPartBytes !== expectedBytes) {
            clearFinalizing();
            res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, message: "Uploaded multipart size does not match intent" }));
            return;
          }

          try {
            await objectStorage.completeMultipartUpload(
              session.objectKey,
              session.uploadId,
              completionParts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }))
            );
          } catch (err) {
            const msg = String(err?.message || "").toLowerCase();
            if (msg.includes("invalidpart") || msg.includes("invalid part") || msg.includes("no such upload")) {
              clearFinalizing();
              res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ ok: false, message: "Multipart upload could not be completed. Retry send." }));
              return;
            }
            throw err;
          }
          session = mergeObjectMultipartPartsIntoSession(session, completionParts);
          intent.objectUploadSession = session;
          saveIntent(intent);
        }

        const reportedBytes = Math.max(0, Number(body?.size || 0));
        let actualBytes = reportedBytes;
        if (actualBytes <= 0) {
          const head = await objectStorage.headObject(intent.storedObjectKey).catch(() => null);
          if (!head) {
            clearFinalizing();
            res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, message: "Uploaded file not found" }));
            return;
          }
          actualBytes = Math.max(0, Number(head.size || 0));
        }
        if (expectedBytes > 0 && actualBytes !== expectedBytes) {
          clearFinalizing();
          res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, message: "Uploaded file size does not match intent" }));
          return;
        }

        finalizeObjectUploadIntent(intent, actualBytes, expectedBytes || actualBytes);

        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          intentId: intent.id,
          storedFile: intent.storedFile || null,
          bytesStored: actualBytes,
          deliveryHeld: isIntentDeliveryHeld(intent)
        }));
        return;
      } catch (err) {
        const staleIntent = loadIntent(intentId) || intent;
        const staleSession = normalizeObjectUploadSession(staleIntent.objectUploadSession);
        if (staleSession) {
          staleSession.finalizing = false;
          staleSession.updatedAt = Date.now();
          staleIntent.objectUploadSession = staleSession;
          staleIntent.updatedAt = Date.now();
          saveIntent(staleIntent);
        }
        const msg = String(err?.message || "").toLowerCase();
        if (msg.includes("upload session changed") || msg.includes("expired")) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, message: "Upload session expired, retry send" }));
          return;
        }
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Could not finalize upload" }));
        return;
      }
    }

    const accountIntentCancelMatch = req.method === "POST"
      ? url.pathname.match(/^\/api\/intents\/([^/]+)\/cancel$/i)
      : null;
    if (accountIntentCancelMatch) {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      const intentId = String(accountIntentCancelMatch[1] || "").trim();
      const intent = loadIntent(intentId);
      if (!intent) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, intentId, status: "not_found", message: "Intent not found" }));
        return;
      }
      if (intent.from !== username) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Not authorized" }));
        return;
      }

      const transfer = activeTransfers.get(intentId) || null;
      const status = String(intent.status || "");
      const canCancel = Boolean(transfer) || status === "pending" || status === "uploading" || !intent.stored;
      if (!canCancel) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, intentId, status: "ignored", message: "Intent is already finalized" }));
        return;
      }

      if (transfer) {
        failActiveTransfer(intentId, "Upload canceled by sender", {
          notify: false,
          deleteIntent: false,
          suppressState: true
        });
      }

      const storedFileName = String(intent.storedFile || "").trim();
      if (storedFileName || intent.storedObjectKey) {
        deleteStoredAssetForIntent(intent);
      }
      emitTransferState(intent, "canceled", {
        sentBytes: Number(intent.storedBytes || 0),
        totalBytes: Number(resolveUploadExpectedBytes(intent) || 0),
        plainSentBytes: Number(intent.plainStoredBytes || 0),
        plainTotalBytes: Number(intent.fileSize || 0),
        retryable: false,
        message: "Canceled by sender"
      });
      deleteIntentAndNotify(intent);

      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, intentId, status: "canceled" }));
      return;
    }

    const accountIntentDeleteEveryoneMatch = req.method === "POST"
      ? url.pathname.match(/^\/api\/intents\/([^/]+)\/delete-everyone$/i)
      : null;
    if (accountIntentDeleteEveryoneMatch) {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      const intentId = String(accountIntentDeleteEveryoneMatch[1] || "").trim();
      const intent = loadIntent(intentId);
      if (!intent) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, intentId, status: "not_found", message: "Intent not found" }));
        return;
      }
      if (intent.from !== username && intent.to !== username) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Not authorized" }));
        return;
      }

      const transfer = activeTransfers.get(intentId) || null;
      if (transfer) {
        failActiveTransfer(intentId, "Deleted by user", {
          notify: false,
          deleteIntent: false,
          suppressState: true
        });
      }

      deleteStoredAssetForIntent(intent);
      deleteIntentAndNotify(intent);

      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, intentId, status: "deleted" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/file-holder/upload") {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      const rawNameHeader = req?.headers?.["x-merm-file-name"];
      const fileNameRaw = Array.isArray(rawNameHeader) ? rawNameHeader[0] : rawNameHeader;
      const decodedName = (() => {
        const value = String(fileNameRaw || "").trim();
        if (!value) return "";
        try { return decodeURIComponent(value); } catch { return value; }
      })();
      const safeName = safeBasename(decodedName || String(url.searchParams.get("name") || "").trim() || "file");
      if (!safeName) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Missing file name" }));
        return;
      }

      const rawMimeHeader = req?.headers?.["x-merm-file-mime"];
      const mimeHeader = Array.isArray(rawMimeHeader) ? rawMimeHeader[0] : rawMimeHeader;
      const mime = normalizeFileHolderMime(String(mimeHeader || "").trim(), safeName);
      const now = Date.now();
      const itemId = randomUUID();
      const ext = String(path.extname(safeName || "") || "").toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 12);
      const storedFile = `${now}-${itemId}${ext || ""}`;
      const outputPath = path.join(FILE_HOLDER_DIR, storedFile);
      const tempPath = objectStorage.isEnabled()
        ? path.join(os.tmpdir(), `merm-file-holder-${itemId}${ext || ""}`)
        : outputPath;

      try {
        const streamed = await streamRequestBodyToFile(req, tempPath, FILE_HOLDER_MAX_FILE_BYTES);
        let storedObjectKey = null;
        if (objectStorage.isEnabled()) {
          storedObjectKey = objectStorage.buildFileHolderObjectKey(username, itemId, safeName);
          await objectStorage.putFile(storedObjectKey, tempPath, mime);
          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        }
        const nextEntry = {
          id: itemId,
          storedFile,
          storedObjectKey,
          name: safeName,
          size: Math.max(0, Number(streamed?.bytes || 0)),
          mime,
          createdAt: now,
          updatedAt: now
        };
        const result = updateUserFileHolderState(username, (draft) => {
          draft.unshift(nextEntry);
          if (draft.length > FILE_HOLDER_MAX_ITEMS) {
            draft.length = FILE_HOLDER_MAX_ITEMS;
          }
          return true;
        });
        const state = result?.state || fileHolderStateForClient(user);
        const item = Array.isArray(state?.items)
          ? state.items.find((entry) => String(entry?.id || "") === itemId) || null
          : null;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          item,
          state
        }));
      } catch (err) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        if (objectStorage.isEnabled()) {
          try {
            const objectKey = objectStorage.buildFileHolderObjectKey(username, itemId, safeName);
            await objectStorage.deleteObject(objectKey);
          } catch {}
        }
        const status = Number(err?.status || 500);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: String(err?.message || "Upload failed") }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/file-holder/download/")) {
      setCors(res);
      const username = extractUsernameFromRequest(req, url);
      const sessionToken = extractSessionTokenFromRequest(req, url);
      const user = verifyAccountSession(username, sessionToken);
      if (!user) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      const itemIdRaw = String(url.pathname.split("/").pop() || "").trim();
      let itemId = itemIdRaw;
      try { itemId = decodeURIComponent(itemIdRaw); } catch {}
      itemId = String(itemId || "").trim();
      if (!itemId) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "Missing file id" }));
        return;
      }

      const entries = listFileHolderEntriesForUser(username);
      const item = entries.find((entry) => String(entry?.id || "") === itemId);
      if (!item) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "File not found" }));
        return;
      }
      const storedFile = safeBasename(String(item?.storedFile || "").trim());
      const storedObjectKey = String(item?.storedObjectKey || "").trim();
      const filePath = storedFile ? path.join(FILE_HOLDER_DIR, storedFile) : "";
      let missing = false;
      if (storedObjectKey && objectStorage.isEnabled()) {
        const head = await objectStorage.headObject(storedObjectKey).catch(() => null);
        missing = !head;
      } else {
        missing = !storedFile || !fs.existsSync(filePath);
      }
      if (missing) {
        updateUserFileHolderState(username, (draft) => {
          const next = draft.filter((entry) => String(entry?.id || "") !== itemId);
          if (next.length === draft.length) return false;
          draft.length = 0;
          next.forEach((entry) => draft.push(entry));
          return true;
        });
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, message: "File not found" }));
        return;
      }
      const dispositionType = String(url.searchParams.get("mode") || "").toLowerCase() === "inline" ? "inline" : "attachment";
      if (storedObjectKey && objectStorage.isEnabled()) {
        await serveFileFromObjectStorage(req, res, storedObjectKey, String(item?.name || "file"), dispositionType);
        return;
      }
      serveFileFromDisk(req, res, filePath, String(item?.name || "file"), dispositionType);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/guest-transfer/request") {
      setCors(res);
      if (!isGuestBridgeAuthorized(req)) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "Unauthorized" }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req, 64 * 1024);
      } catch (err) {
        const status = Number(err?.status || 400);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: String(err?.message || "Invalid request body") }));
        return;
      }

      const targetUsername = resolveGuestTransferTargetUsername(body);
      const queued = queueGuestTransferRequest({
        targetUsername,
        threadId: body?.threadId,
        code: body?.code,
        shareUrl: body?.shareUrl,
        threadName: body?.threadName,
        recipient: body?.recipient,
        fromGuestDisplayName: body?.fromGuestDisplayName,
        fromGuestSessionId: body?.fromGuestSessionId,
        createdAt: body?.createdAt,
        expiresAt: body?.expiresAt
      });

      if (!queued.ok) {
        const status = String(queued.error || "").toLowerCase().includes("not found") ? 404 : 400;
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: queued.error || "Could not create request" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        targetUsername: queued.targetUsername,
        requestId: queued.request?.id || "",
        expiresAt: Number(queued.request?.expiresAt || 0)
      }));
      return;
    }

    if (url.pathname.startsWith("/download-index/")) {
      setCors(res);
      const intentId = url.pathname.split("/")[2] || "";
      const token = url.searchParams.get("token") || "";
      if (!intentId || !token) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Missing intentId or token");
        return;
      }

      const intent = loadIntent(intentId);
      if (!intent || !hasStoredAsset(intent)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File not found");
        return;
      }

      if (intent.downloadToken !== token) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      if (!enforceIntentPasswordGate(req, res, url, intent)) {
        return;
      }

      const filePath = await ensureIntentStoredFilePath(intent);
      if (!filePath) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File missing");
        return;
      }
      let archiveStat;
      try {
        archiveStat = fs.statSync(filePath);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File missing");
        return;
      }

      const ext = String(path.extname(intent.fileName || "") || "").toLowerCase();
      if (ext !== ".zip" && ext !== ".folder") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Not a folder or zip package");
        return;
      }
      if (archiveStat.size > ARCHIVE_PREVIEW_MAX_BYTES) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        res.end("Preview is unavailable for very large folders. Download the folder instead.");
        return;
      }

      let entries = [];
      try {
        entries = await getArchiveIndexEntries(intentId, filePath, archiveStat);
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Could not read package");
        return;
      }
      queueIntentArchivePreviewWarmup(intent);

      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({ intentId, entries }));
      return;
    }

    if (url.pathname.startsWith("/download-entry/")) {
      setCors(res);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const intentId = pathParts[1] || "";
      const token = url.searchParams.get("token") || "";
      const rawEntryRef = String(url.searchParams.get("entry") || "");
      const rawEntryPathFromPath = pathParts.length > 2 ? pathParts.slice(2).join("/") : "";
      const rawEntryPath = String(rawEntryPathFromPath || url.searchParams.get("path") || "");
      const mode = String(url.searchParams.get("disposition") || "").toLowerCase();
      const dispositionType = mode === "inline" ? "inline" : "attachment";

      let entryPath = "";
      if (rawEntryRef) {
        try {
          entryPath = Buffer.from(rawEntryRef, "base64url").toString("utf8");
        } catch {
          try {
            const base64 = rawEntryRef.replace(/-/g, "+").replace(/_/g, "/");
            entryPath = Buffer.from(base64, "base64").toString("utf8");
          } catch {
            entryPath = "";
          }
        }
      } else {
        try {
          entryPath = decodeURIComponent(rawEntryPath);
        } catch {
          entryPath = rawEntryPath;
        }
      }
      entryPath = entryPath.replace(/\\/g, "/").replace(/^\/+/, "");
      const invalidEntryPath = !entryPath || entryPath.includes("..") || entryPath.includes("\0");
      if (!intentId || !token || invalidEntryPath) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Missing intentId, token or entry path");
        return;
      }

      const intent = loadIntent(intentId);
      if (!intent || !hasStoredAsset(intent)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File not found");
        return;
      }

      if (intent.downloadToken !== token) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      if (!enforceIntentPasswordGate(req, res, url, intent)) {
        return;
      }

      const filePath = await ensureIntentStoredFilePath(intent);
      if (!filePath) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File missing");
        return;
      }
      let archiveStat;
      try {
        archiveStat = fs.statSync(filePath);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File missing");
        return;
      }

      const ext = String(path.extname(intent.fileName || "") || "").toLowerCase();
      if (ext !== ".zip" && ext !== ".folder") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Not a folder or zip package");
        return;
      }
      if (archiveStat.size > ARCHIVE_PREVIEW_MAX_BYTES) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        res.end("Preview is unavailable for very large folders. Download the folder instead.");
        return;
      }

      const safeName = safeBasename(path.basename(entryPath) || "file");
      let extracted;
      try {
        extracted = await ensureZipEntryExtracted(intentId, filePath, entryPath, safeName);
      } catch (err) {
        const status = Number(err?.status || 500);
        const message = String(err?.message || "").trim();
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        if (status === 404) {
          res.end("Entry not found");
        } else {
          res.end(message || "Could not read package");
        }
        return;
      }

      if (!extracted?.cachePath || !fs.existsSync(extracted.cachePath)) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Could not read package");
        return;
      }

      maybeMarkIntentDownloadedFromRequest(intent, req, url, {
        dispositionType,
        source: "download-entry"
      });
      serveFileFromDisk(req, res, extracted.cachePath, safeName, dispositionType);
      return;
    }

    if (url.pathname.startsWith("/download/")) {
      setCors(res);
      const intentId = url.pathname.split("/")[2] || "";
      const token = url.searchParams.get("token") || "";
      if (!intentId || !token) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Missing intentId or token");
        return;
      }

      const intent = loadIntent(intentId);
      if (!intent || !hasStoredAsset(intent)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File not found");
        return;
      }

      if (intent.downloadToken !== token) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      if (!enforceIntentPasswordGate(req, res, url, intent)) {
        return;
      }

      const mode = String(url.searchParams.get("disposition") || "").toLowerCase();
      const dispositionType = mode === "inline" ? "inline" : "attachment";
      maybeMarkIntentDownloadedFromRequest(intent, req, url, {
        dispositionType,
        source: "download"
      });
      await serveStoredIntentDownload(req, res, intent, dispositionType);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Server error");
  }
});
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
});


const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");
const objectStorage = require("./object-storage");


// ✅ IMPORTANT: persistence across redeploys requires a durable disk.
// On Fly.io, mount a volume at /data (see fly.toml section below).
// Locally, this will still work (it will create ./p2p-storage next to server.js).
const DEFAULT_STORAGE_DIR =
  process.env.NODE_ENV === "production"
    ? "/data/p2p-storage"
    : path.join(__dirname, "p2p-storage");

const STORAGE_DIR = process.env.STORAGE_DIR || DEFAULT_STORAGE_DIR;


const INTENTS_DIR = path.join(STORAGE_DIR, "intents");
const FILES_DIR = path.join(STORAGE_DIR, "files");
const FILE_HOLDER_DIR = path.join(STORAGE_DIR, "file-holder");
const USERS_DIR = path.join(STORAGE_DIR, "users");
const GROUPS_DIR = path.join(STORAGE_DIR, "groups");
const PREVIEW_CACHE_DIR = path.join(STORAGE_DIR, "preview-cache");
const OBJECT_CACHE_DIR = path.join(STORAGE_DIR, "object-cache");
const GUEST_TRANSFER_REQUESTS_FILE = path.join(STORAGE_DIR, "guest-transfer-requests.json");

function storedAssetIdFromIntent(intent = null) {
  if (!intent || typeof intent !== "object") return "";
  const objectKey = String(intent.storedObjectKey || "").trim();
  if (objectKey) return `object:${objectKey}`;
  const storedFile = String(intent.storedFile || "").trim();
  if (storedFile) return `file:${storedFile}`;
  return "";
}

function hasStoredAsset(intent = null) {
  return Boolean(intent?.stored) && Boolean(storedAssetIdFromIntent(intent));
}

function resolveStoredAssetSize(intent = null) {
  const fromMeta = Math.max(
    0,
    Number(
      intent?.storedBytes ||
      intent?.uploadBytesExpected ||
      intent?.fileSize ||
      0
    )
  );
  if (fromMeta > 0) return fromMeta;
  const storedFile = String(intent?.storedFile || "").trim();
  if (!storedFile) return 0;
  try {
    const fullPath = path.join(FILES_DIR, storedFile);
    const stat = fs.statSync(fullPath);
    return Math.max(0, Number(stat?.size || 0));
  } catch {
    return 0;
  }
}

function resolveIntentObjectCachePath(intent = null) {
  const id = objectStorage.sanitizeKeySegment(String(intent?.id || "").trim());
  if (!id) return "";
  const ext = String(path.extname(String(intent?.fileName || "") || "") || "")
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 12);
  return path.join(OBJECT_CACHE_DIR, `${id}${ext || ""}`);
}

function removeIntentCachedObjectFile(intentId = "") {
  const safeId = objectStorage.sanitizeKeySegment(String(intentId || "").trim());
  if (!safeId) return;
  try {
    const entries = fs.readdirSync(OBJECT_CACHE_DIR);
    entries.forEach((name) => {
      if (!String(name || "").startsWith(safeId)) return;
      try { fs.unlinkSync(path.join(OBJECT_CACHE_DIR, name)); } catch {}
    });
  } catch {}
}

function normalizeObjectMultipartPartRows(raw = null) {
  const normalized = [];
  const pushPart = (partNumberRaw = 0, etagRaw = "", sizeRaw = 0, updatedAtRaw = 0) => {
    const partNumber = Math.max(1, Math.min(OBJECT_MULTIPART_MAX_PARTS, Number(partNumberRaw || 0)));
    const etag = String(etagRaw || "").trim().replace(/"/g, "");
    const size = Math.max(0, Number(sizeRaw || 0));
    if (!Number.isFinite(partNumber) || !etag) return;
    normalized.push({
      partNumber,
      etag,
      size,
      updatedAt: Math.max(0, Number(updatedAtRaw || 0)) || Date.now()
    });
  };

  if (Array.isArray(raw)) {
    raw.forEach((part) => {
      pushPart(
        part?.partNumber || part?.PartNumber || 0,
        part?.etag || part?.ETag || "",
        part?.size || part?.Size || 0,
        part?.updatedAt || 0
      );
    });
  } else if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([key, part]) => {
      pushPart(
        part?.partNumber || key,
        part?.etag || part?.ETag || "",
        part?.size || part?.Size || 0,
        part?.updatedAt || 0
      );
    });
  }

  normalized.sort((a, b) => a.partNumber - b.partNumber);
  const deduped = [];
  const seen = new Set();
  normalized.forEach((part) => {
    if (seen.has(part.partNumber)) return;
    seen.add(part.partNumber);
    deduped.push(part);
  });
  return deduped;
}

function objectMultipartPartRowsToMap(rows = []) {
  const map = {};
  normalizeObjectMultipartPartRows(rows).forEach((part) => {
    const key = String(part.partNumber || "");
    if (!key) return;
    map[key] = {
      partNumber: part.partNumber,
      etag: part.etag,
      size: part.size,
      updatedAt: part.updatedAt
    };
  });
  return map;
}

function objectMultipartPartRowsFromMap(raw = null) {
  return normalizeObjectMultipartPartRows(raw);
}

function objectUploadedBytesFromPartRows(rows = []) {
  return normalizeObjectMultipartPartRows(rows).reduce((sum, part) => sum + Math.max(0, Number(part?.size || 0)), 0);
}

function normalizeObjectUploadSession(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const mode = String(raw.mode || "").trim().toLowerCase();
  const objectKey = String(raw.objectKey || "").trim();
  if (!mode || !objectKey) return null;
  if (mode === "multipart") {
    const uploadId = String(raw.uploadId || "").trim();
    if (!uploadId) return null;
    return {
      mode,
      objectKey,
      uploadId,
      contentType: String(raw.contentType || "application/octet-stream").trim() || "application/octet-stream",
      partSize: Math.max(5 * 1024 * 1024, Number(raw.partSize || OBJECT_MULTIPART_PART_SIZE_BYTES)),
      totalParts: Math.max(1, Number(raw.totalParts || 1)),
      maxConcurrency: Math.max(1, Math.min(10, Number(raw.maxConcurrency || OBJECT_MULTIPART_CLIENT_CONCURRENCY || 4))),
      uploadedBytesConfirmed: Math.max(0, Number(raw.uploadedBytesConfirmed || 0)),
      completedPartsByNumber: objectMultipartPartRowsToMap(raw.completedPartsByNumber || raw.completedParts || {}),
      finalizing: Boolean(raw.finalizing),
      createdAt: Number(raw.createdAt || Date.now()) || Date.now(),
      updatedAt: Number(raw.updatedAt || Date.now()) || Date.now()
    };
  }
  if (mode === "single") {
    return {
      mode,
      objectKey,
      contentType: String(raw.contentType || "application/octet-stream").trim() || "application/octet-stream",
      uploadedBytesConfirmed: Math.max(0, Number(raw.uploadedBytesConfirmed || 0)),
      finalizing: Boolean(raw.finalizing),
      createdAt: Number(raw.createdAt || Date.now()) || Date.now(),
      updatedAt: Number(raw.updatedAt || Date.now()) || Date.now()
    };
  }
  return null;
}

function mergeObjectMultipartPartsIntoSession(uploadSession = null, parts = []) {
  const session = normalizeObjectUploadSession(uploadSession);
  if (!session || session.mode !== "multipart") return session;
  const mergedRows = objectMultipartPartRowsFromMap(session.completedPartsByNumber || {});
  const mergedByNumber = new Map();
  mergedRows.forEach((part) => {
    mergedByNumber.set(part.partNumber, {
      partNumber: part.partNumber,
      etag: part.etag,
      size: part.size,
      updatedAt: part.updatedAt
    });
  });
  normalizeObjectMultipartPartRows(parts).forEach((part) => {
    mergedByNumber.set(part.partNumber, {
      partNumber: part.partNumber,
      etag: part.etag,
      size: part.size,
      updatedAt: Date.now()
    });
  });
  const nextRows = Array.from(mergedByNumber.values()).sort((a, b) => a.partNumber - b.partNumber);
  session.completedPartsByNumber = objectMultipartPartRowsToMap(nextRows);
  session.uploadedBytesConfirmed = Math.max(0, objectUploadedBytesFromPartRows(nextRows));
  session.updatedAt = Date.now();
  return session;
}

function buildIntentObjectUploadStatusPayload(intent = null, uploadSession = null, options = {}) {
  if (!intent || typeof intent !== "object") return null;
  const session = normalizeObjectUploadSession(uploadSession);
  if (!session) return null;
  const expectedBytes = Math.max(0, Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0));
  const completedParts = normalizeObjectMultipartPartRows(options?.completedParts || session.completedPartsByNumber || []);
  const bytesUploadedConfirmedRaw = Number(
    options?.bytesUploadedConfirmed != null
      ? options.bytesUploadedConfirmed
      : (session.uploadedBytesConfirmed || objectUploadedBytesFromPartRows(completedParts))
  );
  const bytesUploadedConfirmed = Math.max(0, Math.min(expectedBytes || Number.MAX_SAFE_INTEGER, bytesUploadedConfirmedRaw));
  const canFinalize = expectedBytes > 0 && bytesUploadedConfirmed >= expectedBytes;
  return {
    ok: true,
    intentId: String(intent.id || "").trim(),
    mode: session.mode,
    uploadId: session.mode === "multipart" ? session.uploadId : "",
    partSize: session.mode === "multipart" ? session.partSize : 0,
    totalParts: session.mode === "multipart" ? Math.max(1, Number(session.totalParts || 1)) : 1,
    maxConcurrency: session.mode === "multipart" ? Math.max(1, Number(session.maxConcurrency || 1)) : 1,
    bytesExpected: expectedBytes,
    bytesUploadedConfirmed,
    plainBytesExpected: Number(intent.fileSize || 0),
    finalizing: Boolean(session.finalizing),
    finalized: Boolean(intent.stored && hasStoredAsset(intent) && String(intent.transferState || "").toLowerCase() !== "uploading"),
    canFinalize,
    completedParts
  };
}

async function clearIntentObjectUploadSession(intent = null, options = {}) {
  if (!intent || typeof intent !== "object") return;
  const session = normalizeObjectUploadSession(intent.objectUploadSession);
  intent.objectUploadSession = null;
  if (!session) return;
  if (!options?.abortRemote) return;
  if (!objectStorage.isEnabled()) return;
  if (session.mode !== "multipart") return;
  try {
    await objectStorage.abortMultipartUpload(session.objectKey, session.uploadId);
  } catch (err) {
    try { console.error("❌ Failed to abort multipart upload:", err); } catch {}
  }
}

function deleteStoredAssetForIntent(intent = null) {
  if (!intent || typeof intent !== "object") return;
  clearIntentObjectUploadSession(intent, { abortRemote: true }).catch(() => {});
  const objectKey = String(intent.storedObjectKey || "").trim();
  if (objectKey && objectStorage.isEnabled()) {
    objectStorage.deleteObject(objectKey).catch((err) => {
      try { console.error("❌ Failed to delete object storage asset:", err); } catch {}
    });
  }
  const storedFile = String(intent.storedFile || "").trim();
  if (storedFile) {
    try {
      const filePath = path.join(FILES_DIR, storedFile);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
  removeIntentCachedObjectFile(intent.id);
}

function collectStoredIntentAssets(limit = Infinity) {
  const rows = [];
  const seen = new Set();
  try {
    const files = fs.readdirSync(INTENTS_DIR).filter((name) => name.endsWith(".json"));
    for (const file of files) {
      let intent = null;
      try {
        intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
      } catch {
        intent = null;
      }
      if (!isFileIntent(intent)) continue;
      const assetId = storedAssetIdFromIntent(intent);
      if (!assetId || seen.has(assetId)) continue;
      seen.add(assetId);
      rows.push({
        assetId,
        storedFile: String(intent?.storedFile || "").trim() || null,
        storedObjectKey: String(intent?.storedObjectKey || "").trim() || null,
        name: String(intent?.fileName || intent?.storedFile || "file"),
        size: resolveStoredAssetSize(intent),
        intentId: String(intent?.id || "").trim() || null,
        from: String(intent?.from || "").trim() || null,
        to: String(intent?.to || "").trim() || null,
        createdAt: Number(intent?.createdAt || 0) || null,
        expiresAt: Number(intent?.expiresAt || 0) || null
      });
      if (rows.length >= limit) break;
    }
  } catch {}
  return rows;
}

function countUsers() {
  try {
    return fs.readdirSync(USERS_DIR).filter(f => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function listUsersAlphabetical() {
  try {
    return fs.readdirSync(USERS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.basename(f, ".json"))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch {
    return [];
  }
}

function buildStatsPayload(username = "") {
  return {
    totalUsers: countUsers(),
    onlineUsers: online.size,
    pendingRequests: countPendingRequestsForUser(username),
    storedFiles: countStoredFiles(),
    storageBytes: storageBytesUsed(),
    largestFiles: largestStoredFiles(100),
    allUsers: listUsersAlphabetical()
  };
}

function sendStatsSnapshot(ws = null) {
  if (!isAdminSocket(ws)) return;
  send(ws, {
    type: "stats",
    ...buildStatsPayload(ws.username)
  });
}



function mapStoredFilesToIntents() {
  const map = new Map();
  collectStoredIntentAssets().forEach((entry) => {
    const storedFile = String(entry?.storedFile || "").trim();
    if (!storedFile) return;
    map.set(storedFile, {
      id: entry.intentId,
      fileName: entry.name,
      from: entry.from,
      to: entry.to,
      createdAt: entry.createdAt,
      storedFile,
      storedObjectKey: entry.storedObjectKey
    });
  });
  return map;
}

function findIntentsByStoredFile(storedFile) {
  const target = String(storedFile || "").trim();
  if (!target) return [];
  const intents = [];
  try {
    const files = fs.readdirSync(INTENTS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
        if (intent?.storedFile === target) intents.push(intent);
      } catch {}
    }
  } catch {}
  return intents;
}

function deleteStoredFileAndNotify(storedFile) {
  const safeName = String(storedFile || "").trim();
  if (!safeName) return;

  const intents = findIntentsByStoredFile(safeName);
  intents.forEach((intent) => deleteIntentAndNotify(intent));
}

function deleteIntentAndNotify(intent) {
  if (!intent) return;
  deleteStoredAssetForIntent(intent);
  const intentFile = path.join(INTENTS_DIR, `${intent.id}.json`);
  try { if (fs.existsSync(intentFile)) fs.unlinkSync(intentFile); } catch {}
  invalidateIntentListCacheForIntent(intent);
  removePreviewCacheForIntent(intent.id);
  removeIntentCachedObjectFile(intent.id);
  archiveIndexCache.delete(String(intent.id || ""));
  clearArchiveIndexBuildJobsForIntent(intent.id);
  archivePreviewWarmupJobs.delete(String(intent.id || ""));
  const cachedObjectPath = resolveIntentObjectCachePath(intent);
  if (cachedObjectPath) {
    intentObjectCacheJobs.delete(cachedObjectPath);
  }

  const senderOnline = isUserOnline(intent.from);
  const receiverOnline = isUserOnline(intent.to);
  const suppressRecipientNotice = isIntentDeliveryHeld(intent);
  const payload = {
    type: "intent_deleted",
    intentId: intent.id,
    storedFile: intent.storedFile || null,
    from: intent.from,
    to: intent.to
  };
  if (!senderOnline) queueIntentDeletionForUser(intent.from, payload);
  if (!receiverOnline && !suppressRecipientNotice) queueIntentDeletionForUser(intent.to, payload);
  if (receiverOnline && !suppressRecipientNotice) sendToUser(intent.to, payload);
  if (senderOnline) sendToUser(intent.from, payload);
}

function cleanupExpiredIntents() {
  const now = Date.now();
  try {
    const files = fs.readdirSync(INTENTS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      let intent;
      try {
        intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
      } catch {
        continue;
      }
      const createdAt = Number(intent?.createdAt || 0);
      const expiresAt = Number(intent?.expiresAt || 0);
      const createdAtExpiry = createdAt > 0 ? createdAt + RETENTION_MS : 0;
      let effectiveExpiry = 0;
      if (expiresAt > 0 && createdAtExpiry > 0) {
        effectiveExpiry = Math.min(expiresAt, createdAtExpiry);
      } else {
        effectiveExpiry = Math.max(expiresAt, createdAtExpiry);
      }
      if (!effectiveExpiry) continue;
      if (now < effectiveExpiry) continue;

      deleteStoredAssetForIntent(intent);
      deleteIntentAndNotify(intent);
      try {
        const intentFile = path.join(INTENTS_DIR, `${intent.id}.json`);
        if (fs.existsSync(intentFile)) fs.unlinkSync(intentFile);
      } catch {}
    }
  } catch {}
}

function cleanupOrphanStoredFiles() {
  try {
    const inUse = new Set();
    const intentIds = new Set();
    const intents = fs.readdirSync(INTENTS_DIR).filter((f) => f.endsWith(".json"));
    intents.forEach((file) => {
      try {
        const intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
        const stored = String(intent?.storedFile || "").trim();
        if (stored) inUse.add(stored);
        const id = String(intent?.id || "").trim();
        if (id) intentIds.add(id);
      } catch {}
    });

    const files = fs.readdirSync(FILES_DIR);
    files.forEach((storedFile) => {
      if (inUse.has(storedFile)) return;
      try {
        fs.unlinkSync(path.join(FILES_DIR, storedFile));
      } catch {}
    });

    const cacheFiles = fs.readdirSync(PREVIEW_CACHE_DIR);
    cacheFiles.forEach((name) => {
      const idx = name.indexOf("--");
      const intentId = idx > 0 ? name.slice(0, idx) : "";
      if (!intentId || intentIds.has(intentId)) return;
      try {
        fs.unlinkSync(path.join(PREVIEW_CACHE_DIR, name));
      } catch {}
    });

    const objectCacheFiles = fs.readdirSync(OBJECT_CACHE_DIR);
    objectCacheFiles.forEach((name) => {
      const stem = String(name || "").split(".")[0] || "";
      if (!stem || intentIds.has(stem)) return;
      try {
        fs.unlinkSync(path.join(OBJECT_CACHE_DIR, name));
      } catch {}
    });
  } catch {}
}

function countStoredFiles() {
  return collectStoredIntentAssets().length;
}

function storageBytesUsed() {
  return collectStoredIntentAssets().reduce((sum, entry) => {
    return sum + Math.max(0, Number(entry?.size || 0));
  }, 0);
}

function largestStoredFiles(limit = 50) {
  try {
    const files = collectStoredIntentAssets().map((entry) => ({
      storedFile: entry.storedFile || (entry.storedObjectKey ? `obj:${entry.storedObjectKey}` : null),
      name: entry.name,
      size: Math.max(0, Number(entry.size || 0)),
      intentId: entry.intentId || null,
      from: entry.from || null,
      to: entry.to || null,
      createdAt: entry.createdAt || null
    }));
    files.sort((a, b) => b.size - a.size);
    return files.slice(0, limit);
  } catch {
    return [];
  }
}

function isFileIntent(intent) {
  if (!intent) return false;
  if (!hasStoredAsset(intent)) return false;
  if (intent.isTextOnly || intent.messageType === "text") return false;
  return true;
}

function resolveStoredFileSize(storedFile) {
  const safeName = String(storedFile || "").trim();
  if (!safeName) return null;
  const intent = findIntentsByStoredFile(safeName)[0] || null;
  if (intent) return resolveStoredAssetSize(intent);
  return null;
}

function buildUserStoragePayload(username) {
  const quotaBytes = USER_STORAGE_QUOTA_BYTES > 0 ? USER_STORAGE_QUOTA_BYTES : 5 * 1024 * 1024 * 1024;
  const sentFiles = [];
  let usedBytes = 0;
  let sentStoredFilesCount = 0;
  const countedStoredFiles = new Set();

  if (!username) {
    return {
      quotaBytes,
      usedBytes: 0,
      remainingBytes: quotaBytes,
      usedPercent: 0,
      sentFilesCount: 0,
      chatStoredFilesCount: 0,
      sentStoredFilesCount: 0,
      sentFiles: []
    };
  }

  try {
    const files = fs.readdirSync(INTENTS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      let intent;
      try {
        intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
      } catch {
        continue;
      }

      if (!isFileIntent(intent)) continue;

      const from = String(intent.from || "");
      if (from !== username) continue;
      if (intent?.isGroupRecipientCopy && intent.to !== username) continue;

      const assetId = storedAssetIdFromIntent(intent);
      if (!assetId) continue;
      const fileSizeOnDisk = resolveStoredAssetSize(intent);
      sentStoredFilesCount += 1;
      if (!countedStoredFiles.has(assetId)) {
        countedStoredFiles.add(assetId);
        usedBytes += fileSizeOnDisk;
      }
      sentFiles.push({
        storedFile: intent.storedFile,
        storedObjectKey: String(intent.storedObjectKey || "").trim() || null,
        name: intent.fileName || intent.storedFile,
        size: fileSizeOnDisk,
        intentId: intent.id || null,
        from: intent.from || null,
        to: intent.to || null,
        createdAt: intent.createdAt || null,
        expiresAt: intent.expiresAt || null
      });
    }
  } catch {}

  sentFiles.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });

  const sentFilesCount = sentFiles.length;
  const remainingBytes = Math.max(quotaBytes - usedBytes, 0);
  const usedPercentRaw = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;
  const usedPercent = Number.isFinite(usedPercentRaw)
    ? Math.max(0, Math.round(usedPercentRaw * 100) / 100)
    : 0;

  return {
    quotaBytes,
    usedBytes,
    remainingBytes,
    usedPercent,
    sentFilesCount,
    chatStoredFilesCount: sentStoredFilesCount,
    sentStoredFilesCount,
    sentFiles
  };
}

function countPendingRequestsForUser(username) {
  try {
    const u0 = loadUser(username);
    if (!u0) return 0;
    const u = ensureUserShape(u0);
    return (u.incomingRequests || []).length;
  } catch {
    return 0;
  }
}

function safeBasename(name) {
  // keep it simple & cross-platform safe
  return String(name || "file.bin")
    .replace(/[/\\]/g, "_")
    .replace(/[^\w.\-() ]+/g, "_")
    .trim();
}

function sanitizeIntentEncryption(raw = null, from = "", to = "") {
  if (!raw || typeof raw !== "object") return null;
  const mode = String(raw.mode || "").trim().toLowerCase();
  if (!["file", "text"].includes(mode)) return null;

  const version = Number(raw.v || raw.version || 1);
  if (!Number.isFinite(version) || version <= 0 || version > 3) return null;

  const alg = String(raw.alg || "AES-GCM").trim().slice(0, 40) || "AES-GCM";
  const out = { v: version, mode, alg };

  const keyWrap = raw.keyWrap && typeof raw.keyWrap === "object" ? raw.keyWrap : {};
  const wrapped = {};
  [from, to].forEach((username) => {
    const key = String(username || "").trim();
    if (!key) return;
    const value = String(keyWrap[key] || "").trim();
    if (!value || value.length > 8192) return;
    wrapped[key] = value;
  });
  if (!wrapped[from] || !wrapped[to]) return null;
  out.keyWrap = wrapped;

  if (mode === "file") {
    const chunkSize = Number(raw.chunkSize || 0);
    const tagBytes = Number(raw.tagBytes || 16);
    const plainSize = Number(raw.plainSize || 0);
    const ivSeed = String(raw.ivSeed || "").trim();
    if (!Number.isFinite(chunkSize) || chunkSize < 64 * 1024 || chunkSize > 8 * 1024 * 1024) return null;
    if (!Number.isFinite(tagBytes) || tagBytes < 8 || tagBytes > 32) return null;
    if (!Number.isFinite(plainSize) || plainSize <= 0) return null;
    if (!ivSeed || ivSeed.length > 200) return null;
    out.chunkSize = chunkSize;
    out.tagBytes = tagBytes;
    out.plainSize = plainSize;
    out.ivSeed = ivSeed;
  } else if (mode === "text") {
    const iv = String(raw.iv || "").trim();
    if (!iv || iv.length > 200) return null;
    out.iv = iv;
  }

  return out;
}

function normalizeUploadBytesExpected(raw = 0, fallback = 0) {
  const value = Number(raw || 0);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  const fb = Number(fallback || 0);
  if (Number.isFinite(fb) && fb > 0) return Math.floor(fb);
  return 0;
}

function sha256Hex(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function base64UrlEncodeBuffer(buffer) {
  if (!buffer) return "";
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToBuffer(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const padded = raw + "===".slice((raw.length + 3) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

function decodeBase64PayloadToBuffer(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(normalized, "base64");
  } catch {
    return null;
  }
}

function signIntentUnlockPayload(payloadBase64 = "") {
  return base64UrlEncodeBuffer(
    createHmac("sha256", INTENT_UNLOCK_SECRET).update(String(payloadBase64 || ""), "utf8").digest()
  );
}

function generateIntentUnlockToken(intent, mode = "once") {
  const intentId = String(intent?.id || "").trim();
  if (!intentId) return null;
  const now = Date.now();
  const normalizedMode = normalizeIntentPasswordMode(mode || getIntentPasswordMode(intent), "once");
  const ttlMs = normalizedMode === "always" ? INTENT_UNLOCK_TTL_ALWAYS_MS : INTENT_UNLOCK_TTL_ONCE_MS;
  const exp = now + ttlMs;
  const payloadObj = {
    v: 1,
    i: intentId,
    m: normalizedMode,
    exp
  };
  const payloadBase64 = base64UrlEncodeBuffer(Buffer.from(JSON.stringify(payloadObj), "utf8"));
  if (!payloadBase64) return null;
  const sig = signIntentUnlockPayload(payloadBase64);
  if (!sig) return null;
  return {
    token: `${payloadBase64}.${sig}`,
    exp,
    mode: normalizedMode
  };
}

function verifyIntentUnlockToken(intent, providedToken = "") {
  const raw = String(providedToken || "").trim();
  if (!raw) return { ok: false, status: 401, message: "Password required for this file" };
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot >= raw.length - 1) {
    return { ok: false, status: 403, message: "Invalid unlock token" };
  }
  const payloadBase64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expectedSig = signIntentUnlockPayload(payloadBase64);
  if (!expectedSig) return { ok: false, status: 403, message: "Invalid unlock token" };
  try {
    const sigBuf = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: false, status: 403, message: "Invalid unlock token" };
    }
  } catch {
    return { ok: false, status: 403, message: "Invalid unlock token" };
  }

  const payloadBuf = base64UrlDecodeToBuffer(payloadBase64);
  if (!payloadBuf) return { ok: false, status: 403, message: "Invalid unlock token" };
  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { ok: false, status: 403, message: "Invalid unlock token" };
  }

  const intentId = String(intent?.id || "").trim();
  const tokenIntentId = String(payload?.i || "").trim();
  const exp = Number(payload?.exp || 0);
  if (!tokenIntentId || tokenIntentId !== intentId) {
    return { ok: false, status: 403, message: "Invalid unlock token" };
  }
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    return { ok: false, status: 401, message: "Unlock token expired" };
  }
  return { ok: true, exp };
}

function sanitizeIntentExpiresAt(rawExpiresAt, now = Date.now()) {
  const raw = Number(rawExpiresAt || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const maxExpiry = now + RETENTION_MS;
  const minExpiry = now + MIN_INTENT_TTL_MS;
  const bounded = Math.min(maxExpiry, Math.max(minExpiry, Math.floor(raw)));
  return bounded;
}

function hasIntentCustomExpiry(intent = null) {
  if (!intent || typeof intent !== "object") return false;
  return intent.customExpiry === true;
}

function normalizeIntentPasswordMode(raw = "", fallback = "once") {
  const mode = String(raw || "").trim().toLowerCase();
  if (mode === "always") return "always";
  if (mode === "once") return "once";
  const fb = String(fallback || "").trim().toLowerCase();
  return fb === "always" ? "always" : "once";
}

function sanitizeIntentAccessControl(raw = null, isTextOnly = false) {
  if (!raw || typeof raw !== "object") return null;
  if (isTextOnly) return null;
  const type = String(raw.type || "").trim().toLowerCase();
  if (type !== "password") return null;

  const salt = String(raw.salt || "").trim().toLowerCase();
  const hash = String(raw.hash || "").trim().toLowerCase();
  const alg = String(raw.alg || "SHA-256").trim().toUpperCase();
  const unlockMode = normalizeIntentPasswordMode(raw.unlockMode || raw.passwordMode || "once", "once");
  if (alg !== "SHA-256") return null;
  if (!/^[0-9a-f]{16,128}$/.test(salt)) return null;
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;

  return {
    v: 1,
    type: "password",
    alg: "SHA-256",
    salt,
    hash,
    unlockMode
  };
}

function sanitizeIntentPasswordHint(raw = "", isTextOnly = false, accessControl = null) {
  if (isTextOnly) return "";
  if (String(accessControl?.type || "").toLowerCase() !== "password") return "";
  if (typeof raw !== "string") return "";
  return String(raw).trim().slice(0, 120);
}

function isIntentPasswordProtected(intent) {
  return String(intent?.accessControl?.type || "").toLowerCase() === "password";
}

function getIntentPasswordMode(intent) {
  if (!isIntentPasswordProtected(intent)) return "once";
  return normalizeIntentPasswordMode(intent?.accessControl?.unlockMode || "once", "once");
}

function extractIntentPasswordFromRequest(req, url) {
  const headerRaw = req?.headers?.["x-merm-password"];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (headerValue != null) {
    return String(headerValue);
  }
  const fromQuery = url?.searchParams?.get("pw");
  if (fromQuery != null) return String(fromQuery);
  return "";
}

function extractIntentUnlockFromRequest(req, url) {
  const headerRaw = req?.headers?.["x-merm-unlock"];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (headerValue != null) {
    return String(headerValue);
  }
  const fromQuery = url?.searchParams?.get("ut");
  if (fromQuery != null) return String(fromQuery);
  return "";
}

function extractIntentSenderSessionTokenFromRequest(req, url) {
  const headerRaw = req?.headers?.["x-merm-session"];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (headerValue != null) {
    return String(headerValue || "").trim();
  }
  const fromQuery = url?.searchParams?.get("st");
  if (fromQuery != null) return String(fromQuery || "").trim();
  return "";
}

function isIntentSenderBypassAuthorized(intent, sessionToken = "") {
  if (!isIntentPasswordProtected(intent)) return false;
  const token = String(sessionToken || "").trim();
  if (!token) return false;
  const senderUsername = String(intent?.from || "").trim();
  if (!senderUsername) return false;
  const senderUser = loadUser(senderUsername);
  if (!senderUser || !Array.isArray(senderUser.sessionTokens)) return false;
  return senderUser.sessionTokens.includes(token);
}

function verifyIntentPassword(intent, providedPassword = "") {
  if (!isIntentPasswordProtected(intent)) {
    return { ok: true };
  }

  const password = String(providedPassword || "");
  if (!password) {
    return { ok: false, status: 401, message: "Password required for this file" };
  }

  const salt = String(intent?.accessControl?.salt || "").trim().toLowerCase();
  const expectedHash = String(intent?.accessControl?.hash || "").trim().toLowerCase();
  if (!salt || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return { ok: false, status: 403, message: "Invalid access protection state" };
  }

  const actualHash = sha256Hex(`${salt}:${password}`);
  try {
    const expectedBuf = Buffer.from(expectedHash, "hex");
    const actualBuf = Buffer.from(actualHash, "hex");
    if (expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)) {
      return { ok: true };
    }
  } catch {}
  return { ok: false, status: 403, message: "Incorrect password" };
}

function enforceIntentPasswordGate(req, res, url, intent) {
  if (!isIntentPasswordProtected(intent)) return true;

  const senderSessionToken = extractIntentSenderSessionTokenFromRequest(req, url);
  if (isIntentSenderBypassAuthorized(intent, senderSessionToken)) {
    const minted = generateIntentUnlockToken(intent, getIntentPasswordMode(intent));
    if (minted?.token) {
      res.setHeader("X-Merm-Unlock", minted.token);
      res.setHeader("X-Merm-Unlock-Exp", String(Number(minted.exp || 0)));
    }
    return true;
  }

  const unlockToken = extractIntentUnlockFromRequest(req, url);
  if (unlockToken) {
    const unlockCheck = verifyIntentUnlockToken(intent, unlockToken);
    if (unlockCheck.ok) return true;
  }

  const check = verifyIntentPassword(intent, extractIntentPasswordFromRequest(req, url));
  if (check.ok) {
    const minted = generateIntentUnlockToken(intent, getIntentPasswordMode(intent));
    if (minted?.token) {
      res.setHeader("X-Merm-Unlock", minted.token);
      res.setHeader("X-Merm-Unlock-Exp", String(Number(minted.exp || 0)));
    }
    return true;
  }
  res.writeHead(Number(check.status || 403), { "content-type": "text/plain; charset=utf-8" });
  res.end(String(check.message || "Forbidden"));
  return false;
}


fs.mkdirSync(INTENTS_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(FILE_HOLDER_DIR, { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });
fs.mkdirSync(GROUPS_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
fs.mkdirSync(OBJECT_CACHE_DIR, { recursive: true });


function saveIntent(intent) {
  const file = path.join(INTENTS_DIR, `${intent.id}.json`);
  fs.writeFileSync(file, JSON.stringify(intent, null, 2));
  invalidateIntentListCacheForIntent(intent);
}

function intentForClient(rawIntent) {
  if (!rawIntent || typeof rawIntent !== "object") return null;
  const intent = { ...rawIntent };
  delete intent.accessControl;
  intent.passwordProtected = isIntentPasswordProtected(rawIntent);
  if (intent.passwordProtected) {
    intent.passwordMode = getIntentPasswordMode(rawIntent);
  } else {
    intent.passwordMode = "once";
  }
  intent.customExpiry = hasIntentCustomExpiry(rawIntent);
  return intent;
}

function loadIntent(intentId) {
  try {
    const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
    if (!fs.existsSync(intentFile)) return null;
    const intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
    if (intent && !intent.downloadToken) {
      intent.downloadToken = generateDownloadToken();
      saveIntent(intent);
    }
    return intent;
  } catch {
    return null;
  }
}

function isIntentDeliveryHeld(intent = null) {
  if (!intent || typeof intent !== "object") return false;
  const isText = Boolean(intent.isTextOnly || String(intent.messageType || "").toLowerCase() === "text");
  if (isText) return false;
  const silent = Boolean(intent.silentPreupload || intent.deliveryHold);
  if (!silent) return false;
  const releasedAt = Number(intent.releasedAt || 0);
  return !(Number.isFinite(releasedAt) && releasedAt > 0);
}

function markIntentReleased(intent = null, releasedAt = Date.now()) {
  if (!intent || typeof intent !== "object") return false;
  const ts = Number(releasedAt || Date.now()) || Date.now();
  intent.silentPreupload = false;
  intent.deliveryHold = false;
  intent.releasedAt = ts;
  intent.updatedAt = ts;
  return true;
}

function buildPushPayloadForIntent(intentRecord = {}) {
  const senderUsername = String(intentRecord?.from || "").trim();
  const senderLabel = userDisplayName(senderUsername) || senderUsername || "New message";
  const isTextMessage = Boolean(
    intentRecord?.isTextOnly ||
    String(intentRecord?.messageType || "").toLowerCase() === "text"
  );
  const previewText = String(intentRecord?.plainText || intentRecord?.text || "")
    .trim()
    .replace(/\s+/g, " ");
  const fileLabel = String(intentRecord?.fileName || "").trim();
  const body = isTextMessage
    ? (previewText || "New message")
    : (fileLabel ? `Sent ${fileLabel}` : "Sent a file");
  return {
    title: senderLabel,
    body: body.slice(0, 220),
    intentId: String(intentRecord?.id || "").trim(),
    chatKey: String(intentRecord?.groupId || "").trim()
      ? groupChatKey(intentRecord.groupId)
      : senderUsername,
    sender: senderUsername,
    groupId: String(intentRecord?.groupId || "").trim()
  };
}

function generateSessionToken() {
  return randomUUID() + randomUUID();
}

function invalidateIntentListCacheForUser(username) {
  const key = String(username || "").trim();
  if (!key) return;
  intentListCacheByUser.delete(key);
}

function invalidateIntentListCacheForIntent(intent) {
  if (!intent) return;
  invalidateIntentListCacheForUser(intent.from);
  invalidateIntentListCacheForUser(intent.to);
}

function loadIntentsForUser(username) {
  const key = String(username || "").trim();
  if (!key) return [];

  const now = Date.now();
  const cached = intentListCacheByUser.get(key);
  if (cached && now - Number(cached.ts || 0) < INTENT_LIST_CACHE_TTL_MS) {
    return Array.isArray(cached.items) ? cached.items : [];
  }

  const intents = [];
  for (const file of fs.readdirSync(INTENTS_DIR)) {
    let intent;
    try {
      intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const isParticipant = intent.to === key || intent.from === key;
    if (!isParticipant) continue;
    if (intent?.isGroupRecipientCopy && intent.from === key && intent.to !== key) continue;
    if (isIntentDeliveryHeld(intent)) continue;
    if (!intent.downloadToken && !(intent.isTextOnly || intent.messageType === "text")) {
        intent.downloadToken = generateDownloadToken();
        const intentFile = path.join(INTENTS_DIR, `${intent.id}.json`);
        try {
          fs.writeFileSync(intentFile, JSON.stringify(intent, null, 2));
        } catch {}
    }
    if (!intent.transferState) {
      if (intent.readByRecipientAt) intent.transferState = "read";
      else if (intent.stored) intent.transferState = "delivered";
      else if (String(intent.status || "") === "uploading") intent.transferState = "uploading";
      else intent.transferState = "queued";
    }
    intent.passwordProtected = isIntentPasswordProtected(intent);
    if (intent.stored && !Number.isFinite(Number(intent.storedBytes || 0))) {
      intent.storedBytes = resolveUploadExpectedBytes(intent) || Number(intent.fileSize || 0) || 0;
    }
    if (Number(intent.storedBytes || 0) > 0 && !Number.isFinite(Number(intent.plainStoredBytes || 0))) {
      intent.plainStoredBytes = uploadBytesToPlainBytes(intent, Number(intent.storedBytes || 0));
    }
    // Return full message timeline for this account (sent + received)
    const safeIntent = intentForClient(intent);
    if (safeIntent) intents.push(safeIntent);
  }
  intents.sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0));
  intentListCacheByUser.set(key, {
    ts: now,
    items: intents
  });
  return intents;
}

function findIntentByClientId(sender, clientIntentId, expectedGroupId = "") {
  if (!clientIntentId) return null;
  const groupId = String(expectedGroupId || "").trim();
  try {
    const files = fs.readdirSync(INTENTS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
        if (intent?.from === sender && intent?.clientIntentId === clientIntentId) {
          const intentGroupId = String(intent?.groupId || "").trim();
          if (groupId && intentGroupId !== groupId) continue;
          if (!groupId && intentGroupId) continue;
          if (groupId && intent?.isGroupRecipientCopy && intent.to !== sender) continue;
          return intent;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function normalizeIntentIdList(values, max = 300) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}




function send(ws, obj) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.error("❌ send() failed:", e);
    return false;
  }
}

function resolveIntentEncryptionMeta(intent) {
  const enc = intent?.encryption;
  if (!enc || typeof enc !== "object") return null;
  const mode = String(enc.mode || "").toLowerCase();
  if (mode !== "file") return null;
  const chunkSize = Number(enc.chunkSize || 0);
  const tagBytes = Number(enc.tagBytes || 16);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) return null;
  if (!Number.isFinite(tagBytes) || tagBytes < 0 || tagBytes > 64) return null;
  return {
    chunkSize,
    tagBytes,
    plainSize: Number(enc.plainSize || intent?.fileSize || 0)
  };
}

function resolveUploadExpectedBytes(intent) {
  const uploadSize = Number(intent?.uploadBytesExpected || 0);
  if (Number.isFinite(uploadSize) && uploadSize > 0) return uploadSize;
  const fileSize = Number(intent?.fileSize || 0);
  if (Number.isFinite(fileSize) && fileSize > 0) return fileSize;
  return 0;
}

function resolveEncryptedChunkStride(intent) {
  const enc = resolveIntentEncryptionMeta(intent);
  if (!enc) return 0;
  return enc.chunkSize + enc.tagBytes;
}

function alignResumeOffset(intent, uploadBytes) {
  const raw = Math.max(0, Number(uploadBytes || 0));
  const stride = resolveEncryptedChunkStride(intent);
  if (!stride) return raw;
  return Math.floor(raw / stride) * stride;
}

function uploadBytesToPlainBytes(intent, uploadBytes) {
  const bytes = Math.max(0, Number(uploadBytes || 0));
  const enc = resolveIntentEncryptionMeta(intent);
  if (!enc) return bytes;

  const stride = enc.chunkSize + enc.tagBytes;
  if (!stride) return bytes;

  const fullCipherChunks = Math.floor(bytes / stride);
  const remCipher = bytes % stride;
  let plain = fullCipherChunks * enc.chunkSize;
  if (remCipher > enc.tagBytes) {
    plain += remCipher - enc.tagBytes;
  }
  const plainSize = Number(enc.plainSize || intent?.fileSize || 0);
  if (Number.isFinite(plainSize) && plainSize > 0) {
    plain = Math.min(plain, plainSize);
  }
  return Math.max(0, plain);
}

function emitTransferState(intent, state, extra = {}) {
  if (!intent || !intent.id) return;
  const deliveryHeld = isIntentDeliveryHeld(intent);
  const normalizedState = String(state || "").trim() || "queued";
  const payload = {
    type: "transfer_state",
    intentId: intent.id,
    from: intent.from,
    to: intent.to,
    groupId: String(intent.groupId || ""),
    state: normalizedState,
    at: Date.now(),
    deliveryHeld,
    sentBytes: Number(extra.sentBytes || 0),
    totalBytes: Number(extra.totalBytes || resolveUploadExpectedBytes(intent) || 0),
    plainSentBytes: Number(
      Number.isFinite(extra.plainSentBytes)
        ? extra.plainSentBytes
        : uploadBytesToPlainBytes(intent, Number(extra.sentBytes || 0))
    ),
    plainTotalBytes: Number(
      Number.isFinite(extra.plainTotalBytes)
        ? extra.plainTotalBytes
        : (Number(intent.fileSize || 0) || uploadBytesToPlainBytes(intent, resolveUploadExpectedBytes(intent)))
    ),
    retryable: Boolean(extra.retryable),
    message: String(extra.message || "")
  };
  if (intent?.from) sendToUser(intent.from, payload);
  if (intent?.to && !deliveryHeld) sendToUser(intent.to, payload);
}

function updateIntentUploadCheckpoint(intent, sentBytes, options = {}) {
  if (!intent || !intent.id) return;
  const uploadSent = Math.max(0, Number(sentBytes || 0));
  const total = resolveUploadExpectedBytes(intent);
  const plainSent = uploadBytesToPlainBytes(intent, uploadSent);
  intent.stored = false;
  intent.storedBytes = uploadSent;
  intent.plainStoredBytes = plainSent;
  intent.uploadBytesExpected = total || Number(intent.uploadBytesExpected || 0) || Number(intent.fileSize || 0) || 0;
  intent.status = String(options.status || intent.status || "uploading");
  intent.transferState = String(options.transferState || intent.transferState || "uploading");
  intent.updatedAt = Date.now();
  try { saveIntent(intent); } catch {}
}

function finalizeObjectUploadIntent(intent, actualBytes, expectedBytes = 0) {
  if (!intent || !intent.id) return false;
  const bytesStored = Math.max(0, Number(actualBytes || 0));
  const totalBytes = Math.max(0, Number(expectedBytes || resolveUploadExpectedBytes(intent) || bytesStored || 0));
  if (intent.stored && String(intent.transferState || "").toLowerCase() === "delivered") {
    return true;
  }
  intent.status = "stored";
  intent.transferState = "delivered";
  intent.stored = true;
  intent.objectUploadSession = null;
  intent.storedBytes = bytesStored;
  intent.plainStoredBytes = uploadBytesToPlainBytes(intent, bytesStored);
  intent.uploadedAt = Date.now();
  intent.updatedAt = intent.uploadedAt;
  saveIntent(intent);
  emitTransferState(intent, "delivered", {
    sentBytes: bytesStored,
    totalBytes: totalBytes || bytesStored,
    plainSentBytes: intent.plainStoredBytes,
    plainTotalBytes: Number(intent.fileSize || 0)
  });
  if (intent.groupId) {
    finalizeGroupRecipientCopies(intent, {
      storedBytes: bytesStored,
      totalBytes: totalBytes || bytesStored,
      uploadedAt: intent.uploadedAt
    });
  }
  sendToUser(intent.from, {
    type: "upload_done",
    intentId: intent.id,
    deliveryHeld: isIntentDeliveryHeld(intent)
  });
  queueIntentArchivePreviewWarmup(intent);
  return true;
}

function tryStoreInlineTinyIntentPayload(intent, payloadBase64 = "", options = {}) {
  if (!intent || !intent.id) {
    return { ok: false, reason: "missing_intent" };
  }
  const expectedBytes = Math.max(0, Number(options.expectedBytes || resolveUploadExpectedBytes(intent) || intent.fileSize || 0));
  const hintedBytes = Math.max(0, Number(options.hintedBytes || 0));
  const payload = String(payloadBase64 || "").trim();
  if (!payload) {
    return { ok: false, reason: "missing_payload" };
  }
  const bytes = decodeBase64PayloadToBuffer(payload);
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (bytes.length > INLINE_TINY_INTENT_MAX_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      actualBytes: bytes.length,
      maxBytes: INLINE_TINY_INTENT_MAX_BYTES
    };
  }
  if (expectedBytes > 0 && bytes.length !== expectedBytes) {
    return {
      ok: false,
      reason: "size_mismatch",
      expectedBytes,
      actualBytes: bytes.length
    };
  }
  if (hintedBytes > 0 && hintedBytes !== bytes.length) {
    return {
      ok: false,
      reason: "hint_mismatch",
      expectedBytes: hintedBytes,
      actualBytes: bytes.length
    };
  }

  const safeName = safeBasename(String(intent.fileName || "file"));
  const storedFileName = `${intent.id}_${Date.now()}_${safeName}`;
  const localFilePath = path.join(FILES_DIR, storedFileName);
  try {
    fs.writeFileSync(localFilePath, bytes);
  } catch (err) {
    return { ok: false, reason: "write_failed", error: err };
  }

  const now = Date.now();
  const bytesStored = bytes.length;
  intent.stored = true;
  intent.storedFile = storedFileName;
  intent.storedObjectKey = null;
  intent.objectUploadSession = null;
  intent.storedBytes = bytesStored;
  intent.plainStoredBytes = uploadBytesToPlainBytes(intent, bytesStored);
  intent.uploadBytesExpected = Math.max(expectedBytes, bytesStored);
  intent.status = "stored";
  intent.transferState = "delivered";
  intent.uploadedAt = now;
  intent.completedAt = now;
  intent.updatedAt = now;

  return {
    ok: true,
    bytesStored,
    safeName,
    localFilePath,
    payload: bytes
  };
}

function queueInlineStoredIntentOffload(intentId = "", payloadBuffer = null, options = {}) {
  if (!objectStorage.isEnabled()) return;
  const id = String(intentId || "").trim();
  if (!id) return;
  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : null;
  if (!payload || !payload.length) return;
  const safeName = safeBasename(String(options.safeName || "file"));
  const localFilePath = String(options.localFilePath || "").trim();

  setImmediate(async () => {
    try {
      const latest = loadIntent(id);
      if (!latest) return;
      const objectKey = String(latest.storedObjectKey || "").trim() || objectStorage.buildIntentObjectKey(id, safeName);
      await objectStorage.putBuffer(objectKey, payload, contentTypeForName(safeName));
      latest.storedObjectKey = objectKey;
      saveIntent(latest);

      if (latest.groupId) {
        const mirrorIds = Array.isArray(latest.groupMirrorIntentIds) ? latest.groupMirrorIntentIds : [];
        mirrorIds.forEach((mirrorId) => {
          const mirror = loadIntent(String(mirrorId || "").trim());
          if (!mirror) return;
          mirror.storedObjectKey = objectKey;
          saveIntent(mirror);
        });
      }

      if (localFilePath && fs.existsSync(localFilePath)) {
        try { fs.unlinkSync(localFilePath); } catch {}
      }
    } catch (err) {
      console.error("❌ Failed to offload inline tiny upload:", err);
    }
  });
}

function maybeSendUploadProgress(t) {
  if (!t || !t.intent || !t.intent.to) return;
  const now = Date.now();
  if (!t.lastProgressTs) t.lastProgressTs = 0;
  if (!t.lastProgressBytes) t.lastProgressBytes = 0;
  if (!t.lastCheckpointTs) t.lastCheckpointTs = 0;

  const shouldSend =
    now - t.lastProgressTs > 450 ||
    t.bytesSent === t.bytesExpected ||
    t.bytesSent - t.lastProgressBytes > 8 * 1024 * 1024;

  if (!shouldSend) return;

  t.lastProgressTs = now;
  t.lastProgressBytes = t.bytesSent;
  const totalBytes = Number(t.bytesExpected || resolveUploadExpectedBytes(t.intent) || 0);
  const plainSentBytes = uploadBytesToPlainBytes(t.intent, t.bytesSent);
  const plainTotalBytes = Number(t.intent?.fileSize || 0) || uploadBytesToPlainBytes(t.intent, totalBytes);

  if (!isIntentDeliveryHeld(t.intent) && isUserOnline(t.intent.to)) {
    sendToUser(t.intent.to, {
      type: "incoming_progress",
      intentId: t.intent.id,
      bytesSent: plainSentBytes,
      bytesExpected: plainTotalBytes || Number(t.intent?.fileSize || 0) || 0
    });
  }

  emitTransferState(t.intent, "uploading", {
    sentBytes: t.bytesSent,
    totalBytes,
    plainSentBytes,
    plainTotalBytes
  });

  const checkpointDueByBytes = !t.lastCheckpointBytes || (t.bytesSent - t.lastCheckpointBytes) >= UPLOAD_CHECKPOINT_EVERY_BYTES;
  const checkpointDueByTime = now - t.lastCheckpointTs >= UPLOAD_CHECKPOINT_MIN_INTERVAL_MS;
  if ((checkpointDueByBytes && checkpointDueByTime) || t.bytesSent === totalBytes) {
    t.lastCheckpointBytes = t.bytesSent;
    t.lastCheckpointTs = now;
    updateIntentUploadCheckpoint(t.intent, t.bytesSent, {
      status: "uploading",
      transferState: "uploading"
    });
  }
}

function pauseWsInbound(ws) {
  const sock = ws?._socket;
  if (sock && typeof sock.pause === "function") {
    try { sock.pause(); } catch {}
  }
}

function resumeWsInbound(ws) {
  const sock = ws?._socket;
  if (sock && typeof sock.resume === "function") {
    try { sock.resume(); } catch {}
  }
}

function notifyUploadFailed(intent, intentId, message) {
  const payload = { type: "upload_failed", intentId, message, deliveryHeld: isIntentDeliveryHeld(intent) };
  if (intent?.from) sendToUser(intent.from, payload);
  if (intent?.to && !isIntentDeliveryHeld(intent)) sendToUser(intent.to, payload);
}

function clearTransferAutoFinalizeTimer(t = null) {
  if (!t || !t.autoFinalizeTimer) return;
  try { clearTimeout(t.autoFinalizeTimer); } catch {}
  t.autoFinalizeTimer = null;
}

function finalizeOfflineTransfer(intentId, t, senderWs, options = {}) {
  if (!intentId || !t || t.mode !== "offline") return false;
  if (t.finalizing) return true;
  if (!t.writeStream) return false;

  t.finalizing = true;
  clearTransferAutoFinalizeTimer(t);

  const ws = senderWs || t.senderWs || null;
  const finishIntent = async () => {
    activeTransfers.delete(intentId);
    if (ws?.currentUploadIntentId === intentId) {
      ws.currentUploadIntentId = null;
    }

    let intent;
    try {
      const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
      intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
      intent.stored = true;
      intent.storedBytes = t.bytesExpected;
      intent.plainStoredBytes = uploadBytesToPlainBytes(intent, t.bytesExpected);
      intent.status = "stored";
      intent.transferState = "delivered";
      intent.uploadedAt = Date.now();
      saveIntent(intent);
    } catch (err) {
      console.error("❌ Failed to finalize intent after upload:", err);
      if (ws) {
        send(ws, { type: "upload_failed", intentId, message: "Server failed finalizing upload" });
      }
      return;
    }

    const storedFileName = String(intent.storedFile || "").trim();
    const localFilePath = String(t.filePath || (storedFileName ? path.join(FILES_DIR, storedFileName) : "")).trim();
    if (objectStorage.isEnabled() && localFilePath && fs.existsSync(localFilePath)) {
      const safeName = safeBasename(String(intent.fileName || storedFileName || "file"));
      const objectKey = String(intent.storedObjectKey || "").trim() || objectStorage.buildIntentObjectKey(intentId, storedFileName || safeName);
      try {
        await objectStorage.putFile(objectKey, localFilePath, contentTypeForName(safeName));
        intent.storedObjectKey = objectKey;
        try { fs.unlinkSync(localFilePath); } catch {}
      } catch (err) {
        console.error("❌ Failed to offload uploaded file to object storage:", err);
      }
    }

    intent.stored = true;
    intent.storedBytes = t.bytesExpected;
    intent.plainStoredBytes = uploadBytesToPlainBytes(intent, t.bytesExpected);
    intent.status = "stored";
    intent.transferState = "delivered";
    intent.uploadedAt = Date.now();
    saveIntent(intent);
    queueIntentArchivePreviewWarmup(intent);

    const receiverSockets = getOnlineSocketsForUser(intent.to);
    if (!intent.groupId && receiverSockets.length && !isIntentDeliveryHeld(intent)) {
      const safeIntent = intentForClient(intent);
      sendToUser(intent.to, {
        type: "incoming_file",
        intent: safeIntent
      });
      try {
        sendToUser(intent.to, { type: "inbox", items: loadIntentsForUser(intent.to) });
      } catch {}

      const iosSocket = receiverSockets.find((sock) => String(sock?.client || "").toLowerCase() === "ios");
      if (iosSocket) {
        send(iosSocket, {
          type: "prepare_transfer",
          intentId
        });
      }
    }

    if (intent.groupId) {
      finalizeGroupRecipientCopies(intent, {
        storedBytes: Number(intent.storedBytes || t.bytesExpected || 0),
        totalBytes: Number(t.bytesExpected || resolveUploadExpectedBytes(intent) || 0),
        uploadedAt: intent.uploadedAt
      });
    }

    emitTransferState(intent, "delivered", {
      sentBytes: Number(intent.storedBytes || t.bytesExpected || 0),
      totalBytes: Number(t.bytesExpected || resolveUploadExpectedBytes(intent) || 0),
      plainSentBytes: Number(intent.plainStoredBytes || intent.fileSize || 0),
      plainTotalBytes: Number(intent.fileSize || 0)
    });

    if (ws) {
      send(ws, {
        type: "upload_done",
        intentId,
        autoFinalized: Boolean(options?.auto),
        deliveryHeld: isIntentDeliveryHeld(intent)
      });
    }
  };

  try {
    if (ws?.currentUploadIntentId === intentId) {
      ws.currentUploadIntentId = null;
    }
    t.writeStream.end(() => {
      finishIntent().catch((err) => {
        t.finalizing = false;
        console.error("❌ Failed to finalize offline transfer:", err);
        if (ws) {
          send(ws, { type: "upload_failed", intentId, message: "Server failed finalizing upload" });
        }
      });
    });
  } catch {
    t.finalizing = false;
    activeTransfers.delete(intentId);
    if (ws?.currentUploadIntentId === intentId) {
      ws.currentUploadIntentId = null;
    }
    if (ws) {
      send(ws, { type: "error", message: "Failed to finalize stored file" });
    }
    return false;
  }

  return true;
}

function failActiveTransfer(intentId, message, options = {}) {
  if (!intentId) return null;
  const t = activeTransfers.get(intentId);
  const intent = t?.intent || loadIntent(intentId);
  const preservePartial = options.preservePartial !== false;
  const deleteIntent = options.deleteIntent === true;
  const notify = options.notify !== false;
  const suppressState = options.suppressState === true;
  const retryable = options.retryable != null ? Boolean(options.retryable) : preservePartial;
  const discardPartial = Boolean(options.discardPartial);
  const bytesUploaded = Number(t?.bytesSent || 0);
  clearTransferAutoFinalizeTimer(t);

  try { t?.tcp?.destroy(); } catch {}
  try { t?.writeStream?.destroy(); } catch {}
  if ((discardPartial || !preservePartial) && t?.mode === "offline" && t?.filePath) {
    try { if (fs.existsSync(t.filePath)) fs.unlinkSync(t.filePath); } catch {}
  }

  if (t?.senderWs?.currentUploadIntentId === intentId) {
    t.senderWs.currentUploadIntentId = null;
  }

  activeTransfers.delete(intentId);

  if (intent && preservePartial && !suppressState) {
    updateIntentUploadCheckpoint(intent, bytesUploaded, {
      status: "uploading",
      transferState: "uploading"
    });
    emitTransferState(intent, "uploading", {
      sentBytes: bytesUploaded,
      totalBytes: resolveUploadExpectedBytes(intent),
      plainSentBytes: uploadBytesToPlainBytes(intent, bytesUploaded),
      plainTotalBytes: Number(intent.fileSize || 0),
      retryable,
      message: String(message || "Transfer paused")
    });
  } else if (intent && !suppressState) {
    intent.stored = false;
    intent.storedBytes = Math.max(0, bytesUploaded);
    intent.plainStoredBytes = uploadBytesToPlainBytes(intent, intent.storedBytes);
    intent.status = "failed";
    intent.transferState = "failed";
    intent.updatedAt = Date.now();
    try { saveIntent(intent); } catch {}
    emitTransferState(intent, "failed", {
      sentBytes: bytesUploaded,
      totalBytes: resolveUploadExpectedBytes(intent),
      plainSentBytes: uploadBytesToPlainBytes(intent, bytesUploaded),
      plainTotalBytes: Number(intent.fileSize || 0),
      retryable,
      message: String(message || "Upload failed")
    });
  }

  if (intent && notify && !preservePartial) {
    notifyUploadFailed(intent, intentId, message);
  }
  if (intent && deleteIntent) {
    deleteIntentAndNotify(intent);
  }
  return intent || null;
}

function finalizeGroupRecipientCopies(primaryIntent, options = {}) {
  const primary = primaryIntent || null;
  if (!primary) return;
  const mirrorIds = Array.isArray(primary.groupMirrorIntentIds) ? primary.groupMirrorIntentIds : [];
  if (!mirrorIds.length) return;

  const uploadedAt = Number(options.uploadedAt || Date.now()) || Date.now();
  const storedBytes = Number(options.storedBytes || primary.storedBytes || 0);
  const totalBytes = Number(options.totalBytes || resolveUploadExpectedBytes(primary) || storedBytes || 0);

  mirrorIds.forEach((mirrorId) => {
    const mirror = loadIntent(mirrorId);
    if (!mirror) return;
    mirror.stored = true;
    mirror.storedFile = primary.storedFile || mirror.storedFile || null;
    mirror.storedObjectKey = primary.storedObjectKey || mirror.storedObjectKey || null;
    mirror.storedBytes = storedBytes;
    mirror.plainStoredBytes = uploadBytesToPlainBytes(mirror, storedBytes);
    mirror.uploadBytesExpected = Number(mirror.uploadBytesExpected || primary.uploadBytesExpected || totalBytes || 0);
    mirror.status = "stored";
    mirror.transferState = "delivered";
    mirror.uploadedAt = uploadedAt;
    saveIntent(mirror);
    queueIntentArchivePreviewWarmup(mirror);

    emitTransferState(mirror, "delivered", {
      sentBytes: storedBytes,
      totalBytes: totalBytes || resolveUploadExpectedBytes(mirror),
      plainSentBytes: mirror.plainStoredBytes,
      plainTotalBytes: Number(mirror.fileSize || 0)
    });

    const sockets = getOnlineSocketsForUser(mirror.to);
    if (!sockets.length) return;
    if (isIntentDeliveryHeld(mirror)) return;
    sendToUser(mirror.to, { type: "incoming_file", intent: intentForClient(mirror) });
    try {
      sendToUser(mirror.to, { type: "inbox", items: loadIntentsForUser(mirror.to) });
    } catch {}
    const iosSocket = sockets.find((sock) => String(sock?.client || "").toLowerCase() === "ios");
    if (iosSocket) {
      send(iosSocket, { type: "prepare_transfer", intentId: mirror.id });
    }
  });
}

function cleanupStalledTransfers() {
  const now = Date.now();
  for (const [intentId, t] of activeTransfers.entries()) {
    if (!intentId || !t) continue;
    const baseTimeout = Number.isFinite(TRANSFER_IDLE_TIMEOUT_MS) ? TRANSFER_IDLE_TIMEOUT_MS : 180000;
    const timeoutMs = (t.mode === "live" && !t.tcp) ? Math.max(baseTimeout, 5 * 60 * 1000) : baseTimeout;
    const lastTs = Number(t.lastActivityAt || t.startedAt || 0);
    if (!lastTs) continue;
    if (now - lastTs <= timeoutMs) continue;
    console.warn(`⏱️ Transfer timeout: ${intentId} idle for ${now - lastTs}ms`);
    failActiveTransfer(intentId, "Upload timed out due to inactivity", {
      preservePartial: true,
      deleteIntent: false,
      notify: true,
      retryable: true
    });
  }
}



function getPublicEndpoint(req) {
  // Render / proxies use x-forwarded-for
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress;

  const port = req.socket.remotePort;

  return { ip, port };
}


function userFile(username) {
  return path.join(USERS_DIR, `${username}.json`);
}

function loadUser(username) {
  const file = userFile(username);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveUser(user) {
  fs.writeFileSync(userFile(user.username), JSON.stringify(user, null, 2));
}

function groupFile(groupId = "") {
  const id = String(groupId || "").trim();
  if (!id) return "";
  return path.join(GROUPS_DIR, `${id}.json`);
}

function normalizeGroupName(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function normalizeGroupMembers(members = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(members) ? members : []) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 64) break;
  }
  return out;
}

function loadGroup(groupId = "") {
  const file = groupFile(groupId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || groupId || "").trim();
    if (!id) return null;
    const members = normalizeGroupMembers(raw.members || []);
    if (!members.length) return null;
    return {
      id,
      name: normalizeGroupName(raw.name || ""),
      members,
      createdBy: String(raw.createdBy || members[0] || "").trim(),
      createdAt: Number(raw.createdAt || Date.now()) || Date.now(),
      updatedAt: Number(raw.updatedAt || raw.createdAt || Date.now()) || Date.now()
    };
  } catch {
    return null;
  }
}

function saveGroup(group) {
  const id = String(group?.id || "").trim();
  if (!id) return false;
  const members = normalizeGroupMembers(group?.members || []);
  if (!members.length) return false;
  const payload = {
    id,
    name: normalizeGroupName(group?.name || ""),
    members,
    createdBy: String(group?.createdBy || members[0] || "").trim(),
    createdAt: Number(group?.createdAt || Date.now()) || Date.now(),
    updatedAt: Number(group?.updatedAt || Date.now()) || Date.now()
  };
  fs.writeFileSync(groupFile(id), JSON.stringify(payload, null, 2));
  return true;
}

function groupForClient(group) {
  if (!group || typeof group !== "object") return null;
  return {
    id: String(group.id || "").trim(),
    name: normalizeGroupName(group.name || ""),
    members: normalizeGroupMembers(group.members || []),
    createdBy: String(group.createdBy || "").trim(),
    createdAt: Number(group.createdAt || 0) || Date.now(),
    updatedAt: Number(group.updatedAt || group.createdAt || 0) || Date.now()
  };
}

function listGroupsForUser(username = "") {
  const name = String(username || "").trim();
  if (!name) return [];
  const u0 = loadUser(name);
  if (!u0) return [];
  const user = ensureUserShape(u0);
  const valid = [];
  let changed = false;
  for (const id of normalizeGroupMembers(user.groups || [])) {
    const group = loadGroup(id);
    if (!group || !group.members.includes(name)) {
      changed = true;
      continue;
    }
    valid.push(group);
  }
  if (changed) {
    user.groups = valid.map((g) => g.id);
    saveUser(user);
  }
  valid.sort((a, b) => Number(a?.updatedAt || a?.createdAt || 0) - Number(b?.updatedAt || b?.createdAt || 0));
  return valid;
}

function sendGroupsList(ws, username = "") {
  if (!ws) return false;
  const name = String(username || ws.username || "").trim();
  if (!name) return false;
  const groups = listGroupsForUser(name).map(groupForClient).filter(Boolean);
  return send(ws, { type: "groups_list", groups });
}

function broadcastGroupsListToMembers(members = []) {
  const unique = normalizeGroupMembers(members);
  unique.forEach((name) => {
    const sockets = getOnlineSocketsForUser(name);
    if (!sockets.length) return;
    sockets.forEach((sock) => sendGroupsList(sock, name));
  });
}

function emitGroupSystemMessage(group, actorUsername = "", text = "", createdAt = Date.now()) {
  const g = groupForClient(group);
  const actor = String(actorUsername || "").trim();
  const messageText = String(text || "").trim().slice(0, 5000);
  if (!g?.id || !actor || !messageText) return [];
  const members = normalizeGroupMembers(g.members || []);
  if (!members.length) return [];

  const intentsByUser = new Map();
  members.forEach((member) => {
    const intent = {
      id: randomUUID(),
      from: actor,
      to: member,
      fileName: "",
      fileSize: 0,
      note: "",
      text: messageText,
      isTextOnly: true,
      isSystemEvent: true,
      messageType: "system",
      encryption: null,
      accessControl: null,
      passwordProtected: false,
      passwordMode: "once",
      passwordHint: "",
      uploadBytesExpected: 0,
      createdAt,
      expiresAt: 0,
      customExpiry: false,
      status: "completed",
      transferState: "delivered",
      readByRecipientAt: null,
      groupId: g.id,
      groupName: normalizeGroupName(g.name || ""),
      groupMembers: normalizeGroupMembers(g.members || []),
      clientIntentId: null,
      downloadToken: null,
      isGroupRecipientCopy: member !== actor,
      stored: true,
      storedFile: null,
      storedBytes: 0,
      plainStoredBytes: 0,
      uploadedAt: createdAt,
      completedAt: createdAt
    };
    saveIntent(intent);
    intentsByUser.set(member, intent);
  });

  members.forEach((member) => {
    if (!isUserOnline(member)) return;
    const intent = intentsByUser.get(member);
    if (intent) {
      sendToUser(member, { type: "incoming_file", intent: intentForClient(intent) });
    }
    try {
      sendToUser(member, { type: "inbox", items: loadIntentsForUser(member) });
    } catch {}
  });

  const chatKey = groupChatKey(g.id);
  if (chatKey) {
    members.forEach((member) => {
      touchUserChatOrder(member, chatKey);
    });
  }

  return Array.from(intentsByUser.values());
}

function removeUserFromGroups(username = "") {
  const name = String(username || "").trim();
  if (!name) return [];
  const affected = new Set();
  let files = [];
  try {
    files = fs.readdirSync(GROUPS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  files.forEach((file) => {
    const id = path.basename(file, ".json");
    const group = loadGroup(id);
    if (!group || !group.members.includes(name)) return;
    const groupKey = groupChatKey(group.id);
    if (groupKey) {
      removeChatKeyFromUserState(name, groupKey);
    }
    const nextMembers = group.members.filter((member) => member !== name);
    if (nextMembers.length < 2) {
      try { fs.unlinkSync(groupFile(group.id)); } catch {}
      nextMembers.forEach((member) => {
        if (groupKey) {
          removeChatKeyFromUserState(member, groupKey);
        }
        const u0 = loadUser(member);
        if (!u0) return;
        const u = ensureUserShape(u0);
        const beforeLen = u.groups.length;
        u.groups = u.groups.filter((gid) => gid !== group.id);
        if (u.groups.length !== beforeLen) {
          saveUser(u);
          affected.add(member);
        }
      });
      return;
    }
    group.members = nextMembers;
    group.updatedAt = Date.now();
    if (group.createdBy === name) {
      group.createdBy = nextMembers[0] || "";
    }
    saveGroup(group);
    nextMembers.forEach((member) => {
      const u0 = loadUser(member);
      if (!u0) return;
      const u = ensureUserShape(u0);
      if (!u.groups.includes(group.id)) {
        u.groups.push(group.id);
        saveUser(u);
      }
      affected.add(member);
    });
  });
  return Array.from(affected);
}

function ensureUserShape(u) {
  if (!u.friends) u.friends = [];
  if (!Array.isArray(u.friends)) u.friends = [];
  if (!u.incomingRequests) u.incomingRequests = [];
  if (!Array.isArray(u.incomingRequests)) u.incomingRequests = [];
  if (!u.outgoingRequests) u.outgoingRequests = [];
  if (!Array.isArray(u.outgoingRequests)) u.outgoingRequests = [];
  if (!u.declinedRequests) u.declinedRequests = [];
  if (!Array.isArray(u.declinedRequests)) u.declinedRequests = [];
  if (!u.deletedFriends) u.deletedFriends = [];
  if (!Array.isArray(u.deletedFriends)) u.deletedFriends = [];
  if (!u.deletedIntents) u.deletedIntents = [];
  if (!Array.isArray(u.deletedIntents)) u.deletedIntents = [];
  if (!u.groups) u.groups = [];
  if (!Array.isArray(u.groups)) u.groups = [];
  if (!u.profile) u.profile = {};
  if (!Array.isArray(u.sessionTokens)) u.sessionTokens = [];
  u.sessionTokens = sanitizeSessionTokens(u.sessionTokens);
  if (!Array.isArray(u.pushDevices)) u.pushDevices = [];
  u.pushDevices = normalizePushDevices(u.pushDevices);
  if (!u.chatState || typeof u.chatState !== "object" || Array.isArray(u.chatState)) u.chatState = {};
  if (!Array.isArray(u.chatState.order)) u.chatState.order = [];
  if (!Array.isArray(u.chatState.manualUnread)) u.chatState.manualUnread = [];
  if (!Array.isArray(u.chatState.pins)) {
    const fallbackPins = Array.isArray(u.profile?.pinnedContacts) ? u.profile.pinnedContacts : [];
    u.chatState.pins = fallbackPins;
  }
  if (!u.chatState.nicknames || typeof u.chatState.nicknames !== "object" || Array.isArray(u.chatState.nicknames)) {
    const legacyNicknames = u.profile?.contactNicknames;
    u.chatState.nicknames = (legacyNicknames && typeof legacyNicknames === "object" && !Array.isArray(legacyNicknames))
      ? { ...legacyNicknames }
      : {};
  }
  if (!u.chatState.chatAliases || typeof u.chatState.chatAliases !== "object" || Array.isArray(u.chatState.chatAliases)) {
    const legacyAliases = u.profile?.chatAliases;
    u.chatState.chatAliases = (legacyAliases && typeof legacyAliases === "object" && !Array.isArray(legacyAliases))
      ? { ...legacyAliases }
      : {};
  }
  if (!Number.isFinite(Number(u.chatState.version))) u.chatState.version = 1;
  if (!Number.isFinite(Number(u.chatState.updatedAt))) u.chatState.updatedAt = Date.now();

  u.chatState.order = sanitizeChatStateKeys(u.chatState.order);
  u.chatState.manualUnread = sanitizeChatStateKeys(u.chatState.manualUnread);
  u.chatState.pins = sanitizeChatStateKeys(u.chatState.pins);
  u.chatState.nicknames = sanitizeContactNicknamesMap(u.chatState.nicknames, u);
  u.chatState.chatAliases = sanitizeChatAliasesMap(u.chatState.chatAliases, u);
  u.chatState.version = Math.max(1, Math.floor(Number(u.chatState.version || 1)));
  u.chatState.updatedAt = Math.max(0, Math.floor(Number(u.chatState.updatedAt || Date.now())));

  const profilePins = sanitizeChatStateKeys(u.profile?.pinnedContacts || []);
  if (!profilePins.length && u.chatState.pins.length) {
    u.profile.pinnedContacts = u.chatState.pins.slice();
  } else if (profilePins.length && !u.chatState.pins.length) {
    u.chatState.pins = profilePins.slice();
  } else if (profilePins.length && u.chatState.pins.length && !sameStringList(profilePins, u.chatState.pins)) {
    // chatState is the authoritative source for multi-device sync.
    u.profile.pinnedContacts = u.chatState.pins.slice();
  } else if (!profilePins.length && !u.chatState.pins.length) {
    u.profile.pinnedContacts = [];
  }
  u.profile.contactNicknames = { ...(u.chatState.nicknames || {}) };
  u.profile.chatAliases = { ...(u.chatState.chatAliases || {}) };

  const legacyQuickChats = Array.isArray(u.quickChats) ? u.quickChats : [];
  if (!u.quickChatsState || typeof u.quickChatsState !== "object" || Array.isArray(u.quickChatsState)) {
    u.quickChatsState = {};
  }
  if (!Array.isArray(u.quickChatsState.chats)) {
    u.quickChatsState.chats = legacyQuickChats;
  }
  if (!Array.isArray(u.quickChatsState.pins)) {
    u.quickChatsState.pins = [];
  }
  if (!Number.isFinite(Number(u.quickChatsState.version))) {
    u.quickChatsState.version = 1;
  }
  if (!Number.isFinite(Number(u.quickChatsState.updatedAt))) {
    u.quickChatsState.updatedAt = Date.now();
  }
  u.quickChatsState.chats = sanitizeQuickChatEntries(u.quickChatsState.chats);
  u.quickChatsState.pins = sanitizeQuickChatPinKeys(u.quickChatsState.pins, u.quickChatsState.chats);
  u.quickChatsState.version = Math.max(1, Math.floor(Number(u.quickChatsState.version || 1)));
  u.quickChatsState.updatedAt = Math.max(0, Math.floor(Number(u.quickChatsState.updatedAt || Date.now())));
  // Keep legacy key for backwards compatibility with older deployments.
  u.quickChats = u.quickChatsState.chats.slice();

  if (!u.fileHolderState || typeof u.fileHolderState !== "object" || Array.isArray(u.fileHolderState)) {
    u.fileHolderState = {};
  }
  if (!Array.isArray(u.fileHolderState.items)) {
    u.fileHolderState.items = [];
  }
  if (!Number.isFinite(Number(u.fileHolderState.version))) {
    u.fileHolderState.version = 1;
  }
  if (!Number.isFinite(Number(u.fileHolderState.updatedAt))) {
    u.fileHolderState.updatedAt = Date.now();
  }
  u.fileHolderState.items = sanitizeFileHolderEntries(u.fileHolderState.items);
  u.fileHolderState.version = Math.max(1, Math.floor(Number(u.fileHolderState.version || 1)));
  u.fileHolderState.updatedAt = Math.max(0, Math.floor(Number(u.fileHolderState.updatedAt || Date.now())));
  return u;
}

function sanitizeSessionTokens(list = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const token = String(raw || "").trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  if (out.length > MAX_SESSION_TOKENS) {
    return out.slice(-MAX_SESSION_TOKENS);
  }
  return out;
}

function touchUserSessionToken(user = null, sessionToken = "") {
  if (!user || typeof user !== "object") return false;
  const token = String(sessionToken || "").trim();
  if (!token) return false;
  const current = sanitizeSessionTokens(Array.isArray(user.sessionTokens) ? user.sessionTokens : []);
  const without = current.filter((entry) => entry !== token);
  without.push(token);
  const next = sanitizeSessionTokens(without);
  if (sameStringList(current, next)) {
    user.sessionTokens = current;
    return false;
  }
  user.sessionTokens = next;
  return true;
}

function sameStringList(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i] || "") !== String(b[i] || "")) return false;
  }
  return true;
}

function quickChatKeyFromId(threadId = "") {
  const id = String(threadId || "").trim();
  return id ? `quick:${id}` : "";
}

function normalizeQuickChatCode(value = "") {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function normalizeQuickChatEntry(entry = null) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || "").trim().slice(0, 128);
  if (!id) return null;
  const code = normalizeQuickChatCode(entry.code || "");
  if (!code) return null;
  const createdAtRaw = Number(entry.createdAt || entry.lastActivityAt || 0);
  const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : Date.now();
  const expiresAtRaw = Number(entry.expiresAt || 0);
  const expiresAt = Number.isFinite(expiresAtRaw) && expiresAtRaw > 0 ? Math.floor(expiresAtRaw) : 0;
  return {
    id,
    code,
    name: String(entry.name || "").trim().slice(0, 80),
    recipient: String(entry.recipient || "").trim().slice(0, 120),
    createdAt,
    expiresAt
  };
}

function sanitizeQuickChatEntries(list = []) {
  const now = Date.now();
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = normalizeQuickChatEntry(raw);
    if (!entry) continue;
    if (entry.expiresAt > 0 && entry.expiresAt <= now) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    if (out.length >= QUICK_CHATS_MAX_ITEMS) break;
  }
  out.sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
  return out;
}

function sanitizeQuickChatPinKeys(list = [], chats = []) {
  const chatIds = new Set((Array.isArray(chats) ? chats : []).map((entry) => String(entry?.id || "").trim()).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const key = String(raw || "").trim();
    if (!/^quick:/i.test(key)) continue;
    const normalized = quickChatKeyFromId(key.slice(6));
    if (!normalized || seen.has(normalized)) continue;
    const id = normalized.slice(6);
    if (!chatIds.has(id)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= QUICK_CHATS_MAX_ITEMS) break;
  }
  return out;
}

function sameQuickChatEntries(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] || {};
    const right = b[i] || {};
    if (String(left.id || "") !== String(right.id || "")) return false;
    if (String(left.code || "") !== String(right.code || "")) return false;
    if (String(left.name || "") !== String(right.name || "")) return false;
    if (String(left.recipient || "") !== String(right.recipient || "")) return false;
    if (Number(left.createdAt || 0) !== Number(right.createdAt || 0)) return false;
    if (Number(left.expiresAt || 0) !== Number(right.expiresAt || 0)) return false;
  }
  return true;
}

function groupChatKey(groupId = "") {
  const id = String(groupId || "").trim();
  if (!id) return "";
  return `group:${id}`;
}

function normalizeChatStateKey(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^group:/i.test(raw)) {
    const id = raw.slice(6).trim();
    return id ? `group:${id}` : "";
  }
  if (raw.includes(":")) return "";
  return raw;
}

function sanitizeChatStateKeys(list = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const key = normalizeChatStateKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= CHAT_STATE_MAX_KEYS) break;
  }
  return out;
}

function sanitizeContactNicknamesMap(map = {}, userRecord = null) {
  const user = (userRecord && typeof userRecord === "object") ? userRecord : {};
  const me = String(user.username || "").trim().toLowerCase();
  const friendsSet = new Set((Array.isArray(user.friends) ? user.friends : []).map((friend) => String(friend || "").trim()).filter(Boolean));
  const out = {};
  const entries = (map && typeof map === "object" && !Array.isArray(map)) ? Object.entries(map) : [];
  for (const [rawUser, rawNickname] of entries) {
    const username = String(rawUser || "").trim();
    if (!username) continue;
    if (username.toLowerCase() === me) continue;
    if (!friendsSet.has(username)) continue;
    const nickname = String(rawNickname || "").trim().slice(0, 80);
    if (!nickname) continue;
    out[username] = nickname;
    if (Object.keys(out).length >= CHAT_STATE_MAX_NICKNAMES) break;
  }
  return out;
}

function sanitizeChatAliasesMap(map = {}, userRecord = null) {
  const user = (userRecord && typeof userRecord === "object") ? userRecord : {};
  const allowed = new Set();
  const name = String(user.username || "").trim();
  if (name) allowed.add(name);
  (Array.isArray(user.friends) ? user.friends : []).forEach((friend) => {
    const key = normalizeChatStateKey(friend);
    if (key) allowed.add(key);
  });
  (Array.isArray(user.groups) ? user.groups : []).forEach((groupId) => {
    const key = groupChatKey(groupId);
    if (key) allowed.add(key);
  });
  const out = {};
  const entries = (map && typeof map === "object" && !Array.isArray(map)) ? Object.entries(map) : [];
  for (const [rawKey, rawAlias] of entries) {
    const key = normalizeChatStateKey(rawKey);
    if (!key || !allowed.has(key)) continue;
    const alias = String(rawAlias || "").trim().slice(0, 80);
    if (!alias) continue;
    out[key] = alias;
    if (Object.keys(out).length >= CHAT_STATE_MAX_ALIASES) break;
  }
  return out;
}

function buildAllowedChatKeysForUser(userRecord = null) {
  const user = ensureUserShape(userRecord || {});
  const allowed = new Set();
  const name = String(user.username || "").trim();
  if (name) allowed.add(name);
  (Array.isArray(user.friends) ? user.friends : []).forEach((friend) => {
    const key = normalizeChatStateKey(friend);
    if (key) allowed.add(key);
  });
  (Array.isArray(user.groups) ? user.groups : []).forEach((groupId) => {
    const key = groupChatKey(groupId);
    if (key) allowed.add(key);
  });
  return allowed;
}

function filterChatKeysForUser(userRecord = null, list = []) {
  const user = ensureUserShape(userRecord || {});
  const allowed = buildAllowedChatKeysForUser(user);
  return sanitizeChatStateKeys(list).filter((key) => allowed.has(key));
}

function chatStateForClient(userRecord = null) {
  const user = ensureUserShape(userRecord || {});
  const state = user.chatState || {};
  const allowed = Array.from(buildAllowedChatKeysForUser(user));
  const baseOrder = filterChatKeysForUser(user, state.order || []);
  const missing = allowed
    .filter((key) => !baseOrder.includes(key))
    .sort((a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" }));
  return {
    version: Math.max(1, Math.floor(Number(state.version || 1))),
    updatedAt: Math.max(0, Math.floor(Number(state.updatedAt || Date.now()))),
    order: [...baseOrder, ...missing],
    manualUnread: filterChatKeysForUser(user, state.manualUnread || []),
    pins: filterChatKeysForUser(user, state.pins || []),
    nicknames: sanitizeContactNicknamesMap(state.nicknames || {}, user),
    chatAliases: sanitizeChatAliasesMap(state.chatAliases || {}, user)
  };
}

function saveAndBroadcastChatState(userRecord = null, options = {}) {
  const user = ensureUserShape(userRecord || {});
  const state = chatStateForClient(user);
  user.chatState = {
    ...state
  };
  if (!user.profile || typeof user.profile !== "object") user.profile = {};
  user.profile.pinnedContacts = state.pins.slice();
  user.profile.contactNicknames = { ...(state.nicknames || {}) };
  user.profile.chatAliases = { ...(state.chatAliases || {}) };
  saveUser(user);
  if (options.broadcast !== false) {
    sendToUser(user.username, { type: "chat_state", state });
  }
  return { user, state };
}

function updateUserChatState(username = "", mutator = null, options = {}) {
  const name = String(username || "").trim();
  if (!name || typeof mutator !== "function") return null;
  const u0 = loadUser(name);
  if (!u0) return null;
  const user = ensureUserShape(u0);
  const prev = chatStateForClient(user);
  const draft = {
    order: prev.order.slice(),
    manualUnread: prev.manualUnread.slice(),
    pins: prev.pins.slice(),
    nicknames: { ...(prev.nicknames || {}) },
    chatAliases: { ...(prev.chatAliases || {}) }
  };
  const changedByMutator = Boolean(mutator(draft, user));

  draft.order = filterChatKeysForUser(user, draft.order);
  draft.manualUnread = filterChatKeysForUser(user, draft.manualUnread);
  draft.pins = filterChatKeysForUser(user, draft.pins);
  draft.nicknames = sanitizeContactNicknamesMap(draft.nicknames || {}, user);
  draft.chatAliases = sanitizeChatAliasesMap(draft.chatAliases || {}, user);

  const changed = changedByMutator ||
    !sameStringList(prev.order, draft.order) ||
    !sameStringList(prev.manualUnread, draft.manualUnread) ||
    !sameStringList(prev.pins, draft.pins) ||
    JSON.stringify(prev.nicknames || {}) !== JSON.stringify(draft.nicknames || {}) ||
    JSON.stringify(prev.chatAliases || {}) !== JSON.stringify(draft.chatAliases || {});

  if (!changed) {
    return { changed: false, user, state: prev };
  }

  const next = {
    version: Math.max(1, Number(prev.version || 1)) + 1,
    updatedAt: Date.now(),
    order: draft.order.slice(),
    manualUnread: draft.manualUnread.slice(),
    pins: draft.pins.slice(),
    nicknames: { ...(draft.nicknames || {}) },
    chatAliases: { ...(draft.chatAliases || {}) }
  };
  user.chatState = next;
  if (!user.profile || typeof user.profile !== "object") user.profile = {};
  user.profile.pinnedContacts = next.pins.slice();
  user.profile.contactNicknames = { ...(next.nicknames || {}) };
  user.profile.chatAliases = { ...(next.chatAliases || {}) };
  saveUser(user);
  if (options.broadcast !== false) {
    sendToUser(name, { type: "chat_state", state: next });
  }
  return { changed: true, user, state: next };
}

function quickChatsStateForClient(userRecord = null) {
  const user = ensureUserShape(userRecord || {});
  const state = user.quickChatsState || {};
  const chats = sanitizeQuickChatEntries(state.chats || user.quickChats || []);
  const pins = sanitizeQuickChatPinKeys(state.pins || [], chats);
  return {
    version: Math.max(1, Math.floor(Number(state.version || 1))),
    updatedAt: Math.max(0, Math.floor(Number(state.updatedAt || Date.now()))),
    chats,
    pins
  };
}

function updateUserQuickChatsState(username = "", mutator = null, options = {}) {
  const name = String(username || "").trim();
  if (!name || typeof mutator !== "function") return null;
  const u0 = loadUser(name);
  if (!u0) return null;
  const user = ensureUserShape(u0);
  const prev = quickChatsStateForClient(user);
  const draft = {
    chats: prev.chats.map((entry) => ({ ...entry })),
    pins: prev.pins.slice()
  };
  const changedByMutator = Boolean(mutator(draft, user));

  draft.chats = sanitizeQuickChatEntries(draft.chats);
  draft.pins = sanitizeQuickChatPinKeys(draft.pins, draft.chats);

  const changed = changedByMutator ||
    !sameQuickChatEntries(prev.chats, draft.chats) ||
    !sameStringList(prev.pins, draft.pins);

  if (!changed) {
    return { changed: false, user, state: prev };
  }

  const next = {
    version: Math.max(1, Number(prev.version || 1)) + 1,
    updatedAt: Date.now(),
    chats: draft.chats,
    pins: draft.pins
  };
  user.quickChatsState = next;
  user.quickChats = next.chats.slice();
  saveUser(user);
  if (options.broadcast !== false) {
    sendToUser(name, { type: "quick_chats", state: next });
  }
  return { changed: true, user, state: next };
}

function normalizeFileHolderMime(value = "", fallbackName = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(raw)) {
    return raw;
  }
  return contentTypeForName(String(fallbackName || "file"));
}

function normalizeFileHolderEntry(entry = null) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || entry.itemId || "").trim().slice(0, 128);
  if (!id) return null;
  const storedFile = safeBasename(String(entry.storedFile || "").trim());
  const storedObjectKey = String(entry.storedObjectKey || "").trim();
  if (!storedFile && !storedObjectKey) return null;
  const name = safeBasename(String(entry.name || entry.fileName || "file").trim() || "file");
  const sizeRaw = Number(entry.size || entry.bytes || 0);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0;
  const createdAtRaw = Number(entry.createdAt || entry.updatedAt || 0);
  const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : Date.now();
  const updatedAtRaw = Number(entry.updatedAt || createdAt || 0);
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? Math.floor(updatedAtRaw) : createdAt;
  return {
    id,
    storedFile: storedFile || null,
    storedObjectKey: storedObjectKey || null,
    name,
    size,
    mime: normalizeFileHolderMime(entry.mime || entry.contentType || "", name),
    createdAt,
    updatedAt
  };
}

function sanitizeFileHolderEntries(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = normalizeFileHolderEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    if (entry.storedObjectKey && objectStorage.isEnabled()) {
      if (!Number.isFinite(entry.size) || entry.size < 0) {
        entry.size = 0;
      }
    } else {
      const fullPath = path.join(FILE_HOLDER_DIR, String(entry.storedFile || "").trim());
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        if (!Number.isFinite(entry.size) || entry.size <= 0) {
          entry.size = Math.max(0, Number(stat.size || 0));
        }
      } catch {
        continue;
      }
    }
    seen.add(entry.id);
    out.push(entry);
    if (out.length >= FILE_HOLDER_MAX_ITEMS) break;
  }
  return out;
}

function sameFileHolderEntries(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] || {};
    const right = b[i] || {};
    if (String(left.id || "") !== String(right.id || "")) return false;
    if (String(left.storedFile || "") !== String(right.storedFile || "")) return false;
    if (String(left.storedObjectKey || "") !== String(right.storedObjectKey || "")) return false;
    if (String(left.name || "") !== String(right.name || "")) return false;
    if (Number(left.size || 0) !== Number(right.size || 0)) return false;
    if (String(left.mime || "") !== String(right.mime || "")) return false;
    if (Number(left.createdAt || 0) !== Number(right.createdAt || 0)) return false;
    if (Number(left.updatedAt || 0) !== Number(right.updatedAt || 0)) return false;
  }
  return true;
}

function fileHolderStateForClient(userRecord = null) {
  const user = ensureUserShape(userRecord || {});
  const state = user.fileHolderState || {};
  const items = sanitizeFileHolderEntries(state.items || []);
  return {
    version: Math.max(1, Math.floor(Number(state.version || 1))),
    updatedAt: Math.max(0, Math.floor(Number(state.updatedAt || Date.now()))),
    items: items.map((entry) => ({
      id: String(entry.id || "").trim(),
      name: String(entry.name || "file"),
      size: Math.max(0, Number(entry.size || 0)),
      storedFile: String(entry.storedFile || "").trim() || null,
      mime: normalizeFileHolderMime(entry.mime || "", entry.name || ""),
      createdAt: Math.max(0, Number(entry.createdAt || 0) || 0),
      updatedAt: Math.max(0, Number(entry.updatedAt || 0) || 0)
    }))
  };
}

function removeFileHolderStoredEntry(entry = null) {
  const storedObjectKey = String(entry?.storedObjectKey || "").trim();
  if (storedObjectKey && objectStorage.isEnabled()) {
    objectStorage.deleteObject(storedObjectKey).catch(() => {});
  }
  const safeName = safeBasename(String(entry?.storedFile || "").trim());
  if (!safeName) return;
  const fullPath = path.join(FILE_HOLDER_DIR, safeName);
  try {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch {}
}

function updateUserFileHolderState(username = "", mutator = null, options = {}) {
  const name = String(username || "").trim();
  if (!name || typeof mutator !== "function") return null;
  const u0 = loadUser(name);
  if (!u0) return null;
  const user = ensureUserShape(u0);
  const prevItems = sanitizeFileHolderEntries((user.fileHolderState || {}).items || []);
  const prevState = {
    version: Math.max(1, Math.floor(Number(user?.fileHolderState?.version || 1))),
    updatedAt: Math.max(0, Math.floor(Number(user?.fileHolderState?.updatedAt || Date.now()))),
    items: prevItems
  };
  const draft = prevItems.map((entry) => ({ ...entry }));
  const changedByMutator = Boolean(mutator(draft, user));
  const nextItems = sanitizeFileHolderEntries(draft);
  const changed = changedByMutator || !sameFileHolderEntries(prevItems, nextItems);
  if (!changed) {
    return { changed: false, user, state: fileHolderStateForClient(user) };
  }

  const next = {
    version: Math.max(1, Number(prevState.version || 1)) + 1,
    updatedAt: Date.now(),
    items: nextItems
  };
  user.fileHolderState = next;
  saveUser(user);

  const retainedStored = new Set(nextItems.map((entry) => String(entry?.storedFile || "").trim()).filter(Boolean));
  prevItems.forEach((entry) => {
    const stored = String(entry?.storedFile || "").trim();
    const objectKey = String(entry?.storedObjectKey || "").trim();
    const retainedObject = nextItems.some((row) => String(row?.storedObjectKey || "").trim() === objectKey && objectKey);
    if ((!stored || retainedStored.has(stored)) && (!objectKey || retainedObject)) return;
    removeFileHolderStoredEntry(entry);
  });

  const clientState = fileHolderStateForClient(user);
  if (options.broadcast !== false) {
    sendToUser(name, { type: "file_holder", state: clientState });
  }
  return { changed: true, user, state: clientState };
}

function listFileHolderEntriesForUser(username = "") {
  const name = String(username || "").trim();
  if (!name) return [];
  const u0 = loadUser(name);
  if (!u0) return [];
  const user = ensureUserShape(u0);
  const state = user.fileHolderState || {};
  const items = sanitizeFileHolderEntries(state.items || []);
  if (!sameFileHolderEntries(items, state.items || [])) {
    user.fileHolderState = {
      version: Math.max(1, Math.floor(Number(state.version || 1))),
      updatedAt: Math.max(0, Math.floor(Number(state.updatedAt || Date.now()))),
      items
    };
    saveUser(user);
  }
  return items;
}

function touchUserChatOrder(username = "", chatKey = "") {
  const key = normalizeChatStateKey(chatKey);
  if (!key) return null;
  return updateUserChatState(username, (draft) => {
    const nextOrder = [key, ...draft.order.filter((entry) => entry !== key)];
    const changed = !sameStringList(draft.order, nextOrder);
    if (changed) {
      draft.order = nextOrder;
    }
    return changed;
  });
}

function removeChatKeyFromUserState(username = "", chatKey = "") {
  const key = normalizeChatStateKey(chatKey);
  if (!key) return null;
  return updateUserChatState(username, (draft) => {
    const nextOrder = draft.order.filter((entry) => entry !== key);
    const nextUnread = draft.manualUnread.filter((entry) => entry !== key);
    const nextPins = draft.pins.filter((entry) => entry !== key);
    const changed = nextOrder.length !== draft.order.length ||
      nextUnread.length !== draft.manualUnread.length ||
      nextPins.length !== draft.pins.length;
    draft.order = nextOrder;
    draft.manualUnread = nextUnread;
    draft.pins = nextPins;
    return changed;
  });
}

function broadcastInboxSnapshot(username = "") {
  const name = String(username || "").trim();
  if (!name) return false;
  const sockets = getOnlineSocketsForUser(name);
  if (!sockets.length) return false;
  let items = [];
  try {
    items = loadIntentsForUser(name);
  } catch {
    items = [];
  }
  return sendToUser(name, { type: "inbox", items });
}

function loadProfiles(usernames = []) {
  const profiles = {};
  usernames.forEach((name) => {
    const u = loadUser(name);
    if (u?.profile) profiles[name] = u.profile;
  });
  return profiles;
}

function sendFriendRequestsUpdate(username) {
  const u0 = loadUser(username);
  if (!u0) return;
  const u = ensureUserShape(u0);
  sendToUser(username, {
    type: "friend_requests",
    incoming: u.incomingRequests || [],
    outgoing: u.outgoingRequests || [],
    declined: u.declinedRequests || []
  });
}

function loadGuestTransferRequestsIndex() {
  try {
    if (!fs.existsSync(GUEST_TRANSFER_REQUESTS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(GUEST_TRANSFER_REQUESTS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const users = parsed.users && typeof parsed.users === "object" ? parsed.users : parsed;
    const out = {};
    Object.entries(users).forEach(([username, rawList]) => {
      const key = String(username || "").trim();
      if (!key) return;
      out[key] = Array.isArray(rawList) ? rawList : [];
    });
    return out;
  } catch {
    return {};
  }
}

let guestTransferRequestsByUser = loadGuestTransferRequestsIndex();

function saveGuestTransferRequestsIndex() {
  const tmp = `${GUEST_TRANSFER_REQUESTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users: guestTransferRequestsByUser }, null, 2));
  fs.renameSync(tmp, GUEST_TRANSFER_REQUESTS_FILE);
}

function userExistsCaseInsensitive(raw = "") {
  const value = String(raw || "").trim();
  if (!value) return "";
  const direct = loadUser(value);
  if (direct?.username) return String(direct.username || "").trim() || value;
  const lower = value.toLowerCase();
  try {
    const files = fs.readdirSync(USERS_DIR).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const username = path.basename(file, ".json");
      if (String(username || "").toLowerCase() === lower) {
        return username;
      }
    }
  } catch {}
  return "";
}

function userByEmailCaseInsensitive(raw = "") {
  const email = String(raw || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return "";
  try {
    const files = fs.readdirSync(USERS_DIR).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const username = path.basename(file, ".json");
      const u = loadUser(username);
      const profileEmail = String(u?.profile?.email || "").trim().toLowerCase();
      if (profileEmail && profileEmail === email) {
        return String(u?.username || username || "").trim();
      }
    }
  } catch {}
  return "";
}

function normalizePhoneDigits(raw = "") {
  return String(raw || "").replace(/\D/g, "");
}

function userByPhone(raw = "") {
  const targetDigits = normalizePhoneDigits(raw);
  if (!targetDigits) return "";
  try {
    const files = fs.readdirSync(USERS_DIR).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const username = path.basename(file, ".json");
      const u = loadUser(username);
      const profile = u?.profile || {};
      const localDigits = normalizePhoneDigits(profile?.phoneLocal || "");
      const codeDigits = normalizePhoneDigits(profile?.phoneCountryCode || "");
      const combined = `${codeDigits}${localDigits}`;
      const fallback = normalizePhoneDigits(profile?.phone || "");
      const fullDigits = combined || fallback;
      if (!fullDigits) continue;
      if (fullDigits === targetDigits || localDigits === targetDigits) {
        return String(u?.username || username || "").trim();
      }
    }
  } catch {}
  return "";
}

function resolveGuestTransferTargetUsername(payload = {}) {
  const fromUsername = String(payload?.targetUsername || payload?.recipientUsername || "").trim();
  const directUser = userExistsCaseInsensitive(fromUsername);
  if (directUser) return directUser;

  const fromEmail = String(payload?.targetEmail || payload?.recipientEmail || "").trim().toLowerCase();
  const directEmail = userByEmailCaseInsensitive(fromEmail);
  if (directEmail) return directEmail;

  const fromPhone = String(payload?.targetPhone || payload?.recipientPhone || "").trim();
  const directPhone = userByPhone(fromPhone);
  if (directPhone) return directPhone;

  const identifierRaw = String(payload?.targetIdentifier || payload?.recipient || "").trim();
  if (!identifierRaw) return "";
  let identifier = identifierRaw;
  let kind = "";
  const colon = identifierRaw.indexOf(":");
  if (colon > 0) {
    kind = identifierRaw.slice(0, colon).trim().toLowerCase();
    identifier = identifierRaw.slice(colon + 1).trim();
  }

  if (kind === "email") {
    return userByEmailCaseInsensitive(identifier);
  }
  if (kind === "username") {
    return userExistsCaseInsensitive(identifier);
  }
  if (kind === "phone") {
    return userByPhone(identifier);
  }

  if (identifier.startsWith("@")) identifier = identifier.slice(1);
  if (/^\+?[\d\s().-]{7,}$/.test(identifier)) {
    const phoneUser = userByPhone(identifier);
    if (phoneUser) return phoneUser;
  }
  if (identifier.includes("@")) {
    return userByEmailCaseInsensitive(identifier);
  }
  return userExistsCaseInsensitive(identifier);
}

function normalizeGuestTransferRequest(raw = {}, targetUsername = "") {
  const target = String(targetUsername || raw?.targetUsername || "").trim();
  const requestId = String(raw?.id || "").trim() || randomUUID();
  const code = normalizeQuickChatCode(raw?.code || "");
  const threadId = String(raw?.threadId || "").trim().slice(0, 128);
  const shareUrl = String(raw?.shareUrl || "").trim().slice(0, 2000);
  if (!target || !code || !threadId || !shareUrl) return null;

  const now = Date.now();
  const createdAt = Number(raw?.createdAt || now) || now;
  const expiresAtRaw = Number(raw?.expiresAt || (createdAt + GUEST_TRANSFER_REQUEST_TTL_MS));
  const expiresAt = Number.isFinite(expiresAtRaw) ? Math.max(createdAt + 60 * 1000, expiresAtRaw) : (createdAt + GUEST_TRANSFER_REQUEST_TTL_MS);

  return {
    id: requestId,
    targetUsername: target,
    threadId,
    code,
    shareUrl,
    threadName: String(raw?.threadName || "").trim().slice(0, 80),
    recipient: String(raw?.recipient || "").trim().slice(0, 120),
    fromGuestDisplayName: String(raw?.fromGuestDisplayName || "Guest").trim().slice(0, 60) || "Guest",
    fromGuestSessionId: String(raw?.fromGuestSessionId || "").trim().slice(0, 120),
    createdAt,
    expiresAt
  };
}

function pruneGuestTransferRequests() {
  const now = Date.now();
  let dirty = false;
  Object.keys(guestTransferRequestsByUser).forEach((username) => {
    const current = Array.isArray(guestTransferRequestsByUser[username]) ? guestTransferRequestsByUser[username] : [];
    const next = current
      .map((item) => normalizeGuestTransferRequest(item, username))
      .filter((item) => item && Number(item.expiresAt || 0) > now);
    if (!next.length) {
      if (current.length) dirty = true;
      delete guestTransferRequestsByUser[username];
      return;
    }
    if (next.length !== current.length) dirty = true;
    guestTransferRequestsByUser[username] = next;
  });
  if (dirty) {
    saveGuestTransferRequestsIndex();
  }
}

function listGuestTransferRequestsForUser(username = "") {
  const name = String(username || "").trim();
  if (!name) return [];
  pruneGuestTransferRequests();
  const rows = Array.isArray(guestTransferRequestsByUser[name]) ? guestTransferRequestsByUser[name] : [];
  return rows
    .map((item) => normalizeGuestTransferRequest(item, name))
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function getUserDisplayName(username = "") {
  const user = loadUser(username);
  const profile = user?.profile || {};
  const first = String(profile.firstName || "").trim();
  const last = String(profile.lastName || "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  const legacy = String(profile.name || "").trim();
  if (legacy) return legacy;
  return String(username || "").trim() || "User";
}

function withGuestBaseUrl(urlPath = "") {
  const raw = String(urlPath || "").trim();
  if (!raw) return "";
  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).toString();
    }
    if (!GUEST_APP_BASE_URL) return raw;
    return new URL(raw, GUEST_APP_BASE_URL).toString();
  } catch {
    return raw;
  }
}

function buildGuestOpenUrlForUser(request, username = "") {
  const base = withGuestBaseUrl(request?.shareUrl || `/guest?code=${encodeURIComponent(String(request?.code || ""))}`);
  if (!base) return "";
  try {
    const url = new URL(base);
    if (!url.searchParams.get("name")) {
      url.searchParams.set("name", getUserDisplayName(username));
    }
    return url.toString();
  } catch {
    return base;
  }
}

function sendGuestTransferRequestsUpdate(username = "") {
  const name = String(username || "").trim();
  if (!name) return false;
  return sendToUser(name, {
    type: "guest_transfer_requests",
    incoming: listGuestTransferRequestsForUser(name)
  });
}

function queueGuestTransferRequest(raw = {}) {
  const target = userExistsCaseInsensitive(raw?.targetUsername || "");
  if (!target) return { ok: false, error: "Recipient not found" };
  const normalized = normalizeGuestTransferRequest(raw, target);
  if (!normalized) return { ok: false, error: "Invalid request payload" };

  const list = Array.isArray(guestTransferRequestsByUser[target]) ? guestTransferRequestsByUser[target] : [];
  const existingIdx = list.findIndex((item) => String(item?.threadId || "") === normalized.threadId);
  if (existingIdx >= 0) {
    list[existingIdx] = {
      ...list[existingIdx],
      ...normalized,
      createdAt: Number(list[existingIdx]?.createdAt || normalized.createdAt) || normalized.createdAt
    };
  } else {
    list.push(normalized);
  }
  guestTransferRequestsByUser[target] = list
    .map((item) => normalizeGuestTransferRequest(item, target))
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, 200);
  saveGuestTransferRequestsIndex();
  sendGuestTransferRequestsUpdate(target);
  // Push banners are reserved for real message/file delivery intents.
  // Quick-transfer request rows update in-app via websocket + badge only.
  return { ok: true, targetUsername: target, request: normalized };
}

function resolveGuestTransferRequestForUser(username = "", requestId = "", action = "") {
  const name = String(username || "").trim();
  const id = String(requestId || "").trim();
  const decision = String(action || "").trim().toLowerCase();
  if (!name || !id || !["accept", "decline"].includes(decision)) {
    return { ok: false, error: "Invalid request" };
  }
  const list = Array.isArray(guestTransferRequestsByUser[name]) ? guestTransferRequestsByUser[name] : [];
  const idx = list.findIndex((item) => String(item?.id || "") === id);
  if (idx < 0) {
    return { ok: false, error: "Request not found" };
  }
  const [request] = list.splice(idx, 1);
  if (list.length) guestTransferRequestsByUser[name] = list;
  else delete guestTransferRequestsByUser[name];
  saveGuestTransferRequestsIndex();
  sendGuestTransferRequestsUpdate(name);
  return {
    ok: true,
    action: decision,
    request,
    openUrl: decision === "accept" ? buildGuestOpenUrlForUser(request, name) : "",
    threadId: String(request?.threadId || "").trim(),
    code: normalizeQuickChatCode(request?.code || ""),
    threadName: String(request?.threadName || "").trim(),
    recipient: String(request?.recipient || "").trim(),
    shareUrl: String(request?.shareUrl || "").trim(),
    createdAt: Number(request?.createdAt || 0) || 0,
    expiresAt: Number(request?.expiresAt || 0) || 0
  };
}

function clearGuestTransferRequestsForUser(username = "") {
  const name = String(username || "").trim();
  if (!name) return;
  if (!guestTransferRequestsByUser[name]) return;
  delete guestTransferRequestsByUser[name];
  saveGuestTransferRequestsIndex();
}

function friendsListPayload(userRecord) {
  const user = ensureUserShape(userRecord);
  return {
    type: "friends_list",
    friends: user.friends || [],
    deletedFriends: user.deletedFriends || [],
    onlineUsers: Array.from(online.keys()),
    chatState: chatStateForClient(user),
    quickChats: quickChatsStateForClient(user),
    fileHolder: fileHolderStateForClient(user)
  };
}

function sendFriendsList(ws, userRecord = null) {
  if (!ws) return false;
  let user = userRecord;
  if (!user && ws.username) {
    user = loadUser(ws.username);
  }
  if (!user) {
    return send(ws, {
      type: "friends_list",
      friends: [],
      deletedFriends: [],
      onlineUsers: Array.from(online.keys()),
      chatState: { version: 1, updatedAt: Date.now(), order: [], manualUnread: [], pins: [], nicknames: {}, chatAliases: {} },
      quickChats: { version: 1, updatedAt: Date.now(), chats: [], pins: [] },
      fileHolder: { version: 1, updatedAt: Date.now(), items: [] }
    });
  }
  return send(ws, friendsListPayload(user));
}

function broadcastFriendsListForUserAndFriends(username) {
  const name = String(username || "").trim();
  if (!name) return;
  const u0 = loadUser(name);
  if (!u0) return;
  const user = ensureUserShape(u0);
  const targets = new Set([name, ...(user.friends || [])]);
  targets.forEach((target) => {
    const sockets = getOnlineSocketsForUser(target);
    if (!sockets.length) return;
    sockets.forEach((sock) => sendFriendsList(sock));
  });
}

function queueIntentDeletionForUser(username, payload) {
  const name = String(username || "").trim();
  const intentId = String(payload?.intentId || "").trim();
  if (!name || !intentId) return;

  const u0 = loadUser(name);
  if (!u0) return;
  const user = ensureUserShape(u0);
  const list = Array.isArray(user.deletedIntents) ? user.deletedIntents : [];
  if (!list.some((entry) => String(entry?.intentId || "") === intentId)) {
    list.push({
      intentId,
      storedFile: payload?.storedFile || null,
      from: payload?.from || null,
      to: payload?.to || null,
      deletedAt: Date.now()
    });
  }
  user.deletedIntents = list.slice(-5000);
  saveUser(user);
}

function flushQueuedIntentDeletions(ws, userRecord) {
  if (!ws?.username) return;
  const base = userRecord || loadUser(ws.username);
  if (!base) return;
  const user = ensureUserShape(base);
  const queued = Array.isArray(user.deletedIntents) ? user.deletedIntents.filter(Boolean) : [];
  if (queued.length) {
    send(ws, { type: "deleted_intents", items: queued });
    user.deletedIntents = [];
    saveUser(user);
  }
}

function addFriendSymmetric(a, b) {
  const ua0 = loadUser(a);
  const ub0 = loadUser(b);
  if (!ua0 || !ub0) return { ok: false, error: "User not found" };

  const ua = ensureUserShape(ua0);
  const ub = ensureUserShape(ub0);

  if (!ua.friends.includes(b)) ua.friends.push(b);
  if (!ub.friends.includes(a)) ub.friends.push(a);

  saveUser(ua);
  saveUser(ub);
  // New contacts should surface immediately at the top (below pins) on every device.
  touchUserChatOrder(a, b);
  touchUserChatOrder(b, a);
  return { ok: true, a: ua, b: ub };
}




wss.on("connection", (ws, req) => {
  try { ws?._socket?.setNoDelay(true); } catch {}
  try { ws?._socket?.setKeepAlive(true, 15_000); } catch {}

  const endpoint = getPublicEndpoint(req);
ws.publicIp = endpoint.ip;
ws.publicPort = endpoint.port;

console.log("🌍 Client public endpoint:", ws.publicIp, ws.publicPort);


  console.log("🔌 WebSocket client connected");

  ws.username = null;

  ws.on("message", async (msg, isBinary) => {
    try {


  // ============================
  // BINARY FILE CHUNKS (from Alice)
  // ============================
    if (isBinary) {
    const intentId = ws.currentUploadIntentId;
    if (!intentId) {
      console.log("⚠️ Binary received but no active upload");
      return;
    }

    const t = activeTransfers.get(intentId);
    if (!t) {
      console.log("⚠️ No active transfer for intent", intentId);
      return;
    }

    // If sender streams more than expected, fail fast.
    const incomingLen = msg.length;
    if (t.bytesSent + incomingLen > t.bytesExpected) {
      console.log("❌ Too many bytes for intent", intentId);
      failActiveTransfer(intentId, "Upload exceeded expected size", {
        preservePartial: false,
        deleteIntent: false,
        retryable: true
      });
      ws.currentUploadIntentId = null;
      return send(ws, { type: "error", message: "Upload exceeded expected size" });
    }

    // OFFLINE MODE: write to disk
    if (t.mode === "offline") {
      if (!t.writeStream) {
        console.log("❌ Offline transfer missing writeStream", intentId);
        failActiveTransfer(intentId, "Server not ready for upload");
        return send(ws, { type: "error", message: "Server not ready for offline upload" });
      }

      const ok = t.writeStream.write(msg);
      t.bytesSent += incomingLen;
      t.lastActivityAt = Date.now();

      if (!ok) {
        pauseWsInbound(ws);
        t.writeStream.once("drain", () => resumeWsInbound(ws));
      }

      maybeSendUploadProgress(t);

      if (!t.nextLogBytes) t.nextLogBytes = 64 * 1024 * 1024;
      if (t.bytesSent >= t.nextLogBytes) {
        console.log(`💾 Stored ${t.bytesSent}/${t.bytesExpected} bytes`);
        t.nextLogBytes += 64 * 1024 * 1024;
      }

      // Safety net: if all bytes arrived but upload_end is lost,
      // finalize automatically so large uploads never stay stuck.
      if (t.bytesSent === t.bytesExpected && !t.finalizing && !t.autoFinalizeTimer) {
        t.autoFinalizeTimer = setTimeout(() => {
          const current = activeTransfers.get(intentId);
          if (!current || current !== t) return;
          if (current.mode !== "offline" || current.finalizing) return;
          if (current.bytesSent !== current.bytesExpected) return;
          console.warn(`ℹ️ Auto-finalizing upload_end for ${intentId}`);
          finalizeOfflineTransfer(intentId, current, ws, { auto: true });
        }, 1200);
      }
      return;
    }

    // LIVE MODE: forward to TCP (existing behavior)
    if (!t.tcp) {
      console.log("⏳ Binary received but TCP not connected yet");
      return;
    }

    const ok = t.tcp.write(msg);
    t.bytesSent += incomingLen;
    t.lastActivityAt = Date.now();

    if (!ok) {
      pauseWsInbound(ws);
      t.tcp.once("drain", () => resumeWsInbound(ws));
    }

    maybeSendUploadProgress(t);

    if (!t.nextLogBytes) t.nextLogBytes = 64 * 1024 * 1024;
    if (t.bytesSent >= t.nextLogBytes) {
      console.log(`➡️ Forwarded ${t.bytesSent}/${t.bytesExpected} bytes`);
      t.nextLogBytes += 64 * 1024 * 1024;
    }

    return;
  }

  
  let data;
    try {
      data = JSON.parse(msg.toString());
      if (!["ping", "inbox_request", "friends_list", "friend_requests", "guest_transfer_requests", "groups_list", "typing", "chat_state_request", "chat_state_update", "quick_chats_request", "quick_chats_update", "file_holder_request", "file_holder_update"].includes(String(data?.type || ""))) {
        console.log("📩 Message received:", data);
      }
    } catch {
      return; // Ignore malformed JSON
    }

    // 🔐 AUTH GUARD: Allow signup/login/ping, block everything else if not logged in
    const publicTypes = ["auth_signup", "auth_login", "auth_resume", "ping"];

    if (!ws.username && !publicTypes.includes(data.type)) {
      console.log("🛑 Blocked unauthorized message:", data.type);
      return send(ws, { type: "error", message: "Not logged in" });
    }


    // =========================
// 🗑️ DELETE ACCOUNT
// =========================
if (data.type === "delete_account") {
  const username = ws.username;
  if (!username) {
    return send(ws, { type: "error", message: "Not logged in" });
  }

  const affectedGroupMembers = removeUserFromGroups(username);

  unregisterOnlineSocket(username, ws);

  // Mark as deleted in other users' lists
  try {
    const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const p = path.join(USERS_DIR, file);
      const u = ensureUserShape(JSON.parse(fs.readFileSync(p, "utf8")));
      if (u.username === username) continue;

      if (u.friends.includes(username) && !u.deletedFriends.includes(username)) {
        u.deletedFriends.push(username);
      }
      u.incomingRequests = u.incomingRequests.filter(n => n !== username);
      u.outgoingRequests = u.outgoingRequests.filter(n => n !== username);
      u.declinedRequests = u.declinedRequests.filter(n => n !== username);
      saveUser(u);

      const sockets = getOnlineSocketsForUser(u.username);
      if (sockets.length) {
        sockets.forEach((sock) => sendFriendsList(sock, u));
        sendFriendRequestsUpdate(u.username);
      }
    }
  } catch (err) {
    console.error("❌ Failed to mark deleted in other users:", err);
  }

  // Delete user file
  const userPath = path.join(USERS_DIR, `${username}.json`);
  try {
    const selfUser = loadUser(username);
    if (selfUser) {
      const shaped = ensureUserShape(selfUser);
      const entries = sanitizeFileHolderEntries((shaped.fileHolderState || {}).items || []);
      entries.forEach((entry) => {
        removeFileHolderStoredEntry(entry);
      });
    }
    if (fs.existsSync(userPath)) fs.unlinkSync(userPath);
  } catch (err) {
    console.error("❌ Failed to delete user file:", err);
  }
  clearGuestTransferRequestsForUser(username);

  // Remove all active sessions for this account.
  const userSockets = getOnlineSocketsForUser(username);
  userSockets.forEach((sock) => {
    try { sock.close(4002, "Account deleted"); } catch {}
    unregisterOnlineSocket(username, sock);
  });
  online.delete(username);
  onlineSockets.delete(username);
  broadcastGroupsListToMembers(affectedGroupMembers);

  // Acknowledge + disconnect
  send(ws, { type: "account_deleted" });
  ws.close();

  console.log(`🗑️ Account deleted: ${username}`);
  return;
}



// =========================
// 🔐 AUTH: SIGNUP
// =========================
if (data.type === "auth_signup") {
  const username = String(data.username || "").trim();
  const password = String(data.password || "");
  const signupName = String(data.name || "").trim();
  const signupFirst = String(data.firstName || "").trim();
  const signupLast = String(data.lastName || "").trim();
  const signupEmail = String(data.email || "").trim();

  if (!username) return send(ws, { type: "error", message: "Missing username" });
  if (!password || password.length < 6) {
    return send(ws, { type: "error", message: "Password must be at least 6 chars" });
  }

  if (loadUser(username)) {
    return send(ws, { type: "error", message: "Username already exists" });
  }
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
  return send(ws, { type: "error", message: "Invalid username format" });
}


  const passwordHash = bcrypt.hashSync(password, 12);

  let firstName = signupFirst;
  let lastName = signupLast;
  if ((!firstName || !lastName) && signupName) {
    const parts = signupName.split(/\s+/).filter(Boolean);
    if (!firstName && parts.length) firstName = parts[0];
    if (!lastName && parts.length > 1) lastName = parts.slice(1).join(" ");
  }
  const profile = {};
  if (firstName) profile.firstName = firstName;
  if (lastName) profile.lastName = lastName;
  if (signupEmail) profile.email = signupEmail;
  if (signupName) profile.name = signupName;

  const user = {
  username,
  passwordHash,
  friends: [username], // 👈 add self
  groups: [],
  incomingRequests: [],
  outgoingRequests: [],
  declinedRequests: [],
  profile,
  createdAt: Date.now(),
  chatState: {
    version: 1,
    updatedAt: Date.now(),
    order: [username],
    manualUnread: [],
    pins: [username]
  },
  quickChatsState: {
    version: 1,
    updatedAt: Date.now(),
    chats: [],
    pins: []
  },
  fileHolderState: {
    version: 1,
    updatedAt: Date.now(),
    items: []
  },
  sessionTokens: [],
};



  saveUser(user);

  return send(ws, { type: "signup_ok", username });
}

if (data.type === "auth_resume") {
  const username = String(data.username || "").trim();
  const token = String(data.sessionToken || "");
  const client = String(data.client || "unknown");

  const user = ensureUserShape(loadUser(username));
  if (!user || !user.sessionTokens?.includes(token)) {
    return send(ws, { type: "error", message: "Session expired" });
  }
  touchUserSessionToken(user, token);

  // ✅ Upgrade old accounts: ensure self is in friends list
user.friends = Array.isArray(user.friends) ? user.friends : [];
if (!user.friends.includes(user.username)) {
  user.friends.push(user.username);
  saveUser(user);
}


  ws.username = username;
  ws.client = client;
  ws.isAdmin = isAdminUsername(username);
  registerOnlineSocket(username, ws);

  send(ws, {
    type: "login_ok",
    username,
    sessionToken: token,
    resumed: true,
    client: ws.client,
    isAdmin: Boolean(ws.isAdmin),
  });

  const pending = loadIntentsForUser(username);
  send(ws, { type: "inbox", items: pending });

  const u2 = ensureUserShape(user);
  saveUser(u2);
  flushQueuedIntentDeletions(ws, u2);
  sendFriendsList(ws, u2);
  send(ws, { type: "profiles", profiles: loadProfiles(u2.friends || []) });
  send(ws, { type: "friend_requests", incoming: u2.incomingRequests, outgoing: u2.outgoingRequests, declined: u2.declinedRequests });
  send(ws, { type: "guest_transfer_requests", incoming: listGuestTransferRequestsForUser(username) });
  sendGroupsList(ws, username);
  send(ws, { type: "chat_state", state: chatStateForClient(u2) });
  send(ws, { type: "quick_chats", state: quickChatsStateForClient(u2) });
  send(ws, { type: "file_holder", state: fileHolderStateForClient(u2) });
  broadcastFriendsListForUserAndFriends(username);

  return;
}




// =========================
// 🔐 AUTH: LOGIN (password)
// =========================
if (data.type === "auth_login") {
  const username = String(data.username || "").trim();
  const password = String(data.password || "");
  const client = String(data.client || "unknown");

  // ───────────────────────────
  // Validate input
  // ───────────────────────────
  if (!username) {
    return send(ws, { type: "error", message: "Missing username" });
  }
  if (!password) {
    return send(ws, { type: "error", message: "Missing password" });
  }

  // ───────────────────────────
  // Load user + verify password
  // ───────────────────────────
  const user = loadUser(username);
if (!user) {
  return send(ws, { type: "error", message: "Invalid username or password" });
}

// ✅ Upgrade old accounts: ensure self is in friends list
user.friends = Array.isArray(user.friends) ? user.friends : [];
if (!user.friends.includes(user.username)) {
  user.friends.push(user.username);
  saveUser(user);
}


  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) {
    return send(ws, { type: "error", message: "Invalid username or password" });
  }

  // ───────────────────────────
  // Bind user to this socket
  // ───────────────────────────
  ws.username = username;
  ws.client = client;
  ws.isAdmin = isAdminUsername(username);
  ws.tcpPort = Number(data.tcpPort || 0);
  ws.candidates = Array.isArray(data.candidates) ? data.candidates : [];

  registerOnlineSocket(username, ws);

  // ───────────────────────────
  // Issue persistent session token
  // ───────────────────────────
  const token = generateSessionToken();

  user.sessionTokens = Array.isArray(user.sessionTokens)
    ? user.sessionTokens
    : [];

  touchUserSessionToken(user, token);

  saveUser(user);

  // ───────────────────────────
  // Login success
  // ───────────────────────────
  send(ws, {
    type: "login_ok",
    username,
    sessionToken: token,
    publicIp: ws.publicIp,
    publicPort: ws.publicPort,
    client: ws.client,
    isAdmin: Boolean(ws.isAdmin),
  });

  // ───────────────────────────
  // Send inbox
  // ───────────────────────────
  const pending = loadIntentsForUser(username);
  send(ws, {
    type: "inbox",
    items: pending.length ? pending : [],
  });

  // ───────────────────────────
  // Send friends list
  // ───────────────────────────
  const u2 = ensureUserShape(loadUser(username));
  saveUser(u2);
  flushQueuedIntentDeletions(ws, u2);
  sendFriendsList(ws, u2);
  send(ws, {
    type: "profiles",
    profiles: loadProfiles(u2.friends || [])
  });
  send(ws, {
    type: "friend_requests",
    incoming: u2.incomingRequests || [],
    outgoing: u2.outgoingRequests || [],
    declined: u2.declinedRequests || [],
  });
  send(ws, { type: "guest_transfer_requests", incoming: listGuestTransferRequestsForUser(username) });
  sendGroupsList(ws, username);
  send(ws, { type: "chat_state", state: chatStateForClient(u2) });
  send(ws, { type: "quick_chats", state: quickChatsStateForClient(u2) });
  send(ws, { type: "file_holder", state: fileHolderStateForClient(u2) });
  broadcastFriendsListForUserAndFriends(username);

  return;
}




// 1) login (LEGACY DEV ONLY)
// Use auth_login for real accounts.
if (data.type === "login") {
  if (process.env.ALLOW_LEGACY_LOGIN !== "1") {
    return send(ws, { type: "error", message: "Use auth_login (accounts enabled)" });
  }

  const name = String(data.username || "").trim();
  if (!name) return send(ws, { type: "error", message: "Missing username" });
  if (online.has(name)) return send(ws, { type: "error", message: "Username already online" });

  ws.username = name;
  ws.client = String(data.client || "unknown");
  ws.isAdmin = isAdminUsername(name);
  ws.tcpPort = Number(data.tcpPort || 0);
  ws.candidates = Array.isArray(data.candidates) ? data.candidates : [];

  online.set(name, ws);

  send(ws, {
    type: "login_ok",
    username: name,
    publicIp: ws.publicIp,
    publicPort: ws.publicPort,
    client: ws.client,
    isAdmin: Boolean(ws.isAdmin),
  });

  const pending = loadIntentsForUser(name);
  send(ws, { type: "inbox", items: pending });
  send(ws, { type: "guest_transfer_requests", incoming: listGuestTransferRequestsForUser(name) });
  broadcastFriendsListForUserAndFriends(name);

  return;
}


// =========================
// 🌐 WEB DOWNLOAD OVER WEBSOCKET (NEW)
// =========================
if (data.type === "download_ws_request") {
  const intentId = String(data.intentId || "");
  if (!intentId) return send(ws, { type: "error", message: "Missing intentId" });

  const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
  if (!fs.existsSync(intentFile)) {
    return send(ws, { type: "error", message: "Intent not found", intentId });
  }

  const intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
  if (intent.to !== ws.username && intent.from !== ws.username) {
    return send(ws, { type: "error", message: "Not authorized for this intent", intentId });
  }
  if (!hasStoredAsset(intent)) {
    return send(ws, { type: "error", message: "File not stored on server", intentId });
  }

  // Tell browser what's coming
  send(ws, {
    type: "download_ws_begin",
    intentId,
    name: intent.fileName,
    size: intent.fileSize,
  });

  const storedObjectKey = String(intent.storedObjectKey || "").trim();
  const rs = storedObjectKey && objectStorage.isEnabled()
    ? ((await objectStorage.getObjectStream(storedObjectKey))?.body || null)
    : (() => {
        const filePath = path.join(FILES_DIR, String(intent.storedFile || "").trim());
        return fs.existsSync(filePath)
          ? fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })
          : null;
      })();
  if (!rs) {
    return send(ws, { type: "error", message: "Stored file missing", intentId });
  }

  rs.on("data", (chunk) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true });
    }
  });

  rs.on("end", () => {
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, { type: "download_ws_end", intentId });
    }
  });

  rs.on("error", (err) => {
    console.log("❌ download_ws stream error:", err);
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, { type: "error", message: "Download failed" });
    }
  });

  return;
}

// =========================
// 🗑️ DELETE STORED FILE / INTENT (NEW)
// =========================
if (data.type === "delete_intent") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) {
    return send(ws, { type: "error", message: "Missing intentId" });
  }

  const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
  if (!fs.existsSync(intentFile)) {
    return send(ws, { type: "error", message: "Intent not found" });
  }

  let intent;
  try {
    intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
  } catch {
    return send(ws, { type: "error", message: "Intent corrupted" });
  }

  // 🔒 Authorization: only recipient can delete
  if (intent.to !== ws.username) {
    return send(ws, { type: "error", message: "Not authorized" });
  }

  // 🗑️ Delete stored file if it exists
  deleteStoredAssetForIntent(intent);

  // 🗑️ Delete intent JSON
  try {
    fs.unlinkSync(intentFile);
  } catch (err) {
    console.error("❌ Failed to delete intent:", err);
  }

  deleteIntentAndNotify(intent);

  // 🧠 Remove from in-memory inbox (if loaded)
  const inbox = inboxes.get(ws.username);
  if (inbox) {
    inboxes.set(
      ws.username,
      inbox.filter(i => i.id !== intentId)
    );
  }

  console.log(`🗑️ Deleted intent ${intentId} for ${ws.username}`);

  // ✅ Ack client
  send(ws, { type: "delete_ok", intentId });
  return;
}


// =========================
// 📥 iOS DOWNLOAD REQUEST (MISSING — ADD THIS)
// =========================
if (data.type === "download_request") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) return send(ws, { type: "error", message: "Missing intentId" });

  const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
  if (!fs.existsSync(intentFile)) {
    return send(ws, { type: "error", message: "Intent not found" });
  }

  let intent;
  try {
    intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
  } catch {
    return send(ws, { type: "error", message: "Intent corrupted" });
  }

  // 🔒 Only recipient can request download
  if (intent.to !== ws.username) {
    return send(ws, { type: "error", message: "Not authorized" });
  }

  if (!hasStoredAsset(intent)) {
    return send(ws, { type: "error", message: "File not stored on server" });
  }

  // Mark intent as waiting for download, then ask iOS to open TCP
  intent._downloadWaiting = true;
  saveIntent(intent);

  send(ws, { type: "prepare_transfer", intentId });
  return;
}




// ✅ iOS tells us which TCP port it is listening on
if (data.type === "ready") {
  ws.tcpPort = Number(data.port);
  const readyIntentId = String(data.intentId || "").trim();

  console.log(`📡 ${ws.username} ready on TCP port ${ws.tcpPort}` + (readyIntentId ? ` for intent ${readyIntentId}` : ""));

  // 🔒 STRICT: ready must be tied to exactly one intent
  if (!readyIntentId) {
    console.warn("⚠️ ready received without intentId — ignoring to prevent unintended sends");
    return;
  }

  // Load intents from disk (authoritative)
  const inbox = loadIntentsForUser(ws.username);

  // 🔒 Safety: if this intent is already stored, never auto-send it on ready
const intentOnDisk = inbox.find(i => i.id === readyIntentId);
if (intentOnDisk?.stored) {
  console.warn("⚠️ ready for stored intent — ignoring auto-send", readyIntentId);
  return;
}





  // =========================
  // 🔽 DOWNLOAD PATH (NEW)
  // =========================
    const downloadIntent = inbox.find(i => i.id === readyIntentId && i._downloadWaiting);


  if (downloadIntent) {
    delete downloadIntent._downloadWaiting;
    saveIntent(downloadIntent);

    let host = ws.publicIp;
    if (host.startsWith("::ffff:")) host = host.replace("::ffff:", "");

    const filePath = await ensureIntentStoredFilePath(downloadIntent);
    if (!filePath) {
      console.error("❌ Download source missing for intent:", downloadIntent.id);
      return;
    }
    const stats = fs.statSync(filePath);

    console.log(`🔌 TCP connect for download ${host}:${ws.tcpPort}`);

    const tcp = net.createConnection(
      { host, port: ws.tcpPort },
      () => {
        tcp.write(JSON.stringify({
          name: downloadIntent.fileName,
          size: stats.size
        }) + "\n");

        console.log("📤 Download header sent");

        fs.createReadStream(filePath).pipe(tcp);
      }
    );

    tcp.on("close", () => {
      console.log(`✅ Download complete ${downloadIntent.id}`);
      downloadIntent.status = "completed";
      saveIntent(downloadIntent);
    });

    tcp.on("error", err => {
      console.error("❌ Download TCP error:", err);
    });

    return;
  }

  // =========================
  // 🔼 LIVE UPLOAD PATH (EXISTING)
  // =========================

  // Find pending intent waiting for this receiver
   const intent = inbox.find(i => i.id === readyIntentId && i.status === "pending" && i._waitingForReady && !i.stored);


  if (!intent) return;

  const transferMsg = {
    type: "start_transfer",
    intent,
    receiver: {
      host: ws.publicIp,
      port: ws.tcpPort,
    },
  };

  const t = activeTransfers.get(intent.id);
  if (!t || t.ended) {
    console.log("⚠️ No active upload for ready intent");
    return;
  }
  const sender = t.senderWs && t.senderWs.readyState === WebSocket.OPEN ? t.senderWs : null;
  if (!sender) {
    console.log("⚠️ Sender socket is no longer available for live transfer");
    failActiveTransfer(intent.id, "Sender disconnected", { deleteIntent: false, retryable: true });
    return;
  }

  let host = ws.publicIp;
  if (host.startsWith("::ffff:")) host = host.replace("::ffff:", "");

  console.log(`🔌 TCP connect to iOS ${host}:${ws.tcpPort}`);

  const tcp = net.createConnection(
    { host, port: ws.tcpPort },
    () => {
      t.lastActivityAt = Date.now();
      tcp.write(JSON.stringify({
        name: intent.fileName,
        size: intent.fileSize
      }) + "\n");

      console.log("🔌 TCP connected & header sent");

      send(sender, {
        type: "upload_ok",
        intentId: intent.id,
        resumeFrom: 0,
        bytesExpected: Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0),
        plainBytesExpected: Number(intent.fileSize || 0)
      });
      console.log("✅ upload_ok sent");
    }
  );

  t.tcp = tcp;
  t.lastActivityAt = Date.now();

  tcp.on("error", err => {
    console.error("❌ TCP error:", err);
    failActiveTransfer(intent.id, "Receiver connection failed");
  });

  // 🔥 NOW start transfer (correct timing)
  send(sender, transferMsg);
  send(ws, transferMsg);

  // Cleanup flag
  delete intent._waitingForReady;
  intent.status = "in_progress";

  return;
}


    // 🔓 Allow ping before login (keepalive / handshake safety)
if (data.type === "ping") {
  send(ws, { type: "pong" });
  return;
}

if (data.type === "typing") {
  const to = String(data.to || "").trim();
  if (!to || to === ws.username) return;

  const sender = ensureUserShape(loadUser(ws.username));
  if (!sender?.friends?.includes(to)) return;

  if (!isUserOnline(to)) return;
  sendToUser(to, {
    type: "typing",
    from: ws.username,
    isTyping: Boolean(data.isTyping),
    hasText: Boolean(data.hasText),
    hasFiles: Boolean(data.hasFiles),
    at: Date.now()
  });
  return;
}

// =========================
// 🌐 WebRTC Signaling (P2P)
// =========================
if (data.type === "webrtc_offer") {
  const to = String(data.to || "").trim();
  const intentId = String(data.intentId || "").trim();
  if (!to || !intentId || !data.sdp) {
    return send(ws, { type: "error", message: "Missing webrtc_offer fields" });
  }
  const intent = loadIntent(intentId);
  if (!intent || intent.from !== ws.username || intent.to !== to) {
    return send(ws, { type: "error", message: "Invalid intent for WebRTC" });
  }
  const receiver = online.get(to);
  if (!receiver) {
    return send(ws, { type: "webrtc_unavailable", intentId });
  }
  return send(receiver, {
    type: "webrtc_offer",
    from: ws.username,
    intentId,
    sdp: data.sdp
  });
}

if (data.type === "webrtc_answer") {
  const to = String(data.to || "").trim();
  const intentId = String(data.intentId || "").trim();
  if (!to || !intentId || !data.sdp) {
    return send(ws, { type: "error", message: "Missing webrtc_answer fields" });
  }
  const intent = loadIntent(intentId);
  if (!intent || intent.to !== ws.username || intent.from !== to) {
    return send(ws, { type: "error", message: "Invalid intent for WebRTC" });
  }
  const sender = online.get(to);
  if (!sender) return;
  return send(sender, {
    type: "webrtc_answer",
    from: ws.username,
    intentId,
    sdp: data.sdp
  });
}

if (data.type === "webrtc_ice") {
  const to = String(data.to || "").trim();
  const intentId = String(data.intentId || "").trim();
  if (!to || !intentId || !data.candidate) {
    return send(ws, { type: "error", message: "Missing webrtc_ice fields" });
  }
  const intent = loadIntent(intentId);
  if (!intent || (intent.from !== ws.username && intent.to !== ws.username)) {
    return send(ws, { type: "error", message: "Invalid intent for WebRTC" });
  }
  const peer = online.get(to);
  if (!peer) return;
  return send(peer, {
    type: "webrtc_ice",
    from: ws.username,
    intentId,
    candidate: data.candidate
  });
}

if (data.type === "webrtc_cancel") {
  const to = String(data.to || "").trim();
  const intentId = String(data.intentId || "").trim();
  if (!to || !intentId) return;
  const peer = online.get(to);
  if (!peer) return;
  return send(peer, { type: "webrtc_cancel", intentId });
}





// =========================
// 👥 FRIEND REQUESTS: SEND
// =========================
if (data.type === "friend_request_send") {
  const target = String(data.username || "").trim();
  if (!target) return send(ws, { type: "error", message: "Missing username" });
  if (target === ws.username) return send(ws, { type: "error", message: "You cannot add yourself" });

  const me0 = loadUser(ws.username);
  const other0 = loadUser(target);
  if (!me0 || !other0) return send(ws, { type: "error", message: "User not found" });

  const me = ensureUserShape(me0);
  const other = ensureUserShape(other0);

  if (me.friends.includes(target)) {
    return send(ws, { type: "error", message: "Already friends" });
  }

  if (me.incomingRequests.includes(target)) {
    return send(ws, { type: "error", message: "You already have a request from this user" });
  }

  if (!other.incomingRequests.includes(ws.username)) {
    other.incomingRequests.push(ws.username);
  }
  if (!me.outgoingRequests.includes(target)) {
    me.outgoingRequests.push(target);
  }
  me.declinedRequests = me.declinedRequests.filter(n => n !== target);

  saveUser(me);
  saveUser(other);

  sendFriendRequestsUpdate(ws.username);
  sendFriendRequestsUpdate(target);
  return;
}

// =========================
// 👥 FRIEND REQUESTS: ACCEPT
// =========================
if (data.type === "friend_request_accept") {
  const requester = String(data.username || "").trim();
  if (!requester) return send(ws, { type: "error", message: "Missing username" });

  const me0 = loadUser(ws.username);
  const other0 = loadUser(requester);
  if (!me0 || !other0) return send(ws, { type: "error", message: "User not found" });

  const me = ensureUserShape(me0);
  const other = ensureUserShape(other0);

  if (!me.incomingRequests.includes(requester)) {
    return send(ws, { type: "error", message: "Request not found" });
  }

  me.incomingRequests = me.incomingRequests.filter(n => n !== requester);
  other.outgoingRequests = other.outgoingRequests.filter(n => n !== ws.username);
  saveUser(me);
  saveUser(other);

  const res = addFriendSymmetric(ws.username, requester);
  if (!res.ok) return send(ws, { type: "error", message: res.error });

  // Push updated friends list to both sides if online
  const meUpdated = ensureUserShape(loadUser(ws.username));
  sendFriendsList(ws, meUpdated);

  const otherUpdated = ensureUserShape(loadUser(requester));
  const requesterSockets = getOnlineSocketsForUser(requester);
  requesterSockets.forEach((sock) => sendFriendsList(sock, otherUpdated));

  sendFriendRequestsUpdate(ws.username);
  sendFriendRequestsUpdate(requester);
  return;
}

// =========================
// 👥 FRIEND REQUESTS: DENY
// =========================
if (data.type === "friend_request_deny") {
  const requester = String(data.username || "").trim();
  if (!requester) return send(ws, { type: "error", message: "Missing username" });

  const me0 = loadUser(ws.username);
  const other0 = loadUser(requester);
  if (!me0 || !other0) return send(ws, { type: "error", message: "User not found" });

  const me = ensureUserShape(me0);
  const other = ensureUserShape(other0);

  me.incomingRequests = me.incomingRequests.filter(n => n !== requester);
  other.outgoingRequests = other.outgoingRequests.filter(n => n !== ws.username);
  if (!other.declinedRequests.includes(ws.username)) {
    other.declinedRequests.push(ws.username);
  }
  saveUser(me);
  saveUser(other);

  sendFriendRequestsUpdate(ws.username);
  sendFriendRequestsUpdate(requester);
  return;
}



// =========================
// 👥 FRIEND REQUESTS: CLEAR DECLINED
// =========================
if (data.type === "friend_request_clear_declined") {
  const target = String(data.username || "").trim();
  if (!target) return send(ws, { type: "error", message: "Missing username" });

  const me0 = loadUser(ws.username);
  if (!me0) return send(ws, { type: "error", message: "User not found" });

  const me = ensureUserShape(me0);
  me.declinedRequests = me.declinedRequests.filter(n => n !== target);
  saveUser(me);

  sendFriendRequestsUpdate(ws.username);
  return;
}


// =========================
// 📊 STATS
// =========================
if (data.type === "stats") {
  if (!isAdminSocket(ws)) {
    return send(ws, { type: "error", message: "Forbidden" });
  }
  sendStatsSnapshot(ws);
  return;
}

if (data.type === "storage_stats") {
  return send(ws, {
    type: "storage_stats",
    ...buildUserStoragePayload(ws.username)
  });
}

// =========================
// 📬 INBOX SYNC
// =========================
if (data.type === "inbox_request") {
  const now = Date.now();
  const force = Boolean(data.force);
  if (!force) {
    const lastTs = Number(ws._lastInboxRequestTs || 0);
    if (lastTs && (now - lastTs) < INBOX_REQUEST_MIN_INTERVAL_MS) {
      return;
    }
  }
  ws._lastInboxRequestTs = now;
  const items = loadIntentsForUser(ws.username);
  return send(ws, { type: "inbox", items });
}

if (data.type === "chat_state_request") {
  const u0 = loadUser(ws.username);
  if (!u0) {
    return send(ws, {
      type: "chat_state",
      state: { version: 1, updatedAt: Date.now(), order: [], manualUnread: [], pins: [], nicknames: {}, chatAliases: {} }
    });
  }
  const user = ensureUserShape(u0);
  saveUser(user);
  return send(ws, { type: "chat_state", state: chatStateForClient(user) });
}

if (data.type === "chat_state_update") {
  const u0 = loadUser(ws.username);
  if (!u0) return send(ws, { type: "error", message: "User not found" });
  const updatesRaw = data.updates && typeof data.updates === "object"
    ? data.updates
    : (data.state && typeof data.state === "object" ? data.state : {});

  const result = updateUserChatState(ws.username, (draft, user) => {
    const allowed = buildAllowedChatKeysForUser(user);
    let changed = false;

    if (Array.isArray(updatesRaw.pins)) {
      const pins = sanitizeChatStateKeys(updatesRaw.pins).filter((key) => allowed.has(key));
      if (!sameStringList(draft.pins, pins)) {
        draft.pins = pins;
        changed = true;
      }
    }

    if (Array.isArray(updatesRaw.manualUnread)) {
      const manual = sanitizeChatStateKeys(updatesRaw.manualUnread).filter((key) => allowed.has(key));
      if (!sameStringList(draft.manualUnread, manual)) {
        draft.manualUnread = manual;
        changed = true;
      }
    }

    if (Array.isArray(updatesRaw.order)) {
      const order = sanitizeChatStateKeys(updatesRaw.order).filter((key) => allowed.has(key));
      if (!sameStringList(draft.order, order)) {
        draft.order = order;
        changed = true;
      }
    }

    if (updatesRaw.nicknames && typeof updatesRaw.nicknames === "object" && !Array.isArray(updatesRaw.nicknames)) {
      const nicknames = sanitizeContactNicknamesMap(updatesRaw.nicknames, user);
      if (JSON.stringify(draft.nicknames || {}) !== JSON.stringify(nicknames || {})) {
        draft.nicknames = nicknames;
        changed = true;
      }
    }

    if (updatesRaw.chatAliases && typeof updatesRaw.chatAliases === "object" && !Array.isArray(updatesRaw.chatAliases)) {
      const aliases = sanitizeChatAliasesMap(updatesRaw.chatAliases, user);
      if (JSON.stringify(draft.chatAliases || {}) !== JSON.stringify(aliases || {})) {
        draft.chatAliases = aliases;
        changed = true;
      }
    }

    const touchKey = normalizeChatStateKey(updatesRaw.touchChatKey || "");
    if (touchKey && allowed.has(touchKey)) {
      const nextOrder = [touchKey, ...draft.order.filter((entry) => entry !== touchKey)];
      if (!sameStringList(draft.order, nextOrder)) {
        draft.order = nextOrder;
        changed = true;
      }
    }

    if (updatesRaw.markUnread && typeof updatesRaw.markUnread === "object") {
      const markKey = normalizeChatStateKey(updatesRaw.markUnread.chatKey || "");
      const unread = Boolean(updatesRaw.markUnread.unread);
      if (markKey && allowed.has(markKey)) {
        const has = draft.manualUnread.includes(markKey);
        if (unread && !has) {
          draft.manualUnread.push(markKey);
          changed = true;
        } else if (!unread && has) {
          draft.manualUnread = draft.manualUnread.filter((entry) => entry !== markKey);
          changed = true;
        }
      }
    }

    if (Array.isArray(updatesRaw.removeKeys)) {
      const removeSet = new Set(sanitizeChatStateKeys(updatesRaw.removeKeys));
      if (removeSet.size) {
        const nextOrder = draft.order.filter((entry) => !removeSet.has(entry));
        const nextUnread = draft.manualUnread.filter((entry) => !removeSet.has(entry));
        const nextPins = draft.pins.filter((entry) => !removeSet.has(entry));
        const nextAliases = { ...(draft.chatAliases || {}) };
        removeSet.forEach((key) => { delete nextAliases[key]; });
        const nextNicknames = { ...(draft.nicknames || {}) };
        removeSet.forEach((key) => {
          if (!String(key || "").includes(":")) delete nextNicknames[key];
        });
        if (!sameStringList(draft.order, nextOrder) ||
            !sameStringList(draft.manualUnread, nextUnread) ||
            !sameStringList(draft.pins, nextPins) ||
            JSON.stringify(draft.chatAliases || {}) !== JSON.stringify(nextAliases || {}) ||
            JSON.stringify(draft.nicknames || {}) !== JSON.stringify(nextNicknames || {})) {
          draft.order = nextOrder;
          draft.manualUnread = nextUnread;
          draft.pins = nextPins;
          draft.chatAliases = nextAliases;
          draft.nicknames = nextNicknames;
          changed = true;
        }
      }
    }

    return changed;
  });

  if (!result) return send(ws, { type: "error", message: "Could not update chat state" });
  if (!result.changed) {
    return send(ws, { type: "chat_state", state: result.state });
  }
  return send(ws, { type: "chat_state_ack", version: Number(result.state?.version || 1) });
}

if (data.type === "quick_chats_request") {
  const u0 = loadUser(ws.username);
  if (!u0) {
    return send(ws, {
      type: "quick_chats",
      state: { version: 1, updatedAt: Date.now(), chats: [], pins: [] }
    });
  }
  const user = ensureUserShape(u0);
  saveUser(user);
  return send(ws, { type: "quick_chats", state: quickChatsStateForClient(user) });
}

if (data.type === "quick_chats_update") {
  const u0 = loadUser(ws.username);
  if (!u0) return send(ws, { type: "error", message: "User not found" });
  const updatesRaw = data.updates && typeof data.updates === "object"
    ? data.updates
    : (data.state && typeof data.state === "object" ? data.state : {});

  const result = updateUserQuickChatsState(ws.username, (draft) => {
    let changed = false;

    if (Array.isArray(updatesRaw.replace)) {
      const next = sanitizeQuickChatEntries(updatesRaw.replace);
      if (!sameQuickChatEntries(draft.chats, next)) {
        draft.chats = next;
        changed = true;
      }
    }

    const upsertEntry = normalizeQuickChatEntry(updatesRaw.upsert || null);
    if (upsertEntry) {
      const idx = draft.chats.findIndex((entry) => String(entry?.id || "") === upsertEntry.id);
      if (idx >= 0) {
        const merged = { ...draft.chats[idx], ...upsertEntry };
        if (!sameQuickChatEntries([draft.chats[idx]], [merged])) {
          draft.chats[idx] = merged;
          changed = true;
        }
      } else {
        draft.chats.unshift(upsertEntry);
        changed = true;
      }
    }

    const removeIds = new Set(
      [
        String(updatesRaw.removeId || "").trim(),
        ...((Array.isArray(updatesRaw.removeIds) ? updatesRaw.removeIds : []).map((raw) => String(raw || "").trim()))
      ].filter(Boolean)
    );
    if (removeIds.size) {
      const nextChats = draft.chats.filter((entry) => !removeIds.has(String(entry?.id || "").trim()));
      const nextPins = draft.pins.filter((key) => !removeIds.has(String(key || "").trim().replace(/^quick:/i, "")));
      if (!sameQuickChatEntries(nextChats, draft.chats) || !sameStringList(nextPins, draft.pins)) {
        draft.chats = nextChats;
        draft.pins = nextPins;
        changed = true;
      }
    }

    if (Array.isArray(updatesRaw.pins)) {
      const nextPins = sanitizeQuickChatPinKeys(updatesRaw.pins, draft.chats);
      if (!sameStringList(draft.pins, nextPins)) {
        draft.pins = nextPins;
        changed = true;
      }
    }

    return changed;
  });

  if (!result) return send(ws, { type: "error", message: "Could not update quick chats" });
  if (!result.changed) {
    return send(ws, { type: "quick_chats", state: result.state });
  }
  return send(ws, { type: "quick_chats_ack", version: Number(result.state?.version || 1) });
}

if (data.type === "file_holder_request") {
  const u0 = loadUser(ws.username);
  if (!u0) {
    return send(ws, {
      type: "file_holder",
      state: { version: 1, updatedAt: Date.now(), items: [] }
    });
  }
  const user = ensureUserShape(u0);
  saveUser(user);
  return send(ws, { type: "file_holder", state: fileHolderStateForClient(user) });
}

if (data.type === "file_holder_update") {
  const u0 = loadUser(ws.username);
  if (!u0) return send(ws, { type: "error", message: "User not found" });
  const updatesRaw = data.updates && typeof data.updates === "object"
    ? data.updates
    : (data.state && typeof data.state === "object" ? data.state : {});

  const result = updateUserFileHolderState(ws.username, (draft) => {
    let changed = false;

    if (Boolean(updatesRaw.clear) && draft.length) {
      draft.length = 0;
      changed = true;
    }

    const removeIds = new Set(
      [
        String(updatesRaw.removeId || "").trim(),
        ...((Array.isArray(updatesRaw.removeIds) ? updatesRaw.removeIds : []).map((raw) => String(raw || "").trim()))
      ].filter(Boolean)
    );
    if (removeIds.size) {
      const next = draft.filter((entry) => !removeIds.has(String(entry?.id || "").trim()));
      if (!sameFileHolderEntries(next, draft)) {
        draft.length = 0;
        next.forEach((entry) => draft.push(entry));
        changed = true;
      }
    }

    if (Array.isArray(updatesRaw.orderIds) && updatesRaw.orderIds.length > 0 && draft.length > 1) {
      const order = updatesRaw.orderIds.map((raw) => String(raw || "").trim()).filter(Boolean);
      const ranking = new Map();
      order.forEach((id, idx) => {
        if (!ranking.has(id)) ranking.set(id, idx);
      });
      const next = draft.slice().sort((a, b) => {
        const aId = String(a?.id || "").trim();
        const bId = String(b?.id || "").trim();
        const aRank = ranking.has(aId) ? Number(ranking.get(aId)) : Number.MAX_SAFE_INTEGER;
        const bRank = ranking.has(bId) ? Number(ranking.get(bId)) : Number.MAX_SAFE_INTEGER;
        if (aRank !== bRank) return aRank - bRank;
        return Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0);
      });
      if (!sameFileHolderEntries(next, draft)) {
        draft.length = 0;
        next.forEach((entry) => draft.push(entry));
        changed = true;
      }
    }

    return changed;
  });

  if (!result) return send(ws, { type: "error", message: "Could not update file holder" });
  if (!result.changed) {
    return send(ws, { type: "file_holder", state: result.state });
  }
  return send(ws, { type: "file_holder_ack", version: Number(result.state?.version || 1) });
}

if (data.type === "intent_access_request") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) {
    return send(ws, { type: "error", message: "Missing intentId" });
  }

  const intent = loadIntent(intentId);
  if (!intent) {
    return send(ws, { type: "intent_access", intentId, intent: null });
  }

  const canAccess = intent.from === ws.username || intent.to === ws.username;
  if (!canAccess) {
    return send(ws, { type: "intent_access", intentId, intent: null });
  }

  if (!intent.downloadToken && !(intent.isTextOnly || intent.messageType === "text")) {
    intent.downloadToken = generateDownloadToken();
    saveIntent(intent);
  }

  return send(ws, {
    type: "intent_access",
    intentId,
    intent: {
      id: intent.id,
      intentId: intent.id,
      from: String(intent.from || ""),
      to: String(intent.to || ""),
      groupId: String(intent.groupId || ""),
      fileName: intent.fileName || "",
      fileSize: Number(intent.fileSize || 0),
      uploadBytesExpected: Number(intent.uploadBytesExpected || intent.fileSize || 0),
      createdAt: Number(intent.createdAt || 0),
      expiresAt: Number(intent.expiresAt || 0),
      downloadToken: intent.downloadToken || null,
      stored: Boolean(intent.stored),
      status: intent.status || "",
      transferState: intent.transferState || (intent.readByRecipientAt ? "read" : (intent.stored ? "delivered" : "queued")),
      encryption: intent.encryption || null,
      passwordProtected: isIntentPasswordProtected(intent),
      passwordMode: getIntentPasswordMode(intent),
      passwordHint: String(intent.passwordHint || ""),
      customExpiry: hasIntentCustomExpiry(intent),
      isTextOnly: Boolean(intent.isTextOnly || intent.messageType === "text")
    }
  });
}

// =========================
// 👁️ READ RECEIPTS
// =========================
if (data.type === "read_receipt") {
  const friend = String(data.friend || "").trim();
  const intentIds = normalizeIntentIdList(data.intentIds);
  if (!friend || !intentIds.length) return;

  const now = Date.now();
  const updates = [];

  for (const intentId of intentIds) {
    const intent = loadIntent(intentId);
    if (!intent) continue;
    if (intent.to !== ws.username) continue;
    if (intent.from !== friend) continue;
    if (!intent.stored) continue;

    const priorReadAt = Number(intent.readByRecipientAt || 0);
    if (!priorReadAt || priorReadAt < now) {
      intent.readByRecipientAt = now;
      intent.transferState = "read";
      intent.status = "completed";
      saveIntent(intent);
    }
    updates.push({
      intentId,
      readAt: intent.readByRecipientAt || now
    });
  }

  if (!updates.length) return;
  sendToUser(friend, {
    type: "read_receipt",
    from: ws.username,
    intents: updates
  });
  sendToUser(ws.username, {
    type: "read_receipt_sync",
    friend,
    intents: updates
  });
  broadcastInboxSnapshot(ws.username);
  updates.forEach((entry) => {
    const intent = loadIntent(entry.intentId);
    if (!intent) return;
    emitTransferState(intent, "read", {
      sentBytes: Number(intent.storedBytes || resolveUploadExpectedBytes(intent) || 0),
      totalBytes: Number(resolveUploadExpectedBytes(intent) || 0),
      plainSentBytes: Number(intent.plainStoredBytes || intent.fileSize || 0),
      plainTotalBytes: Number(intent.fileSize || 0)
    });
  });
  return;
}


// =========================
// 👥 FRIENDS: REMOVE
// =========================
if (data.type === "remove_friend") {
  const target = String(data.username || "").trim();
  if (!target) return send(ws, { type: "error", message: "Missing username" });

  const me0 = loadUser(ws.username);
  if (!me0) return send(ws, { type: "error", message: "User not found" });

  const me = ensureUserShape(me0);
  me.friends = (me.friends || []).filter(n => n !== target);
  me.deletedFriends = (me.deletedFriends || []).filter(n => n !== target);
  me.incomingRequests = (me.incomingRequests || []).filter(n => n !== target);
  me.outgoingRequests = (me.outgoingRequests || []).filter(n => n !== target);
  me.declinedRequests = (me.declinedRequests || []).filter(n => n !== target);
  saveUser(me);
  removeChatKeyFromUserState(ws.username, target);

  sendFriendsList(ws, me);
  sendFriendRequestsUpdate(ws.username);
  return;
}


// =========================
// 🗑️ DELETE STORED FILE (ADMIN)
// =========================
if (data.type === "delete_file") {
  if (!isAdminSocket(ws)) {
    return send(ws, { type: "error", message: "Forbidden" });
  }
  const storedFile = String(data.storedFile || "").trim();
  if (!storedFile) return send(ws, { type: "error", message: "Missing storedFile" });

  try {
    deleteStoredFileAndNotify(storedFile);
  } catch (err) {
    return send(ws, { type: "error", message: "Failed to delete file" });
  }

  sendStatsSnapshot(ws);
  return;
}

if (data.type === "delete_files") {
  if (!isAdminSocket(ws)) {
    return send(ws, { type: "error", message: "Forbidden" });
  }
  const storedFiles = Array.isArray(data.storedFiles) ? data.storedFiles : [];
  if (!storedFiles.length) return send(ws, { type: "error", message: "No files specified" });

  for (const rawStoredFile of storedFiles) {
    const storedFile = String(rawStoredFile || "").trim();
    if (!storedFile) continue;
    try { deleteStoredFileAndNotify(storedFile); } catch {}
  }

  sendStatsSnapshot(ws);
  return;
}

if (data.type === "cancel_send") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) return send(ws, { type: "error", message: "Missing intentId" });

  const intent = loadIntent(intentId);
  if (!intent) {
    return send(ws, { type: "cancel_send_ok", intentId, status: "not_found" });
  }
  if (intent.from !== ws.username) {
    return send(ws, { type: "error", message: "Not authorized" });
  }

  const transfer = activeTransfers.get(intentId) || null;
  const status = String(intent.status || "");
  const canCancel = Boolean(transfer) || status === "pending" || status === "uploading" || !intent.stored;
  if (!canCancel) {
    return send(ws, { type: "cancel_send_ok", intentId, status: "ignored" });
  }

  if (transfer) {
    failActiveTransfer(intentId, "Upload canceled by sender", {
      notify: false,
      deleteIntent: false,
      suppressState: true
    });
  } else if (ws.currentUploadIntentId === intentId) {
    ws.currentUploadIntentId = null;
  }

  const storedFileName = String(intent.storedFile || "").trim();
  if (storedFileName || intent.storedObjectKey) {
    deleteStoredAssetForIntent(intent);
  }

  emitTransferState(intent, "canceled", {
    sentBytes: Number(intent.storedBytes || 0),
    totalBytes: Number(resolveUploadExpectedBytes(intent) || 0),
    plainSentBytes: Number(intent.plainStoredBytes || 0),
    plainTotalBytes: Number(intent.fileSize || 0),
    retryable: false,
    message: "Canceled by sender"
  });
  deleteIntentAndNotify(intent);
  send(ws, { type: "cancel_send_ok", intentId, status: "canceled" });
  sendStatsSnapshot(ws);
  return;
}

if (data.type === "delete_message_everyone") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) return send(ws, { type: "error", message: "Missing intentId" });

  const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
  if (!fs.existsSync(intentFile)) {
    return send(ws, { type: "error", message: "Intent not found" });
  }

  let intent;
  try { intent = JSON.parse(fs.readFileSync(intentFile, "utf8")); } catch {
    return send(ws, { type: "error", message: "Intent corrupted" });
  }

  if (intent.from !== ws.username && intent.to !== ws.username) {
    return send(ws, { type: "error", message: "Not authorized" });
  }

  const transfer = activeTransfers.get(intentId) || null;
  if (transfer) {
    failActiveTransfer(intentId, "Deleted by user", {
      notify: false,
      deleteIntent: false,
      suppressState: true
    });
  } else if (ws.currentUploadIntentId === intentId) {
    ws.currentUploadIntentId = null;
  }

  deleteStoredAssetForIntent(intent);

  deleteIntentAndNotify(intent);
  send(ws, { type: "delete_message_everyone_ok", intentId, status: "deleted" });

  sendStatsSnapshot(ws);
  return;
}

// =========================
// 👥 FRIENDS: LIST
// =========================
if (data.type === "friends_list") {
  const u0 = loadUser(ws.username);
if (!u0) return sendFriendsList(ws, null);

const user = ensureUserShape(u0);
sendFriendsList(ws, user);
send(ws, { type: "profiles", profiles: loadProfiles(user.friends || []) });
return;
}

if (data.type === "groups_list") {
  sendGroupsList(ws, ws.username);
  return;
}

if (data.type === "friend_requests") {
  sendFriendRequestsUpdate(ws.username);
  return;
}

if (data.type === "guest_transfer_requests") {
  sendGuestTransferRequestsUpdate(ws.username);
  return;
}

if (data.type === "guest_transfer_request_respond") {
  const requestId = String(data.requestId || "").trim();
  const action = String(data.action || "").trim().toLowerCase();
  if (!requestId) return send(ws, { type: "error", message: "Missing requestId" });
  if (!["accept", "decline"].includes(action)) {
    return send(ws, { type: "error", message: "Invalid response action" });
  }
  const resolved = resolveGuestTransferRequestForUser(ws.username, requestId, action);
  if (!resolved.ok) {
    return send(ws, { type: "error", message: resolved.error || "Could not resolve request" });
  }
  send(ws, {
    type: "guest_transfer_request_responded",
    requestId,
    action,
    openUrl: resolved.openUrl || "",
    threadId: resolved.threadId || "",
    code: resolved.code || "",
    threadName: resolved.threadName || "",
    recipient: resolved.recipient || "",
    shareUrl: resolved.shareUrl || "",
    createdAt: Number(resolved.createdAt || 0) || 0,
    expiresAt: Number(resolved.expiresAt || 0) || 0
  });
  return;
}

if (data.type === "group_create") {
  const meName = String(ws.username || "").trim();
  const me0 = loadUser(meName);
  if (!me0) return send(ws, { type: "error", message: "User not found" });
  const me = ensureUserShape(me0);

  const requestedMembers = normalizeGroupMembers(data.members || []);
  const membersSet = new Set([meName]);
  requestedMembers.forEach((member) => {
    if (!member || member === meName) return;
    if (!me.friends.includes(member)) return;
    if (!loadUser(member)) return;
    membersSet.add(member);
  });
  const members = Array.from(membersSet);
  if (members.length < 2) {
    return send(ws, { type: "error", message: "Select at least one contact to create a group" });
  }
  if (members.length > 64) {
    return send(ws, { type: "error", message: "Group limit is 64 members" });
  }

  const groupName = normalizeGroupName(data.name || "");
  if (!groupName) {
    return send(ws, { type: "error", message: "Group name is required" });
  }

  const group = {
    id: randomUUID(),
    name: groupName,
    createdBy: meName,
    members,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  if (!saveGroup(group)) {
    return send(ws, { type: "error", message: "Could not create group" });
  }
  const createdGroupChatKey = groupChatKey(group.id);

  members.forEach((member) => {
    const u0 = loadUser(member);
    if (!u0) return;
    const u = ensureUserShape(u0);
    if (!u.groups.includes(group.id)) {
      u.groups.push(group.id);
      saveUser(u);
    }
    if (createdGroupChatKey) {
      touchUserChatOrder(member, createdGroupChatKey);
    }
  });

  broadcastGroupsListToMembers(members);
  return send(ws, { type: "group_created", group: groupForClient(group) });
}

if (data.type === "group_rename") {
  const meName = String(ws.username || "").trim();
  const groupId = String(data.groupId || "").trim();
  const nextName = normalizeGroupName(data.name || "");
  if (!meName) return send(ws, { type: "error", message: "Not logged in" });
  if (!groupId) return send(ws, { type: "error", message: "Missing group id" });
  if (!nextName) return send(ws, { type: "error", message: "Group name is required" });

  const group = loadGroup(groupId);
  if (!group) return send(ws, { type: "error", message: "Group not found" });
  if (!group.members.includes(meName)) {
    return send(ws, { type: "error", message: "You are not a member of this group" });
  }

  const prevName = normalizeGroupName(group.name || "");
  if (prevName === nextName) {
    return send(ws, { type: "group_renamed", group: groupForClient(group), renamedBy: meName });
  }

  group.name = nextName;
  group.updatedAt = Date.now();
  if (!saveGroup(group)) {
    return send(ws, { type: "error", message: "Could not rename group" });
  }

  const systemText = `${meName} changed the chat name to ${nextName}`;
  emitGroupSystemMessage(group, meName, systemText, group.updatedAt);
  broadcastGroupsListToMembers(group.members);
  group.members.forEach((member) => {
    sendToUser(member, {
      type: "group_renamed",
      group: groupForClient(group),
      renamedBy: meName,
      text: systemText
    });
  });
  return;
}

// =========================
// 👤 PROFILE UPDATE
// =========================
if (data.type === "update_profile") {
  const u0 = loadUser(ws.username);
  if (!u0) return send(ws, { type: "error", message: "User not found" });

  const user = ensureUserShape(u0);
  const profile = user.profile || {};
  const sanitizePinnedContacts = (value) => {
    const seen = new Set();
    return (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter((item) => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
      })
      .slice(0, 500);
  };

  const updates = data.profile || {};
  if (typeof updates.firstName === "string") profile.firstName = updates.firstName;
  if (typeof updates.lastName === "string") profile.lastName = updates.lastName;
  if (typeof updates.email === "string") profile.email = updates.email;
  if (typeof updates.phone === "string") profile.phone = updates.phone;
  if (typeof updates.phoneCountryCode === "string") profile.phoneCountryCode = updates.phoneCountryCode;
  if (typeof updates.phoneLocal === "string") profile.phoneLocal = updates.phoneLocal;
  if (typeof updates.avatarDataUrl === "string") profile.avatarDataUrl = updates.avatarDataUrl;
  if (Array.isArray(updates.pinnedContacts)) {
    profile.pinnedContacts = sanitizePinnedContacts(updates.pinnedContacts);
  }
  if (updates.e2eePublicKeyJwk && typeof updates.e2eePublicKeyJwk === "object") {
    const jwk = updates.e2eePublicKeyJwk;
    const kty = String(jwk.kty || "").toUpperCase();
    const n = String(jwk.n || "");
    const e = String(jwk.e || "");
    if (kty === "RSA" && n && e && n.length < 4096 && e.length < 64) {
      profile.e2eePublicKeyJwk = { kty: "RSA", n, e, alg: "RSA-OAEP-256", ext: true };
    }
  }

  user.profile = profile;
  saveUser(user);

  // notify self + friends
  sendToUser(ws.username, { type: "profile_update", username: ws.username, profile });
  const friends = user.friends || [];
  friends.forEach((f) => {
    if (!f || f === ws.username) return;
    sendToUser(f, { type: "profile_update", username: ws.username, profile });
  });
  return;
}

// =========================
// 👥 FRIENDS: ADD (symmetric)
// =========================
if (data.type === "add_friend") {
  const friend = String(data.username || "").trim();
  if (!friend) return send(ws, { type: "error", message: "Missing friend username" });
  const res = addFriendSymmetric(ws.username, friend);
  if (!res.ok) return send(ws, { type: "error", message: res.error });

  // Push updated friends list to both sides if online
  const me = ensureUserShape(loadUser(ws.username));
  sendFriendsList(ws, me);

  const other = ensureUserShape(loadUser(friend));
  const friendSockets = getOnlineSocketsForUser(friend);
  friendSockets.forEach((sock) => sendFriendsList(sock, other));

  return;
}


// ============================
// DIRECT OBJECT UPLOAD PROGRESS
// ============================
if (data.type === "upload_progress") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) return;
  const intent = loadIntent(intentId);
  if (!intent) return;
  if (intent.from !== ws.username) return;
  if (!intent.storedObjectKey || !objectStorage.isEnabled()) return;
  const transferState = String(intent.transferState || "").trim().toLowerCase();
  if (
    intent.stored ||
    transferState === "delivered" ||
    transferState === "read" ||
    transferState === "failed" ||
    transferState === "canceled"
  ) {
    // Ignore late progress packets once intent reached a terminal state.
    return;
  }
  const nowTs = Date.now();
  const expectedBytes = Number(resolveUploadExpectedBytes(intent) || intent.fileSize || 0);
  const sentCandidate = Math.max(0, Number(data.sentBytes || 0));
  const sentBytes = Math.max(
    0,
    Math.max(Number(intent.storedBytes || 0), Math.min(sentCandidate, expectedBytes || sentCandidate))
  );
  const previousCheckpointBytes = Math.max(0, Number(intent.storedBytes || 0));
  const previousCheckpointTs = Math.max(0, Number(intent.updatedAt || 0));
  const checkpointDueByBytes =
    sentBytes >= expectedBytes ||
    (sentBytes - previousCheckpointBytes) >= UPLOAD_CHECKPOINT_EVERY_BYTES;
  const checkpointDueByTime =
    sentBytes >= expectedBytes ||
    (nowTs - previousCheckpointTs) >= UPLOAD_CHECKPOINT_MIN_INTERVAL_MS;
  if (checkpointDueByBytes && checkpointDueByTime) {
    updateIntentUploadCheckpoint(intent, sentBytes, {
      status: "uploading",
      transferState: "uploading"
    });
  }
  emitTransferState(intent, "uploading", {
    sentBytes,
    totalBytes: expectedBytes,
    plainSentBytes: uploadBytesToPlainBytes(intent, sentBytes),
    plainTotalBytes: Number(intent.fileSize || 0)
  });

  if (
    expectedBytes > 0 &&
    sentBytes >= expectedBytes &&
    !intent.stored &&
    String(intent.transferState || "").toLowerCase() !== "delivered"
  ) {
    const head = await objectStorage.headObject(intent.storedObjectKey).catch(() => null);
    const headSize = Math.max(0, Number(head?.size || 0));
    if (head && headSize === expectedBytes) {
      finalizeObjectUploadIntent(intent, headSize, expectedBytes);
    }
  }
  return;
}

// ============================
// FILE UPLOAD BEGIN (Alice → Server)
// ============================
if (data.type === "upload_begin") {
  const intentId = String(data.intentId || "").trim();
  const name = String(data.name || "").trim();
  const size = Number(data.size || 0);

  if (!intentId || !name || !size) {
    return send(ws, { type: "error", message: "Missing upload_begin fields" });
  }

  const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
if (!fs.existsSync(intentFile)) {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "Intent not found" });
}

let intent;
try {
  intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
} catch {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "Intent JSON corrupted" });
}

if (intent.from !== ws.username) {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "Not sender" });
}

const expectedBytes = resolveUploadExpectedBytes(intent);
if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "Intent has invalid upload size" });
}
if (size !== expectedBytes) {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "Upload size does not match intent", intentId });
}

if (hasStoredAsset(intent) && String(intent.transferState || "") !== "uploading") {
  ws.currentUploadIntentId = null;
  return send(ws, {
    type: "upload_ok",
    intentId,
    resumeFrom: expectedBytes,
    bytesExpected: expectedBytes,
    plainBytesExpected: Number(intent.fileSize || 0),
    alreadyStored: true
  });
}

const existingTransfer = activeTransfers.get(intentId);
if (existingTransfer && existingTransfer.senderWs && existingTransfer.senderWs !== ws) {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "Another upload is already active for this file", intentId });
}
if (existingTransfer && existingTransfer.senderWs === ws) {
  if (existingTransfer.mode === "live" && !existingTransfer.tcp) {
    ws.currentUploadIntentId = intentId;
    return send(ws, {
      type: "error",
      intentId,
      retryable: true,
      message: "Upload is waiting for receiver readiness"
    });
  }
  ws.currentUploadIntentId = intentId;
  const resumeFrom = Math.max(0, Math.min(Number(existingTransfer.bytesSent || 0), expectedBytes));
  return send(ws, {
    type: "upload_ok",
    intentId,
    resumeFrom,
    bytesExpected: expectedBytes,
    plainBytesExpected: Number(intent.fileSize || 0),
    resumedExisting: true
  });
}

  // Always set current upload ID first (race-safe for binary frames)
  ws.currentUploadIntentId = intentId;

  let receiverWs = online.get(intent.to);

// 🔥 ONLY iOS SENDERS CAN DO LIVE TCP
if (ws.client !== "ios" || !receiverWs || receiverWs.client !== "ios") {
  receiverWs = null;
}



  // =========================
  // OFFLINE PATH (NEW)
  // =========================
  if (!receiverWs) {
    const safeName = safeBasename(name);
    await clearIntentObjectUploadSession(intent, { abortRemote: true });
    if (intent.storedObjectKey && objectStorage.isEnabled()) {
      try { await objectStorage.deleteObject(intent.storedObjectKey); } catch {}
      intent.storedObjectKey = null;
    }
    removeIntentCachedObjectFile(intent.id);
    const storedFileName = String(intent.storedFile || "").trim() || `${intentId}__${safeName}`;
    const filePath = path.join(FILES_DIR, storedFileName);
    let existingBytes = 0;
    try {
      const stat = fs.statSync(filePath);
      existingBytes = Number(stat?.size || 0);
    } catch {}

    let resumeFrom = alignResumeOffset(intent, existingBytes);
    if (!Number.isFinite(resumeFrom) || resumeFrom < 0) resumeFrom = 0;
    if (resumeFrom > expectedBytes) resumeFrom = 0;
    if (existingBytes !== resumeFrom) {
      try { fs.truncateSync(filePath, resumeFrom); } catch {}
      existingBytes = resumeFrom;
    }

    const streamFlags = resumeFrom > 0 ? "a" : "w";

    // Create write stream for raw bytes
    const writeStream = fs.createWriteStream(filePath, {
      flags: streamFlags,
      highWaterMark: OFFLINE_UPLOAD_STREAM_HWM_BYTES, // tuned for high-throughput offline uploads
    });


    writeStream.on("error", (err) => {
      console.error("❌ File writeStream error:", err);
      failActiveTransfer(intentId, "Server failed writing file", {
        preservePartial: true,
        deleteIntent: false,
        retryable: true
      });
      ws.currentUploadIntentId = null;
    });

    activeTransfers.set(intentId, {
      mode: "offline",
      tcp: null,
      senderWs: ws,
      writeStream,
      filePath,
      bytesExpected: expectedBytes,
      bytesSent: resumeFrom,
      ended: false,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      lastCheckpointBytes: resumeFrom,
      intent, // ✅ ADD THIS
    });


// Persist linkage but DO NOT mark stored until upload_end finishes
intent.stored = false;
intent.storedFile = storedFileName;
intent.storedObjectKey = null;
intent.objectUploadSession = null;
intent.storedBytes = resumeFrom;
intent.plainStoredBytes = uploadBytesToPlainBytes(intent, resumeFrom);
intent.status = "uploading";
intent.transferState = "uploading";
saveIntent(intent);
emitTransferState(intent, "uploading", {
  sentBytes: resumeFrom,
  totalBytes: expectedBytes,
  plainSentBytes: uploadBytesToPlainBytes(intent, resumeFrom),
  plainTotalBytes: Number(intent.fileSize || 0)
});

// ✅ let sender start streaming immediately
send(ws, {
  type: "upload_ok",
  intentId,
  resumeFrom,
  bytesExpected: expectedBytes,
  plainBytesExpected: Number(intent.fileSize || 0)
});



    console.log(`💾 Offline upload_begin: storing to ${storedFileName} (resumeFrom=${resumeFrom})`);
    return;
  }

  // =========================
  // LIVE PATH (EXISTING)
  // =========================

  // Ask receiver to prepare TCP now
  send(receiverWs, {
    type: "prepare_transfer",
    intentId,
  });

  intent._waitingForReady = true;
saveIntent(intent);

activeTransfers.set(intentId, {
  mode: "live",
  tcp: null,
  senderWs: ws,
  bytesExpected: expectedBytes,
  bytesSent: 0,
  ended: false,
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  intent, // ✅ ADD THIS
});

emitTransferState(intent, "uploading", {
  sentBytes: 0,
  totalBytes: expectedBytes,
  plainSentBytes: 0,
  plainTotalBytes: Number(intent.fileSize || 0)
});


return;

}


// ============================
// FILE UPLOAD END
// ============================
if (data.type === "upload_end") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) return send(ws, { type: "error", message: "Missing intentId" });

  const t = activeTransfers.get(intentId);
  if (!t) {
    ws.currentUploadIntentId = null;
    const intent = loadIntent(intentId);
    if (!intent) {
      return send(ws, { type: "error", message: "Intent not found", intentId });
    }
    if (intent.from !== ws.username) {
      return send(ws, { type: "error", message: "Not sender", intentId });
    }
    if (hasStoredAsset(intent)) {
      return send(ws, {
        type: "upload_done",
        intentId,
        alreadyStored: true,
        deliveryHeld: isIntentDeliveryHeld(intent)
      });
    }
    return send(ws, {
      type: "error",
      intentId,
      retryable: true,
      message: "Upload not active yet. Retrying from latest checkpoint is safe."
    });
  }

  console.log(`✅ upload_end (${t.bytesSent}/${t.bytesExpected})`);

  // Reject incomplete uploads (prevents “downloaded but broken” files)
  if (t.bytesSent !== t.bytesExpected) {
    failActiveTransfer(intentId, "Upload incomplete (size mismatch)", {
      preservePartial: true,
      deleteIntent: false,
      retryable: true
    });
    ws.currentUploadIntentId = null;
    return send(ws, { type: "error", message: "Upload incomplete (size mismatch)", intentId });
  }

  if (t.intent) {
    t.intent.status = "processing";
    t.intent.transferState = "processing";
    t.intent.storedBytes = t.bytesSent;
    t.intent.plainStoredBytes = uploadBytesToPlainBytes(t.intent, t.bytesSent);
    saveIntent(t.intent);
    emitTransferState(t.intent, "processing", {
      sentBytes: t.bytesSent,
      totalBytes: t.bytesExpected,
      plainSentBytes: t.intent.plainStoredBytes,
      plainTotalBytes: Number(t.intent.fileSize || 0)
    });
  }

  // LIVE MODE: close TCP and HARD RESET upload state
if (t.mode === "live") {
  clearTransferAutoFinalizeTimer(t);
  try { t.tcp?.end(); } catch {}

  // 🔥 CRITICAL: clear upload association BEFORE anything else
  ws.currentUploadIntentId = null;

  activeTransfers.delete(intentId);

  if (t.intent) {
    t.intent.status = "stored";
    t.intent.transferState = "delivered";
    t.intent.stored = true;
    t.intent.storedBytes = t.bytesExpected;
    t.intent.plainStoredBytes = uploadBytesToPlainBytes(t.intent, t.bytesExpected);
    t.intent.uploadedAt = Date.now();
    saveIntent(t.intent);
    emitTransferState(t.intent, "delivered", {
      sentBytes: t.bytesExpected,
      totalBytes: t.bytesExpected,
      plainSentBytes: t.intent.plainStoredBytes,
      plainTotalBytes: Number(t.intent.fileSize || 0)
    });
    if (t.intent.groupId) {
      finalizeGroupRecipientCopies(t.intent, {
        storedBytes: t.bytesExpected,
        totalBytes: t.bytesExpected,
        uploadedAt: t.intent.uploadedAt
      });
    }
    queueIntentArchivePreviewWarmup(t.intent);
  }

  send(ws, { type: "upload_done", intentId, deliveryHeld: isIntentDeliveryHeld(t.intent) });
  return;
}


if (t.mode === "offline") {
  finalizeOfflineTransfer(intentId, t, ws, { auto: false });
  return;
}


  // fallback
  activeTransfers.delete(intentId);
  ws.currentUploadIntentId = null;
  return send(ws, {
    type: "upload_done",
    intentId,
    deliveryHeld: Boolean(t.intent ? isIntentDeliveryHeld(t.intent) : false)
  });
}




    // 2) who is online?
    if (data.type === "who") {
      return send(ws, { type: "online_list", users: Array.from(online.keys()) });
    }


    // 3a) send intent only (NO transport)
    // 3a) send intent only (NO transport)
// 3a) send intent only (NO transport)
if (data.type === "send_intent") {
  const queuePostIntentWork = (work) => {
    setImmediate(() => {
      try {
        work();
      } catch (err) {
        console.error("❌ send_intent post-ack work failed:", err);
      }
    });
  };

  const incomingTypeForIntent = (intentRecord = null) => {
    const entry = intentRecord || {};
    if (entry.isTextOnly || String(entry.messageType || "").toLowerCase() === "text") {
      return "incoming_file";
    }
    return entry.stored ? "incoming_file" : "incoming_intent";
  };

  const buildIntentOkPayload = (intentRecord, options = {}) => {
    const ackIntent = intentRecord || {};
    const ackIsGroupSend = Boolean(options.isGroupSend);
    const ackTo = String(options.to || ackIntent.to || "").trim();
    const ackClientIntentId = options.clientIntentId ?? ackIntent.clientIntentId ?? null;
    const ackDeliveryHeld = Boolean(
      typeof options.deliveryHeld === "boolean"
        ? options.deliveryHeld
        : isIntentDeliveryHeld(ackIntent)
    );
    const ackReceiverOnline = typeof options.receiverOnline === "boolean"
      ? options.receiverOnline
      : (ackIsGroupSend ? false : isUserOnline(ackTo));
    const ackReceiverClient = Object.prototype.hasOwnProperty.call(options, "receiverClient")
      ? (options.receiverClient || null)
      : (ackIsGroupSend ? null : (getOnlineSocketsForUser(ackTo)[0]?.client || null));
    const ackMirrorIntents = Array.isArray(options.mirrorIntents) ? options.mirrorIntents : [];
    return {
      type: "intent_ok",
      intentId: ackIntent.id,
      clientIntentId: ackClientIntentId,
      to: ackIsGroupSend ? String(options.senderUsername || ackIntent.from || "").trim() : ackTo,
      groupId: ackIsGroupSend ? String(ackIntent.groupId || "") : "",
      groupName: ackIsGroupSend ? String(ackIntent.groupName || "") : "",
      fileName: ackIntent.fileName || "",
      downloadToken: ackIntent.downloadToken || null,
      receiverOnline: ackIsGroupSend
        ? ackMirrorIntents.some((entry) => isUserOnline(entry?.to))
        : ackReceiverOnline,
      receiverClient: ackIsGroupSend ? null : ackReceiverClient,
      expiresAt: ackIntent.expiresAt,
      createdAt: ackIntent.createdAt,
      isTextOnly: Boolean(ackIntent.isTextOnly || ackIntent.messageType === "text"),
      text: ackIntent.text || "",
      plainText: ackIntent.plainText || "",
      fileSize: Number(ackIntent.fileSize || 0),
      uploadBytesExpected: Number(ackIntent.uploadBytesExpected || ackIntent.fileSize || 0),
      encryption: ackIntent.encryption || null,
      passwordProtected: isIntentPasswordProtected(ackIntent),
      passwordMode: getIntentPasswordMode(ackIntent),
      passwordHint: String(ackIntent.passwordHint || ""),
      customExpiry: hasIntentCustomExpiry(ackIntent),
      deliveryHeld: ackDeliveryHeld,
      transferState: ackIntent.transferState || (ackIntent.readByRecipientAt ? "read" : (ackIntent.stored ? "delivered" : "queued")),
      stored: Boolean(ackIntent.stored),
      inlineTinyStored: Boolean(options.inlineTinyStored || ackIntent.inlineTinyStored)
    };
  };

  const requestedGroupId = String(data.groupId || "").trim();
  let to = String(data.to || "").trim();
  const rawFileName = String(data.fileName || "").trim();
  const fileName = rawFileName ? safeBasename(rawFileName) : "";
  const fileSize = Number(data.fileSize || 0);
  const uploadBytesExpected = normalizeUploadBytesExpected(data.uploadBytesExpected, fileSize);
  const note = typeof data.note === "string" ? data.note.trim().slice(0, 500) : "";
  const text = typeof data.text === "string" ? data.text.trim().slice(0, 5000) : "";
  const plainText = typeof data.plainText === "string" ? data.plainText.trim().slice(0, 5000) : "";
  const isTextOnly = Boolean(data.isTextOnly) || ((!!text || !!plainText) && !fileName && !fileSize);
  const inlineTinyRequested = Boolean(data.inlineTinyUpload) && !isTextOnly;
  const inlinePayloadBase64 = inlineTinyRequested ? String(data.inlinePayloadB64 || "").trim() : "";
  const inlinePayloadBytes = inlineTinyRequested ? Number(data.inlinePayloadBytes || 0) : 0;
  const clientIntentId = String(data.clientIntentId || "").trim();
  const silentPreupload = Boolean(data.silentPreupload) && !isTextOnly;
  const now = Date.now();
  const rawExpiresAt = Number(data.expiresAt || 0);
  const hasCustomExpiry = Number.isFinite(rawExpiresAt) && rawExpiresAt > 0;
  const expiresAt = hasCustomExpiry ? sanitizeIntentExpiresAt(rawExpiresAt, now) : 0;
  const isGroupSend = Boolean(requestedGroupId);
  let targetGroup = null;
  let groupRecipients = [];

  if (isGroupSend) {
    targetGroup = loadGroup(requestedGroupId);
    if (!targetGroup) {
      return send(ws, { type: "error", message: "Group not found" });
    }
    if (!targetGroup.members.includes(ws.username)) {
      return send(ws, { type: "error", message: "You are not a member of this group" });
    }
    to = ws.username; // sender's own copy is the primary upload intent
    groupRecipients = normalizeGroupMembers(targetGroup.members.filter((member) => member !== ws.username));
  }

  const encryption = sanitizeIntentEncryption(data.encryption || null, ws.username, to);
  const accessControl = sanitizeIntentAccessControl(data.accessControl || null, isTextOnly);
  const passwordHint = sanitizeIntentPasswordHint(data.passwordHint, isTextOnly, accessControl);

  if (!to) {
    return send(ws, { type: "error", message: "Missing recipient" });
  }

  if (isTextOnly) {
    if (!text && !plainText) {
      return send(ws, { type: "error", message: "Message cannot be empty" });
    }
    if (data.accessControl) {
      return send(ws, { type: "error", message: "Password protection is only available for files" });
    }
  } else {
    if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
      return send(ws, { type: "error", message: "Missing to/fileName/fileSize" });
    }
    if (!Number.isFinite(uploadBytesExpected) || uploadBytesExpected <= 0) {
      return send(ws, { type: "error", message: "Missing upload size" });
    }
    if (REQUIRE_E2EE && !encryption) {
      return send(ws, { type: "error", message: "Encrypted file transfer is required" });
    }
    if (encryption && encryption.mode !== "file") {
      return send(ws, { type: "error", message: "Invalid file encryption payload" });
    }
    if (!encryption && data.encryption) {
      return send(ws, { type: "error", message: "Invalid encryption payload" });
    }
    if (!accessControl && data.accessControl) {
      return send(ws, { type: "error", message: "Invalid password protection payload" });
    }
  }

  if (isTextOnly) {
    if (REQUIRE_E2EE && !encryption) {
      return send(ws, { type: "error", message: "Encrypted messaging is required" });
    }
    if (encryption && encryption.mode !== "text") {
      return send(ws, { type: "error", message: "Invalid text encryption payload" });
    }
    if (!encryption && data.encryption) {
      return send(ws, { type: "error", message: "Invalid encryption payload" });
    }
  }

  if (to === ws.username) {
    // allow self-send (personal storage)
    // continue
  }

  const sender = ensureUserShape(loadUser(ws.username));
  if (!sender) {
    return send(ws, { type: "error", message: "User not found" });
  }

  if (!isGroupSend) {
    const recipient = loadUser(to);
    if (!recipient) {
      return send(ws, { type: "error", message: "Recipient does not exist" });
    }
    if (!sender.friends.includes(to)) {
      return send(ws, { type: "error", message: "Recipient is not your friend" });
    }
  }

  // ✅ De-dup if client retries with same intent id
  if (clientIntentId) {
    const existing = findIntentByClientId(ws.username, clientIntentId, requestedGroupId);
    if (existing) {
      if (!existing.downloadToken && !(existing.isTextOnly || existing.messageType === "text")) {
        existing.downloadToken = generateDownloadToken();
        saveIntent(existing);
      }
      const receiverOnline = isUserOnline(existing.to);
      const receiverSockets = receiverOnline ? getOnlineSocketsForUser(existing.to) : [];
      const receiverClient = receiverSockets[0]?.client || null;
      const existingHeld = isIntentDeliveryHeld(existing);
      const acked = send(ws, buildIntentOkPayload(existing, {
        clientIntentId,
        to: existing.to,
        receiverOnline,
        receiverClient,
        deliveryHeld: existingHeld,
        isGroupSend,
        senderUsername: ws.username,
        inlineTinyStored: Boolean(existing.stored && !(existing.isTextOnly || existing.messageType === "text"))
      }));
      queuePostIntentWork(() => {
        if (receiverOnline && !isGroupSend && !existingHeld) {
          const safeExistingIntent = intentForClient(existing);
          sendToUser(existing.to, { type: incomingTypeForIntent(existing), intent: safeExistingIntent });
        }
        if (!existingHeld && existing.stored && !(existing.isTextOnly || existing.messageType === "text")) {
          sendToUser(ws.username, {
            type: "upload_done",
            intentId: existing.id,
            alreadyStored: true,
            deliveryHeld: existingHeld,
            inlineTiny: Boolean(existing.inlineTinyStored)
          });
        }
        if (isGroupSend) {
          const gKey = groupChatKey(existing.groupId || requestedGroupId || "");
          if (gKey && !existingHeld) {
            const members = targetGroup?.members?.length ? targetGroup.members : (existing.groupMembers || []);
            normalizeGroupMembers(members).forEach((member) => {
              touchUserChatOrder(member, gKey);
            });
          }
        } else if (!existingHeld) {
          touchUserChatOrder(ws.username, existing.to);
          touchUserChatOrder(existing.to, ws.username);
        }
      });
      return acked;
    }
  }

  const baseIntent = {
    from: ws.username,
    fileName: isTextOnly ? "" : fileName,
    fileSize: isTextOnly ? 0 : fileSize,
    note: isTextOnly ? "" : note,
    text: isTextOnly ? text : "",
    plainText: isTextOnly ? (plainText || (!encryption ? text : "")) : "",
    isTextOnly,
    messageType: isTextOnly ? "text" : "file",
    encryption: encryption || null,
    accessControl: isTextOnly ? null : (accessControl || null),
    passwordProtected: Boolean(!isTextOnly && accessControl),
    passwordMode: Boolean(!isTextOnly && accessControl) ? normalizeIntentPasswordMode(accessControl?.unlockMode || "once", "once") : "once",
    passwordHint: passwordHint || "",
    uploadBytesExpected: isTextOnly ? 0 : uploadBytesExpected,
    createdAt: now,
    releasedAt: silentPreupload ? 0 : now,
    silentPreupload,
    deliveryHold: silentPreupload,
    expiresAt,
    customExpiry: Boolean(!isTextOnly && hasCustomExpiry && expiresAt > 0),
    status: isTextOnly ? "completed" : "pending",
    transferState: isTextOnly ? "delivered" : "queued",
    readByRecipientAt: null,
    groupId: isGroupSend ? targetGroup.id : "",
    groupName: isGroupSend ? normalizeGroupName(targetGroup.name || "") : "",
    groupMembers: isGroupSend ? normalizeGroupMembers(targetGroup.members || []) : []
  };

  // ✅ Create + store intent even if receiver is offline
  const intent = {
    id: randomUUID(),
    to,
    ...baseIntent,
    clientIntentId: clientIntentId || null,
    downloadToken: isTextOnly ? null : generateDownloadToken(),
    isGroupRecipientCopy: false
  };
  let inlineTinyStored = false;
  let inlineTinyStore = null;
  if (isTextOnly) {
    intent.stored = true;
    intent.storedFile = null;
    intent.storedObjectKey = null;
    intent.objectUploadSession = null;
    intent.storedBytes = 0;
    intent.plainStoredBytes = 0;
    intent.uploadedAt = now;
    intent.completedAt = now;
  } else if (inlineTinyRequested && !silentPreupload && !encryption) {
    inlineTinyStore = tryStoreInlineTinyIntentPayload(intent, inlinePayloadBase64, {
      expectedBytes: uploadBytesExpected,
      hintedBytes: inlinePayloadBytes
    });
    if (inlineTinyStore.ok) {
      inlineTinyStored = true;
      intent.inlineTinyStored = true;
    } else if (inlineTinyStore.reason && inlineTinyStore.reason !== "missing_payload") {
      console.warn(
        `⚠️ Inline tiny send fallback (${inlineTinyStore.reason}) for intent ${intent.id} (${inlineTinyStore.actualBytes || 0}/${inlineTinyStore.expectedBytes || uploadBytesExpected})`
      );
    }
  }

  saveIntent(intent);

  const mirrorIntents = [];
  if (isGroupSend) {
    for (const recipientName of groupRecipients) {
      const mirrorIntent = {
        id: randomUUID(),
        to: recipientName,
        ...baseIntent,
        clientIntentId: null,
        downloadToken: isTextOnly ? null : generateDownloadToken(),
        groupPrimaryIntentId: intent.id,
        isGroupRecipientCopy: true
      };
      if (isTextOnly) {
        mirrorIntent.stored = true;
        mirrorIntent.storedFile = null;
        mirrorIntent.storedObjectKey = null;
        mirrorIntent.objectUploadSession = null;
        mirrorIntent.storedBytes = 0;
        mirrorIntent.plainStoredBytes = 0;
        mirrorIntent.uploadedAt = now;
        mirrorIntent.completedAt = now;
      } else if (inlineTinyStored) {
        mirrorIntent.stored = true;
        mirrorIntent.storedFile = intent.storedFile || null;
        mirrorIntent.storedObjectKey = intent.storedObjectKey || null;
        mirrorIntent.objectUploadSession = null;
        mirrorIntent.storedBytes = Number(intent.storedBytes || uploadBytesExpected || fileSize || 0);
        mirrorIntent.plainStoredBytes = uploadBytesToPlainBytes(mirrorIntent, mirrorIntent.storedBytes);
        mirrorIntent.uploadedAt = Number(intent.uploadedAt || now) || now;
        mirrorIntent.completedAt = Number(intent.completedAt || mirrorIntent.uploadedAt || now) || now;
        mirrorIntent.status = "stored";
        mirrorIntent.transferState = "delivered";
        mirrorIntent.inlineTinyStored = true;
      }
      saveIntent(mirrorIntent);
      mirrorIntents.push(mirrorIntent);
    }
    intent.groupMirrorIntentIds = mirrorIntents.map((entry) => entry.id);
    saveIntent(intent);
  }

  if (inlineTinyStored && inlineTinyStore?.ok) {
    queueInlineStoredIntentOffload(intent.id, inlineTinyStore.payload, {
      safeName: inlineTinyStore.safeName || intent.fileName || "file",
      localFilePath: inlineTinyStore.localFilePath || ""
    });
  }

  const intentHeld = isIntentDeliveryHeld(intent);
  const acked = send(ws, buildIntentOkPayload(intent, {
    clientIntentId: clientIntentId || null,
    to,
    deliveryHeld: intentHeld,
    isGroupSend,
    senderUsername: ws.username,
    mirrorIntents,
    inlineTinyStored
  }));

  queuePostIntentWork(() => {
    if (isGroupSend) {
      if (!intentHeld) {
        for (const mirrorIntent of mirrorIntents) {
          if (!isUserOnline(mirrorIntent.to)) continue;
          const safeIntent = intentForClient(mirrorIntent);
          sendToUser(mirrorIntent.to, { type: incomingTypeForIntent(mirrorIntent), intent: safeIntent });
        }
        mirrorIntents.forEach((mirrorIntent) => {
          queuePushNotificationForUser(mirrorIntent.to, buildPushPayloadForIntent(mirrorIntent));
        });
      }
    } else if (!intentHeld) {
      if (isUserOnline(to)) {
        const safeIntent = intentForClient(intent);
        sendToUser(to, { type: incomingTypeForIntent(intent), intent: safeIntent });
      }
      if (to !== ws.username) {
        queuePushNotificationForUser(to, buildPushPayloadForIntent(intent));
      }
    }

    // Keep all sender devices fully in sync (web + app) without waiting for polling.
    // For self-send (to === sender), sender already receives the regular recipient push above.
    const shouldBroadcastSenderDevices = !intentHeld && (isGroupSend || to !== ws.username);
    if (shouldBroadcastSenderDevices && isUserOnline(ws.username)) {
      const senderIntent = intentForClient(intent);
      sendToUser(ws.username, { type: incomingTypeForIntent(intent), intent: senderIntent });
    }

    if (!intentHeld && isGroupSend) {
      const groupKey = groupChatKey(targetGroup?.id || "");
      if (groupKey) {
        [ws.username, ...groupRecipients].forEach((member) => {
          touchUserChatOrder(member, groupKey);
        });
      }
    } else if (!intentHeld) {
      touchUserChatOrder(ws.username, to);
      touchUserChatOrder(to, ws.username);
    }

    if (!intentHeld) {
      emitTransferState(intent, intent.transferState || "queued", {
        sentBytes: Number(intent.storedBytes || 0),
        totalBytes: resolveUploadExpectedBytes(intent),
        plainSentBytes: Number(intent.plainStoredBytes || 0),
        plainTotalBytes: Number(intent.fileSize || 0),
        retryable: false
      });
    }
    if (inlineTinyStored && !isTextOnly) {
      sendToUser(ws.username, {
        type: "upload_done",
        intentId: intent.id,
        inlineTiny: true,
        deliveryHeld: intentHeld
      });
    }
  });
  return acked;
}


if (data.type === "release_preupload") {
  const intentId = String(data.intentId || "").trim();
  const requestId = String(data.requestId || "").trim();
  const failRelease = (message = "Could not release preupload") => {
    return send(ws, {
      type: "release_preupload_error",
      requestId,
      intentId,
      message: String(message || "Could not release preupload")
    });
  };

  if (!intentId) {
    return failRelease("Missing intentId");
  }

  const primaryIntent = loadIntent(intentId);
  if (!primaryIntent) {
    return failRelease("Intent not found");
  }
  if (primaryIntent.from !== ws.username) {
    return failRelease("Not authorized");
  }
  if (primaryIntent.isTextOnly || String(primaryIntent.messageType || "").toLowerCase() === "text") {
    return failRelease("Only file intents can be released");
  }

  const now = Date.now();
  const requestedName = String(data.fileName || "").trim();
  const nextFileName = requestedName ? safeBasename(requestedName) : String(primaryIntent.fileName || "");
  if (!nextFileName) {
    return failRelease("Missing file name");
  }
  const nextNote = typeof data.note === "string"
    ? data.note.trim().slice(0, 500)
    : String(primaryIntent.note || "");

  const rawExpiresAt = Number(data.expiresAt || 0);
  const hasCustomExpiry = Number.isFinite(rawExpiresAt) && rawExpiresAt > 0;
  const nextExpiresAt = hasCustomExpiry ? sanitizeIntentExpiresAt(rawExpiresAt, now) : 0;

  const hasAccessControlUpdate = Object.prototype.hasOwnProperty.call(data || {}, "accessControl");
  const sanitizedAccessControl = sanitizeIntentAccessControl(data.accessControl || null, false);
  if (hasAccessControlUpdate && data.accessControl && !sanitizedAccessControl) {
    return failRelease("Invalid password protection payload");
  }

  const finalAccessControl = hasAccessControlUpdate
    ? (sanitizedAccessControl || null)
    : (primaryIntent.accessControl || null);
  const finalPasswordHint = sanitizeIntentPasswordHint(
    data.passwordHint,
    false,
    finalAccessControl
  );
  const finalPasswordMode = finalAccessControl
    ? normalizeIntentPasswordMode(finalAccessControl.unlockMode || finalAccessControl.passwordMode || "once", "once")
    : "once";

  const intentsToUpdate = [primaryIntent];
  if (String(primaryIntent.groupId || "").trim()) {
    const mirrorIds = Array.isArray(primaryIntent.groupMirrorIntentIds)
      ? primaryIntent.groupMirrorIntentIds
      : [];
    mirrorIds.forEach((mirrorId) => {
      const mirror = loadIntent(String(mirrorId || "").trim());
      if (!mirror) return;
      if (mirror.from !== ws.username) return;
      intentsToUpdate.push(mirror);
    });
  }

  const updatedIntents = [];
  for (const intent of intentsToUpdate) {
    const heldBefore = isIntentDeliveryHeld(intent);
    if (heldBefore) {
      markIntentReleased(intent, now);
    } else {
      intent.updatedAt = now;
      intent.releasedAt = Number(intent.releasedAt || now) || now;
      intent.silentPreupload = false;
      intent.deliveryHold = false;
    }

    intent.fileName = nextFileName;
    intent.note = nextNote;
    intent.expiresAt = nextExpiresAt;
    intent.customExpiry = Boolean(nextExpiresAt > 0);
    intent.accessControl = finalAccessControl
      ? JSON.parse(JSON.stringify(finalAccessControl))
      : null;
    intent.passwordProtected = Boolean(finalAccessControl);
    intent.passwordMode = finalPasswordMode;
    intent.passwordHint = finalAccessControl ? finalPasswordHint : "";
    intent.updatedAt = now;
    saveIntent(intent);
    updatedIntents.push({ intent, heldBefore });
  }

  const releasedNow = updatedIntents.some((entry) => Boolean(entry.heldBefore));

  if (releasedNow) {
    for (const { intent, heldBefore } of updatedIntents) {
      if (!heldBefore) continue;

      const to = String(intent.to || "").trim();
      if (!to || to === ws.username) continue;

      if (isUserOnline(to)) {
        const safeIntent = intentForClient(intent);
        if (intent.stored) {
          sendToUser(to, { type: "incoming_file", intent: safeIntent });
        } else {
          sendToUser(to, { type: "incoming_intent", intent: safeIntent });
        }
        try {
          sendToUser(to, { type: "inbox", items: loadIntentsForUser(to) });
        } catch {}
      }

      queuePushNotificationForUser(to, buildPushPayloadForIntent(intent));
    }

    if (String(primaryIntent.groupId || "").trim()) {
      const gKey = groupChatKey(primaryIntent.groupId);
      if (gKey) {
        const touched = new Set([ws.username]);
        updatedIntents.forEach(({ intent }) => {
          const to = String(intent.to || "").trim();
          if (to) touched.add(to);
        });
        touched.forEach((member) => touchUserChatOrder(member, gKey));
      }
    } else {
      const to = String(primaryIntent.to || "").trim();
      if (to) {
        touchUserChatOrder(ws.username, to);
        touchUserChatOrder(to, ws.username);
      }
    }
  }

  try {
    sendToUser(ws.username, { type: "inbox", items: loadIntentsForUser(ws.username) });
  } catch {}

  const primaryAfter = loadIntent(intentId) || primaryIntent;
  emitTransferState(primaryAfter, String(primaryAfter.transferState || (primaryAfter.stored ? "delivered" : "queued")), {
    sentBytes: Number(primaryAfter.storedBytes || 0),
    totalBytes: Number(resolveUploadExpectedBytes(primaryAfter) || primaryAfter.uploadBytesExpected || primaryAfter.fileSize || 0),
    plainSentBytes: Number(primaryAfter.plainStoredBytes || uploadBytesToPlainBytes(primaryAfter, Number(primaryAfter.storedBytes || 0))),
    plainTotalBytes: Number(primaryAfter.fileSize || 0),
    retryable: false
  });

  return send(ws, {
    type: "release_preupload_ok",
    requestId,
    intentId: primaryAfter.id,
    to: String(primaryAfter.to || ""),
    groupId: String(primaryAfter.groupId || ""),
    released: releasedNow,
    alreadyReleased: !releasedNow,
    transferState: String(primaryAfter.transferState || (primaryAfter.stored ? "delivered" : "queued")),
    deliveryHeld: isIntentDeliveryHeld(primaryAfter),
    stored: Boolean(primaryAfter.stored),
    expiresAt: Number(primaryAfter.expiresAt || 0),
    customExpiry: Boolean(primaryAfter.customExpiry),
    passwordProtected: isIntentPasswordProtected(primaryAfter),
    passwordMode: getIntentPasswordMode(primaryAfter),
    passwordHint: String(primaryAfter.passwordHint || "")
  });
}



// 3b) accept an inbox intent
if (data.type === "accept_intent") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) {
    return send(ws, { type: "error", message: "Missing intentId" });
  }

  const intent = loadIntent(intentId);
  if (!intent) {
    return send(ws, { type: "error", message: "Intent not found" });
  }
  if (intent.to !== ws.username) {
    return send(ws, { type: "error", message: "Not authorized" });
  }

  if (intent.status !== "pending") {
    return send(ws, { type: "error", message: "Intent not pending" });
  }

  // ✅ Mark as accepted
intent.status = "accepted";
saveIntent(intent);

// ✅ Notify receiver
send(ws, {
  type: "intent_accepted",
  intentId: intent.id,
  from: intent.from,
  fileName: intent.fileName,
  fileSize: intent.fileSize,
});

// ✅ Notify sender if online
sendToUser(intent.from, {
  type: "intent_accepted_by_receiver",
  intentId: intent.id,
  to: intent.to,
  fileName: intent.fileName,
  fileSize: intent.fileSize,
});

return;

}


    // 3) send request to someone
    if (data.type === "send_request") {
      const to = String(data.to || "").trim();
      const fileName = String(data.fileName || "").trim();
      const fileSize = Number(data.fileSize || 0);

      if (!to || !fileName || !fileSize) {
        return send(ws, { type: "error", message: "Missing to/fileName/fileSize" });
      }

      const receiver = online.get(to);
      if (!receiver) {
        return send(ws, { type: "error", message: `${to} is not online` });
      }

      // Notify receiver
      send(receiver, {
        type: "incoming_file",
        from: ws.username,
        fileName,
        fileSize,
      });

      // Confirm to sender
     // Tell sender where to connect
// Tell receiver to start UDP checks
send(receiver, {
  type: "udp_check",
  from: ws.username,
  candidates: ws.candidates,
});

console.log("🧾 receiver.candidates:", receiver.candidates);
console.log("➡️ sending send_now to", ws.username, "with candidates count:", (receiver.candidates || []).length);

// Tell sender about receiver candidates
return send(ws, {
  type: "send_now",
  candidates: receiver.candidates,
});


    }

    send(ws, { type: "error", message: "Unknown message type" });
    } catch (err) {
  console.error("💥 Handler crash:", err);
  try { send(ws, { type: "error", message: "Server error" }); } catch {}
}

  });

  ws.on("close", () => {
  const disconnectedUser = String(ws.username || "").trim();
  if (disconnectedUser) {
    const wasOnline = isUserOnline(disconnectedUser);
    const stillOnline = unregisterOnlineSocket(disconnectedUser, ws);
    if (wasOnline !== stillOnline) {
      broadcastFriendsListForUserAndFriends(disconnectedUser);
    }
  }

  if (ws.currentUploadIntentId) {
    failActiveTransfer(ws.currentUploadIntentId, "Upload interrupted (connection closed)", {
      preservePartial: true,
      deleteIntent: false,
      notify: true,
      retryable: true
    });
    ws.currentUploadIntentId = null;
  }
});

});

cleanupExpiredIntents();
cleanupOrphanStoredFiles();
cleanupPreviewCache();
setInterval(cleanupExpiredIntents, 60 * 60 * 1000);
setInterval(cleanupOrphanStoredFiles, 60 * 60 * 1000);
setInterval(cleanupPreviewCache, 60 * 60 * 1000);
setInterval(cleanupStalledTransfers, TRANSFER_SWEEP_INTERVAL_MS);

process.on("SIGINT", () => {
  closeApnsClient();
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeApnsClient();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`✅ Signaling server running on port ${PORT}`);
  if (APNS_ENABLED) {
    console.log(`🔔 APNs push enabled (${APNS_USE_SANDBOX ? "sandbox" : "production"}) for topic ${APNS_TOPIC}`);
  } else {
    console.log("🔕 APNs push disabled (missing APNS_TEAM_ID / APNS_KEY_ID / APNS_PRIVATE_KEY / APNS_TOPIC)");
  }

});
