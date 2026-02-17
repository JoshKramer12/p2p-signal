//p2p-signal/server.js
//test

const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");
const net = require("net");

const PORT = process.env.PORT || 8080;

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const TRANSFER_IDLE_TIMEOUT_MS = Number(process.env.TRANSFER_IDLE_TIMEOUT_MS || 3 * 60 * 1000);
const TRANSFER_SWEEP_INTERVAL_MS = Number(process.env.TRANSFER_SWEEP_INTERVAL_MS || 15 * 1000);
const USER_STORAGE_QUOTA_BYTES = Number(process.env.USER_STORAGE_QUOTA_BYTES || 5 * 1024 * 1024 * 1024);

// username -> ws
const online = new Map();

// username -> [intent, intent, intent]
const inboxes = new Map();

// intentId -> { tcp: net.Socket, bytesExpected, bytesSent, senderWs, receiverWs }
const activeTransfers = new Map();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Disposition");
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
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".folder": "application/x-merm-folder"
  };
  return map[ext] || "application/octet-stream";
}

function generateDownloadToken() {
  return randomUUID() + randomUUID();
}

const server = http.createServer((req, res) => {
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
      if (!intent || !intent.stored || !intent.storedFile) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File not found");
        return;
      }

      if (intent.downloadToken !== token) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const filePath = path.join(FILES_DIR, intent.storedFile);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File missing");
        return;
      }

      const stat = fs.statSync(filePath);
      const safeName = safeBasename(intent.fileName || "file");
      res.writeHead(200, {
        "content-type": contentTypeForName(safeName),
        "content-length": stat.size,
        "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
      });

      const rs = fs.createReadStream(filePath);
      rs.on("error", () => {
        try { res.end(); } catch {}
      });
      rs.pipe(res);
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
  maxPayload: 1024 * 1024 * 1024 * 10, // 10 GB
});


const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");


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
const USERS_DIR = path.join(STORAGE_DIR, "users");

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



function mapStoredFilesToIntents() {
  const map = new Map();
  try {
    const files = fs.readdirSync(INTENTS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
        if (intent?.stored && intent?.storedFile) {
          map.set(intent.storedFile, intent);
        }
      } catch {}
    }
  } catch {}
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

  const filePath = path.join(FILES_DIR, safeName);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error("❌ Failed to delete stored file:", err);
    throw err;
  }

  const intents = findIntentsByStoredFile(safeName);
  intents.forEach((intent) => deleteIntentAndNotify(intent));
}

function deleteIntentAndNotify(intent) {
  if (!intent) return;
  const intentFile = path.join(INTENTS_DIR, `${intent.id}.json`);
  try { if (fs.existsSync(intentFile)) fs.unlinkSync(intentFile); } catch {}

  const receiver = online.get(intent.to);
  const sender = online.get(intent.from);
  const senderOnline = Boolean(sender && sender.readyState === WebSocket.OPEN);
  const receiverOnline = Boolean(receiver && receiver.readyState === WebSocket.OPEN);
  const payload = {
    type: "intent_deleted",
    intentId: intent.id,
    storedFile: intent.storedFile || null,
    from: intent.from,
    to: intent.to
  };
  if (!senderOnline) queueIntentDeletionForUser(intent.from, payload);
  if (!receiverOnline) queueIntentDeletionForUser(intent.to, payload);
  if (receiverOnline) send(receiver, payload);
  if (senderOnline && sender !== receiver) send(sender, payload);
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
      if (!intent?.expiresAt) continue;
      if (now < intent.expiresAt) continue;

      if (intent.stored && intent.storedFile) {
        const filePath = path.join(FILES_DIR, intent.storedFile);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      }

      deleteIntentAndNotify(intent);
      try {
        const intentFile = path.join(INTENTS_DIR, `${intent.id}.json`);
        if (fs.existsSync(intentFile)) fs.unlinkSync(intentFile);
      } catch {}
    }
  } catch {}
}

function countStoredFiles() {
  try {
    return fs.readdirSync(FILES_DIR).length;
  } catch {
    return 0;
  }
}

function storageBytesUsed() {
  try {
    return fs.readdirSync(FILES_DIR).reduce((sum, name) => {
      try {
        return sum + fs.statSync(path.join(FILES_DIR, name)).size;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    return 0;
  }
}

function largestStoredFiles(limit = 50) {
  try {
    const intentMap = mapStoredFilesToIntents();
    const files = fs.readdirSync(FILES_DIR).map((name) => {
      const full = path.join(FILES_DIR, name);
      const size = fs.statSync(full).size;
      const intent = intentMap.get(name);
      return {
        storedFile: name,
        name: intent?.fileName || name,
        size,
        intentId: intent?.id || null,
        from: intent?.from || null,
        to: intent?.to || null,
        createdAt: intent?.createdAt || null
      };
    });
    files.sort((a, b) => b.size - a.size);
    return files.slice(0, limit);
  } catch {
    return [];
  }
}

function isFileIntent(intent) {
  if (!intent) return false;
  if (!intent.stored || !intent.storedFile) return false;
  if (intent.isTextOnly || intent.messageType === "text") return false;
  return true;
}

function resolveStoredFileSize(storedFile) {
  const safeName = String(storedFile || "").trim();
  if (!safeName) return null;
  try {
    const filePath = path.join(FILES_DIR, safeName);
    if (fs.existsSync(filePath)) {
      return fs.statSync(filePath).size;
    }
  } catch {}
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

      const fileSizeOnDisk = resolveStoredFileSize(intent.storedFile);
      if (fileSizeOnDisk === null) continue;

      sentStoredFilesCount += 1;
      if (!countedStoredFiles.has(intent.storedFile)) {
        countedStoredFiles.add(intent.storedFile);
        usedBytes += fileSizeOnDisk;
      }
      sentFiles.push({
        storedFile: intent.storedFile,
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


fs.mkdirSync(INTENTS_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });


function saveIntent(intent) {
  const file = path.join(INTENTS_DIR, `${intent.id}.json`);
  fs.writeFileSync(file, JSON.stringify(intent, null, 2));
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

function generateSessionToken() {
  return randomUUID() + randomUUID();
}


function loadIntentsForUser(username) {
  const intents = [];
  for (const file of fs.readdirSync(INTENTS_DIR)) {
    let intent;
    try {
      intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    if (intent.to === username) {
      if (!intent.downloadToken) {
        intent.downloadToken = generateDownloadToken();
        saveIntent(intent);
      }
      // Only show if:
      // - stored file is ready, OR
      // - it's pending/accepted (still valid intent)
      // (uploading should show, but NOT as downloadable unless stored=true)
      intents.push(intent);
    }
  }
  return intents;
}

function findIntentByClientId(sender, clientIntentId) {
  if (!clientIntentId) return null;
  try {
    const files = fs.readdirSync(INTENTS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const intent = JSON.parse(fs.readFileSync(path.join(INTENTS_DIR, file), "utf8"));
        if (intent?.from === sender && intent?.clientIntentId === clientIntentId) {
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

function maybeSendUploadProgress(t) {
  if (!t || !t.intent || !t.intent.to) return;
  const now = Date.now();
  if (!t.lastProgressTs) t.lastProgressTs = 0;
  if (!t.lastProgressBytes) t.lastProgressBytes = 0;

  const shouldSend =
    now - t.lastProgressTs > 1000 ||
    t.bytesSent === t.bytesExpected ||
    t.bytesSent - t.lastProgressBytes > 32 * 1024 * 1024;

  if (!shouldSend) return;

  t.lastProgressTs = now;
  t.lastProgressBytes = t.bytesSent;

  const receiverWs = online.get(t.intent.to);
  if (!receiverWs) return;

  send(receiverWs, {
    type: "incoming_progress",
    intentId: t.intent.id,
    bytesSent: t.bytesSent,
    bytesExpected: t.bytesExpected
  });
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
  const payload = { type: "upload_failed", intentId, message };
  const sender = intent?.from ? online.get(intent.from) : null;
  const receiver = intent?.to ? online.get(intent.to) : null;
  if (sender) send(sender, payload);
  if (receiver && receiver !== sender) send(receiver, payload);
}

function failActiveTransfer(intentId, message, options = {}) {
  if (!intentId) return null;
  const t = activeTransfers.get(intentId);
  const intent = t?.intent || loadIntent(intentId);

  try { t?.tcp?.destroy(); } catch {}
  try { t?.writeStream?.destroy(); } catch {}
  if (t?.mode === "offline" && t?.filePath) {
    try { if (fs.existsSync(t.filePath)) fs.unlinkSync(t.filePath); } catch {}
  }

  if (t?.senderWs?.currentUploadIntentId === intentId) {
    t.senderWs.currentUploadIntentId = null;
  }

  activeTransfers.delete(intentId);

  if (intent && options.notify !== false) {
    notifyUploadFailed(intent, intentId, message);
  }
  if (intent && options.deleteIntent !== false) {
    deleteIntentAndNotify(intent);
  }
  return intent || null;
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
    failActiveTransfer(intentId, "Upload timed out due to inactivity");
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
  if (!u.profile) u.profile = {};
  return u;
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
  const ws = online.get(username);
  if (!ws) return;
  const u = ensureUserShape(u0);
  send(ws, {
    type: "friend_requests",
    incoming: u.incomingRequests || [],
    outgoing: u.outgoingRequests || [],
    declined: u.declinedRequests || []
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
  return { ok: true, a: ua, b: ub };
}




wss.on("connection", (ws, req) => {

  const endpoint = getPublicEndpoint(req);
ws.publicIp = endpoint.ip;
ws.publicPort = endpoint.port;

console.log("🌍 Client public endpoint:", ws.publicIp, ws.publicPort);


  console.log("🔌 WebSocket client connected");

  ws.username = null;

  ws.on("message", (msg, isBinary) => {
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
      failActiveTransfer(intentId, "Upload exceeded expected size");
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
      console.log("📩 Message received:", data);
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

      const w = online.get(u.username);
      if (w) {
        send(w, { type: "friends_list", friends: u.friends, deletedFriends: u.deletedFriends });
        sendFriendRequestsUpdate(u.username);
      }
    }
  } catch (err) {
    console.error("❌ Failed to mark deleted in other users:", err);
  }

  // Delete user file
  const userPath = path.join(USERS_DIR, `${username}.json`);
  try {
    if (fs.existsSync(userPath)) fs.unlinkSync(userPath);
  } catch (err) {
    console.error("❌ Failed to delete user file:", err);
  }

  // Remove from online users
  online.delete(username);

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
  incomingRequests: [],
  outgoingRequests: [],
  declinedRequests: [],
  profile,
  createdAt: Date.now(),
  sessionTokens: [],
};



  saveUser(user);

  return send(ws, { type: "signup_ok", username });
}

if (data.type === "auth_resume") {
  const username = String(data.username || "").trim();
  const token = String(data.sessionToken || "");
  const client = String(data.client || "unknown");

  const user = loadUser(username);
  if (!user || !user.sessionTokens?.includes(token)) {
    return send(ws, { type: "error", message: "Session expired" });
  }

  // ✅ Upgrade old accounts: ensure self is in friends list
user.friends = Array.isArray(user.friends) ? user.friends : [];
if (!user.friends.includes(user.username)) {
  user.friends.push(user.username);
  saveUser(user);
}


  ws.username = username;
  ws.client = client;
  online.set(username, ws);

  send(ws, {
    type: "login_ok",
    username,
    sessionToken: token,
    resumed: true,
    client: ws.client,
  });

  const pending = loadIntentsForUser(username);
  send(ws, { type: "inbox", items: pending });

  const u2 = ensureUserShape(user);
  saveUser(u2);
  flushQueuedIntentDeletions(ws, u2);
  send(ws, { type: "friends_list", friends: u2.friends, deletedFriends: u2.deletedFriends });
  send(ws, { type: "profiles", profiles: loadProfiles(u2.friends || []) });
  send(ws, { type: "friend_requests", incoming: u2.incomingRequests, outgoing: u2.outgoingRequests, declined: u2.declinedRequests });

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
  // Enforce single active WS session
  // ───────────────────────────
  const prev = online.get(username);
  if (prev && prev.readyState === WebSocket.OPEN) {
    try {
      send(prev, { type: "error", message: "Logged in elsewhere" });
    } catch {}
    try {
      prev.close(4001, "Replaced by new login");
    } catch {}
  }
  online.delete(username);

  // ───────────────────────────
  // Bind user to this socket
  // ───────────────────────────
  ws.username = username;
  ws.client = client;
  ws.tcpPort = Number(data.tcpPort || 0);
  ws.candidates = Array.isArray(data.candidates) ? data.candidates : [];

  online.set(username, ws);

  // ───────────────────────────
  // Issue persistent session token
  // ───────────────────────────
  const token = generateSessionToken();

  user.sessionTokens = Array.isArray(user.sessionTokens)
    ? user.sessionTokens
    : [];

  user.sessionTokens.push(token);

  // Keep only the last 5 tokens (prevents unbounded growth)
  user.sessionTokens = user.sessionTokens.slice(-5);

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
  send(ws, {
    type: "friends_list",
    friends: u2.friends || [],
    deletedFriends: u2.deletedFriends || [],
  });
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
  ws.tcpPort = Number(data.tcpPort || 0);
  ws.candidates = Array.isArray(data.candidates) ? data.candidates : [];

  online.set(name, ws);

  send(ws, {
    type: "login_ok",
    username: name,
    publicIp: ws.publicIp,
    publicPort: ws.publicPort,
    client: ws.client,
  });

  const pending = loadIntentsForUser(name);
  send(ws, { type: "inbox", items: pending });

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
  if (!intent.stored || !intent.storedFile) {
    return send(ws, { type: "error", message: "File not stored on server", intentId });
  }

  const filePath = path.join(FILES_DIR, intent.storedFile);
  if (!fs.existsSync(filePath)) {
    return send(ws, { type: "error", message: "Stored file missing", intentId });
  }

  // Tell browser what's coming
  send(ws, {
    type: "download_ws_begin",
    intentId,
    name: intent.fileName,
    size: intent.fileSize,
  });

  const rs = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });

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
  if (intent.stored && intent.storedFile) {
    const filePath = path.join(FILES_DIR, intent.storedFile);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error("❌ Failed to delete file:", err);
    }
  }

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

  if (!intent.stored || !intent.storedFile) {
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

    const filePath = path.join(FILES_DIR, downloadIntent.storedFile);
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

  const sender = online.get(intent.from);
  if (!sender) return;

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

      send(sender, { type: "upload_ok", intentId: intent.id });
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
  send(ws, { type: "friends_list", friends: meUpdated.friends, deletedFriends: meUpdated.deletedFriends });

  const otherWs = online.get(requester);
  if (otherWs) {
    const otherUpdated = ensureUserShape(loadUser(requester));
    send(otherWs, { type: "friends_list", friends: otherUpdated.friends, deletedFriends: otherUpdated.deletedFriends });
  }

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
  return send(ws, {
    type: "stats",
    ...buildStatsPayload(ws.username)
  });
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
  const items = loadIntentsForUser(ws.username);
  return send(ws, { type: "inbox", items });
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
      fileName: intent.fileName || "",
      fileSize: Number(intent.fileSize || 0),
      createdAt: Number(intent.createdAt || 0),
      downloadToken: intent.downloadToken || null,
      stored: Boolean(intent.stored),
      status: intent.status || "",
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
      saveIntent(intent);
    }
    updates.push({
      intentId,
      readAt: intent.readByRecipientAt || now
    });
  }

  if (!updates.length) return;
  const senderWs = online.get(friend);
  if (senderWs) {
    send(senderWs, {
      type: "read_receipt",
      from: ws.username,
      intents: updates
    });
  }
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

  send(ws, { type: "friends_list", friends: me.friends, deletedFriends: me.deletedFriends });
  sendFriendRequestsUpdate(ws.username);
  return;
}


// =========================
// 🗑️ DELETE STORED FILE (ADMIN)
// =========================
if (data.type === "delete_file") {
  const storedFile = String(data.storedFile || "").trim();
  if (!storedFile) return send(ws, { type: "error", message: "Missing storedFile" });

  try {
    deleteStoredFileAndNotify(storedFile);
  } catch (err) {
    return send(ws, { type: "error", message: "Failed to delete file" });
  }

  return send(ws, { type: "stats", ...buildStatsPayload(ws.username) });
}

if (data.type === "delete_files") {
  const storedFiles = Array.isArray(data.storedFiles) ? data.storedFiles : [];
  if (!storedFiles.length) return send(ws, { type: "error", message: "No files specified" });

  for (const rawStoredFile of storedFiles) {
    const storedFile = String(rawStoredFile || "").trim();
    if (!storedFile) continue;
    try { deleteStoredFileAndNotify(storedFile); } catch {}
  }

  return send(ws, { type: "stats", ...buildStatsPayload(ws.username) });
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

  if (intent.stored && intent.storedFile) {
    const filePath = path.join(FILES_DIR, intent.storedFile);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  }

  deleteIntentAndNotify(intent);

  return send(ws, { type: "stats", ...buildStatsPayload(ws.username) });
}

// =========================
// 👥 FRIENDS: LIST
// =========================
if (data.type === "friends_list") {
  const u0 = loadUser(ws.username);
if (!u0) return send(ws, { type: "friends_list", friends: [] });

const user = ensureUserShape(u0);
send(ws, { type: "friends_list", friends: user.friends, deletedFriends: user.deletedFriends });
send(ws, { type: "profiles", profiles: loadProfiles(user.friends || []) });
return;

  return send(ws, { type: "friends_list", friends: user?.friends || [] });
}

// =========================
// 👤 PROFILE UPDATE
// =========================
if (data.type === "update_profile") {
  const u0 = loadUser(ws.username);
  if (!u0) return send(ws, { type: "error", message: "User not found" });

  const user = ensureUserShape(u0);
  const profile = user.profile || {};

  const updates = data.profile || {};
  if (typeof updates.firstName === "string") profile.firstName = updates.firstName;
  if (typeof updates.lastName === "string") profile.lastName = updates.lastName;
  if (typeof updates.email === "string") profile.email = updates.email;
  if (typeof updates.phone === "string") profile.phone = updates.phone;
  if (typeof updates.phoneCountryCode === "string") profile.phoneCountryCode = updates.phoneCountryCode;
  if (typeof updates.phoneLocal === "string") profile.phoneLocal = updates.phoneLocal;
  if (typeof updates.avatarDataUrl === "string") profile.avatarDataUrl = updates.avatarDataUrl;

  user.profile = profile;
  saveUser(user);

  // notify self + friends
  send(ws, { type: "profile_update", username: ws.username, profile });
  const friends = user.friends || [];
  friends.forEach((f) => {
    const w = online.get(f);
    if (w && w !== ws) {
      send(w, { type: "profile_update", username: ws.username, profile });
    }
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
  send(ws, { type: "friends_list", friends: me.friends });

  const otherWs = online.get(friend);
  if (otherWs) {
    const other = ensureUserShape(loadUser(friend));
    send(otherWs, { type: "friends_list", friends: other.friends });
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
    const storedFileName = `${intentId}__${safeName}`;
    const filePath = path.join(FILES_DIR, storedFileName);

    // Create write stream for raw bytes
    const writeStream = fs.createWriteStream(filePath, {
      flags: "w",
      highWaterMark: 16 * 1024 * 1024, // balanced throughput + backpressure
    });


    writeStream.on("error", (err) => {
      console.error("❌ File writeStream error:", err);
      failActiveTransfer(intentId, "Server failed writing file");
      ws.currentUploadIntentId = null;
    });

    activeTransfers.set(intentId, {
      mode: "offline",
      tcp: null,
      senderWs: ws,
      writeStream,
      filePath,
      bytesExpected: size,
      bytesSent: 0,
      ended: false,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      intent, // ✅ ADD THIS
    });


// Persist linkage but DO NOT mark stored until upload_end finishes
intent.stored = false;
intent.storedFile = storedFileName;
intent.storedBytes = 0;
intent.status = "uploading";
saveIntent(intent);

// ✅ let sender start streaming immediately
send(ws, { type: "upload_ok", intentId });



    console.log(`💾 Offline upload_begin: storing to ${storedFileName}`);
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
  bytesExpected: size,
  bytesSent: 0,
  ended: false,
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  intent, // ✅ ADD THIS
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
    return send(ws, { type: "error", message: "No active transfer for upload_end" });
  }

  console.log(`✅ upload_end (${t.bytesSent}/${t.bytesExpected})`);

  // Reject incomplete uploads (prevents “downloaded but broken” files)
  if (t.bytesSent !== t.bytesExpected) {
    failActiveTransfer(intentId, "Upload incomplete (size mismatch)");
    ws.currentUploadIntentId = null;
    return send(ws, { type: "error", message: "Upload incomplete (size mismatch)", intentId });
  }

  // LIVE MODE: close TCP and HARD RESET upload state
if (t.mode === "live") {
  try { t.tcp?.end(); } catch {}

  // 🔥 CRITICAL: clear upload association BEFORE anything else
  ws.currentUploadIntentId = null;

  activeTransfers.delete(intentId);

  send(ws, { type: "upload_done", intentId });
  return;
}


  // OFFLINE MODE: close the file stream and only then ack upload_done
  // OFFLINE MODE: finalize file, update intent, notify receiver
if (t.mode === "offline") {
  const done = () => {
    activeTransfers.delete(intentId);
    ws.currentUploadIntentId = null;

    let intent;
    try {
      const intentFile = path.join(INTENTS_DIR, `${intentId}.json`);
      intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
intent.stored = true;
intent.storedBytes = intent.fileSize;
intent.status = "stored";
saveIntent(intent);

    } catch (err) {
      console.error("❌ Failed to finalize intent after upload:", err);
      send(ws, { type: "upload_failed", intentId, message: "Server failed finalizing upload" });
      return;
    }
    //test

    // 🔔 IMPORTANT: notify recipient that file is now ready
    // 🔔 IMPORTANT: notify recipient that file is now ready
const receiver = online.get(intent.to);
if (receiver) {
  send(receiver, {
    type: "incoming_file",
    intent
  });
  try {
    send(receiver, { type: "inbox", items: loadIntentsForUser(intent.to) });
  } catch {}

  // ✅ FIX 2: if recipient is iOS, immediately trigger TCP download
  if (receiver.client === "ios") {
    send(receiver, {
      type: "prepare_transfer",
      intentId
    });
  }
}


    // ✅ acknowledge sender (iOS)
    send(ws, { type: "upload_done", intentId });
  };

  try {
  // Prevent any further binary frames from being associated with this intent
  ws.currentUploadIntentId = null;

  t.writeStream.end(() => done());
} catch {

    activeTransfers.delete(intentId);
    ws.currentUploadIntentId = null;
    return send(ws, { type: "error", message: "Failed to finalize stored file" });
  }

  return;
}


  // fallback
  activeTransfers.delete(intentId);
  ws.currentUploadIntentId = null;
  return send(ws, { type: "upload_done", intentId });
}




    // 2) who is online?
    if (data.type === "who") {
      return send(ws, { type: "online_list", users: Array.from(online.keys()) });
    }


    // 3a) send intent only (NO transport)
    // 3a) send intent only (NO transport)
// 3a) send intent only (NO transport)
if (data.type === "send_intent") {
  const to = String(data.to || "").trim();
  const rawFileName = String(data.fileName || "").trim();
  const fileName = rawFileName ? safeBasename(rawFileName) : "";
  const fileSize = Number(data.fileSize || 0);
  const note = typeof data.note === "string" ? data.note.trim().slice(0, 500) : "";
  const text = typeof data.text === "string" ? data.text.trim().slice(0, 5000) : "";
  const isTextOnly = Boolean(data.isTextOnly) || (!!text && !fileName && !fileSize);
  const clientIntentId = String(data.clientIntentId || "").trim();

  if (!to) {
    return send(ws, { type: "error", message: "Missing recipient" });
  }

  if (isTextOnly) {
    if (!text) {
      return send(ws, { type: "error", message: "Message cannot be empty" });
    }
  } else {
    if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
      return send(ws, { type: "error", message: "Missing to/fileName/fileSize" });
    }
  }

  if (to === ws.username) {
    // allow self-send (personal storage)
    // continue
  }

  // 🔒 Validate recipient exists
  const sender = ensureUserShape(loadUser(ws.username));
  const recipient = loadUser(to);

  if (!recipient) {
    return send(ws, { type: "error", message: "Recipient does not exist" });
  }

  // 🔒 Validate friendship (WhatsApp-style)
  if (!sender.friends.includes(to)) {
    return send(ws, { type: "error", message: "Recipient is not your friend" });
  }

  // ✅ De-dup if client retries with same intent id
  if (clientIntentId) {
    const existing = findIntentByClientId(ws.username, clientIntentId);
    if (existing) {
      if (!existing.downloadToken && !(existing.isTextOnly || existing.messageType === "text")) {
        existing.downloadToken = generateDownloadToken();
        saveIntent(existing);
      }
      const receiverWs = online.get(existing.to);
      if (receiverWs) {
        if (existing.isTextOnly || existing.messageType === "text") {
          send(receiverWs, { type: "incoming_file", intent: existing });
        } else {
          send(receiverWs, { type: "incoming_intent", intent: existing });
        }
        try { send(receiverWs, { type: "inbox", items: loadIntentsForUser(existing.to) }); } catch {}
      }
      return send(ws, {
        type: "intent_ok",
        intentId: existing.id,
        clientIntentId,
        to: existing.to,
        fileName: existing.fileName || "",
        downloadToken: existing.downloadToken || null,
        receiverOnline: Boolean(receiverWs),
        receiverClient: receiverWs?.client || null,
        expiresAt: existing.expiresAt,
        createdAt: existing.createdAt,
        isTextOnly: Boolean(existing.isTextOnly || existing.messageType === "text"),
        text: existing.text || ""
      });
    }
  }

  // ✅ Create + store intent even if receiver is offline
  const now = Date.now();
  const intent = {
    id: randomUUID(),
    from: ws.username,
    to,
    fileName: isTextOnly ? "" : fileName,
    fileSize: isTextOnly ? 0 : fileSize,
    note: isTextOnly ? "" : note,
    text: isTextOnly ? text : "",
    isTextOnly,
    messageType: isTextOnly ? "text" : "file",
    clientIntentId: clientIntentId || null,
    createdAt: now,
    expiresAt: now + RETENTION_MS,
    status: isTextOnly ? "completed" : "pending", // pending | uploading | stored | completed
    downloadToken: isTextOnly ? null : generateDownloadToken(),
    readByRecipientAt: null
  };
  if (isTextOnly) {
    intent.stored = true;
    intent.storedFile = null;
    intent.storedBytes = 0;
    intent.uploadedAt = now;
    intent.completedAt = now;
  }

  if (!inboxes.has(to)) inboxes.set(to, []);
  inboxes.get(to).push(intent);
  saveIntent(intent);

  const receiverWs = online.get(to);
  if (receiverWs) {
    if (isTextOnly) {
      send(receiverWs, { type: "incoming_file", intent });
    } else {
      send(receiverWs, { type: "incoming_intent", intent });
    }
    try {
      send(receiverWs, { type: "inbox", items: loadIntentsForUser(to) });
    } catch {}
  }

  // ✅ Always acknowledge sender
  return send(ws, {
    type: "intent_ok",
    intentId: intent.id,
    clientIntentId: clientIntentId || null,
    to,
    fileName: intent.fileName || "",
    downloadToken: intent.downloadToken || null,
    receiverOnline: Boolean(receiverWs),
    receiverClient: receiverWs?.client || null,
    expiresAt: intent.expiresAt,
    createdAt: intent.createdAt,
    isTextOnly,
    text: intent.text || ""
  });
}



// 3b) accept an inbox intent
if (data.type === "accept_intent") {
  const intentId = String(data.intentId || "").trim();
  if (!intentId) {
    return send(ws, { type: "error", message: "Missing intentId" });
  }

  const inbox = inboxes.get(ws.username) || [];
  const intent = inbox.find(i => i.id === intentId);

  if (!intent) {
    return send(ws, { type: "error", message: "Intent not found" });
  }

  if (intent.status !== "pending") {
    return send(ws, { type: "error", message: "Intent not pending" });
  }

  // ✅ Mark as accepted
intent.status = "accepted";

// ✅ Notify receiver
send(ws, {
  type: "intent_accepted",
  intentId: intent.id,
  from: intent.from,
  fileName: intent.fileName,
  fileSize: intent.fileSize,
});

// ✅ Notify sender if online
const senderWs = online.get(intent.from);
if (senderWs) {
  send(senderWs, {
    type: "intent_accepted_by_receiver",
    intentId: intent.id,
    to: intent.to,
    fileName: intent.fileName,
    fileSize: intent.fileSize,
  });
}

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
  if (ws.username && online.get(ws.username) === ws) {
    online.delete(ws.username);
  }

  if (ws.currentUploadIntentId) {
    failActiveTransfer(ws.currentUploadIntentId, "Upload interrupted (connection closed)");
    ws.currentUploadIntentId = null;
  }
});

});

cleanupExpiredIntents();
setInterval(cleanupExpiredIntents, 60 * 60 * 1000);
setInterval(cleanupStalledTransfers, TRANSFER_SWEEP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`✅ Signaling server running on port ${PORT}`);

});
