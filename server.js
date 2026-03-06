//p2p-signal/server.js
//test

const http = require("http");
const WebSocket = require("ws");
const { randomUUID, createHash, createHmac, timingSafeEqual } = require("crypto");
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
const WS_MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 64 * 1024 * 1024);
const INTENT_LIST_CACHE_TTL_MS = Math.max(250, Number(process.env.INTENT_LIST_CACHE_TTL_MS || 10 * 1000));
// Keep Office-native preview compatibility by default.
// Set REQUIRE_E2EE=1 in env if you want to force encrypted file/message payloads again.
const REQUIRE_E2EE = String(process.env.REQUIRE_E2EE || "0") !== "0";
const OFFLINE_UPLOAD_STREAM_HWM_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.OFFLINE_UPLOAD_STREAM_HWM_BYTES || 64 * 1024 * 1024)
);
const INBOX_REQUEST_MIN_INTERVAL_MS = Math.max(0, Number(process.env.INBOX_REQUEST_MIN_INTERVAL_MS || 500));
const UPLOAD_CHECKPOINT_EVERY_BYTES = Math.max(
  256 * 1024,
  Number(process.env.UPLOAD_CHECKPOINT_EVERY_BYTES || 2 * 1024 * 1024)
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

// username -> ws
const online = new Map();
// username -> Set<ws> (multi-device support)
const onlineSockets = new Map();

// username -> [intent, intent, intent]
const inboxes = new Map();

// intentId -> { tcp: net.Socket, bytesExpected, bytesSent, senderWs, receiverWs }
const activeTransfers = new Map();
const archiveIndexCache = new Map(); // intentId -> { entries, archiveSize, archiveMtimeMs, cachedAt }
const previewExtractJobs = new Map(); // cachePath -> Promise<void>
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,X-Merm-Password,X-Merm-Unlock");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Disposition,Content-Range,Accept-Ranges,X-Merm-Unlock,X-Merm-Unlock-Exp");
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
      if (!enforceIntentPasswordGate(req, res, url, intent)) {
        return;
      }

      const filePath = path.join(FILES_DIR, intent.storedFile);
      if (!fs.existsSync(filePath)) {
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

      const cachedEntries = getCachedArchiveIndex(intentId, archiveStat);
      if (cachedEntries) {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify({ intentId, entries: cachedEntries }));
        return;
      }

      let zipFile;
      try {
        zipFile = await openZipFile(filePath, { lazyEntries: true, autoClose: true });
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Could not read package");
        return;
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
      }).catch(() => null);

      if (!entries) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Could not read package");
        return;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      setCachedArchiveIndex(intentId, archiveStat, entries);

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
      if (!enforceIntentPasswordGate(req, res, url, intent)) {
        return;
      }

      const filePath = path.join(FILES_DIR, intent.storedFile);
      if (!fs.existsSync(filePath)) {
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
      if (!enforceIntentPasswordGate(req, res, url, intent)) {
        return;
      }

      const filePath = path.join(FILES_DIR, intent.storedFile);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("File missing");
        return;
      }

      const safeName = safeBasename(intent.fileName || "file");
      const mode = String(url.searchParams.get("disposition") || "").toLowerCase();
      const dispositionType = mode === "inline" ? "inline" : "attachment";
      serveFileFromDisk(req, res, filePath, safeName, dispositionType);
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
const GROUPS_DIR = path.join(STORAGE_DIR, "groups");
const PREVIEW_CACHE_DIR = path.join(STORAGE_DIR, "preview-cache");
const GUEST_TRANSFER_REQUESTS_FILE = path.join(STORAGE_DIR, "guest-transfer-requests.json");

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
  invalidateIntentListCacheForIntent(intent);
  removePreviewCacheForIntent(intent.id);
  archiveIndexCache.delete(String(intent.id || ""));

  const senderOnline = isUserOnline(intent.from);
  const receiverOnline = isUserOnline(intent.to);
  const payload = {
    type: "intent_deleted",
    intentId: intent.id,
    storedFile: intent.storedFile || null,
    from: intent.from,
    to: intent.to
  };
  if (!senderOnline) queueIntentDeletionForUser(intent.from, payload);
  if (!receiverOnline) queueIntentDeletionForUser(intent.to, payload);
  if (receiverOnline) sendToUser(intent.to, payload);
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
      if (intent?.isGroupRecipientCopy && intent.to !== username) continue;

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
fs.mkdirSync(USERS_DIR, { recursive: true });
fs.mkdirSync(GROUPS_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });


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
  const normalizedState = String(state || "").trim() || "queued";
  const payload = {
    type: "transfer_state",
    intentId: intent.id,
    from: intent.from,
    to: intent.to,
    state: normalizedState,
    at: Date.now(),
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
  if (intent?.to) sendToUser(intent.to, payload);
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
  const totalBytes = Number(t.bytesExpected || resolveUploadExpectedBytes(t.intent) || 0);
  const plainSentBytes = uploadBytesToPlainBytes(t.intent, t.bytesSent);
  const plainTotalBytes = Number(t.intent?.fileSize || 0) || uploadBytesToPlainBytes(t.intent, totalBytes);

  if (isUserOnline(t.intent.to)) {
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

  if (!t.lastCheckpointBytes || (t.bytesSent - t.lastCheckpointBytes) >= UPLOAD_CHECKPOINT_EVERY_BYTES || t.bytesSent === totalBytes) {
    t.lastCheckpointBytes = t.bytesSent;
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
  const payload = { type: "upload_failed", intentId, message };
  if (intent?.from) sendToUser(intent.from, payload);
  if (intent?.to) sendToUser(intent.to, payload);
}

function failActiveTransfer(intentId, message, options = {}) {
  if (!intentId) return null;
  const t = activeTransfers.get(intentId);
  const intent = t?.intent || loadIntent(intentId);
  const preservePartial = Boolean(options.preservePartial);
  const bytesUploaded = Number(t?.bytesSent || 0);

  try { t?.tcp?.destroy(); } catch {}
  try { t?.writeStream?.destroy(); } catch {}
  if (!preservePartial && t?.mode === "offline" && t?.filePath) {
    try { if (fs.existsSync(t.filePath)) fs.unlinkSync(t.filePath); } catch {}
  }

  if (t?.senderWs?.currentUploadIntentId === intentId) {
    t.senderWs.currentUploadIntentId = null;
  }

  activeTransfers.delete(intentId);

  if (intent && preservePartial && options.suppressState !== true) {
    updateIntentUploadCheckpoint(intent, bytesUploaded, {
      status: "uploading",
      transferState: "uploading"
    });
    emitTransferState(intent, "uploading", {
      sentBytes: bytesUploaded,
      totalBytes: resolveUploadExpectedBytes(intent),
      plainSentBytes: uploadBytesToPlainBytes(intent, bytesUploaded),
      plainTotalBytes: Number(intent.fileSize || 0),
      retryable: true,
      message: String(message || "Transfer paused")
    });
  } else if (intent && options.suppressState !== true) {
    emitTransferState(intent, "failed", {
      sentBytes: bytesUploaded,
      totalBytes: resolveUploadExpectedBytes(intent),
      plainSentBytes: uploadBytesToPlainBytes(intent, bytesUploaded),
      plainTotalBytes: Number(intent.fileSize || 0),
      retryable: Boolean(options.retryable),
      message: String(message || "Upload failed")
    });
  }

  if (intent && options.notify !== false && !preservePartial) {
    notifyUploadFailed(intent, intentId, message);
  }
  if (intent && options.deleteIntent !== false) {
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
    mirror.storedBytes = storedBytes;
    mirror.plainStoredBytes = uploadBytesToPlainBytes(mirror, storedBytes);
    mirror.uploadBytesExpected = Number(mirror.uploadBytesExpected || primary.uploadBytesExpected || totalBytes || 0);
    mirror.status = "stored";
    mirror.transferState = "delivered";
    mirror.uploadedAt = uploadedAt;
    saveIntent(mirror);

    emitTransferState(mirror, "delivered", {
      sentBytes: storedBytes,
      totalBytes: totalBytes || resolveUploadExpectedBytes(mirror),
      plainSentBytes: mirror.plainStoredBytes,
      plainTotalBytes: Number(mirror.fileSize || 0)
    });

    const sockets = getOnlineSocketsForUser(mirror.to);
    if (!sockets.length) return;
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
    const nextMembers = group.members.filter((member) => member !== name);
    if (nextMembers.length < 2) {
      try { fs.unlinkSync(groupFile(group.id)); } catch {}
      nextMembers.forEach((member) => {
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
  const code = String(raw?.code || "").replace(/\D/g, "").slice(0, 6);
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
    code: String(request?.code || "").replace(/\D/g, "").slice(0, 6),
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
    onlineUsers: Array.from(online.keys())
  };
}

function sendFriendsList(ws, userRecord = null) {
  if (!ws) return false;
  let user = userRecord;
  if (!user && ws.username) {
    user = loadUser(ws.username);
  }
  if (!user) {
    return send(ws, { type: "friends_list", friends: [], deletedFriends: [], onlineUsers: Array.from(online.keys()) });
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
      if (!["ping", "inbox_request", "friends_list", "friend_requests", "guest_transfer_requests", "groups_list", "typing"].includes(String(data?.type || ""))) {
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
  registerOnlineSocket(username, ws);

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
  sendFriendsList(ws, u2);
  send(ws, { type: "profiles", profiles: loadProfiles(u2.friends || []) });
  send(ws, { type: "friend_requests", incoming: u2.incomingRequests, outgoing: u2.outgoingRequests, declined: u2.declinedRequests });
  send(ws, { type: "guest_transfer_requests", incoming: listGuestTransferRequestsForUser(username) });
  sendGroupsList(ws, username);
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

  sendFriendsList(ws, me);
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
  if (storedFileName) {
    const filePath = path.join(FILES_DIR, storedFileName);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
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

  members.forEach((member) => {
    const u0 = loadUser(member);
    if (!u0) return;
    const u = ensureUserShape(u0);
    if (!u.groups.includes(group.id)) {
      u.groups.push(group.id);
      saveUser(u);
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
if (intent.stored && intent.storedFile && String(intent.transferState || "") !== "uploading") {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "File already uploaded", intentId });
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

const existingTransfer = activeTransfers.get(intentId);
if (existingTransfer && existingTransfer.senderWs && existingTransfer.senderWs !== ws) {
  ws.currentUploadIntentId = null;
  return send(ws, { type: "error", message: "Another upload is already active for this file", intentId });
}
if (existingTransfer && existingTransfer.senderWs === ws) {
  try { existingTransfer.writeStream?.destroy(); } catch {}
  try { existingTransfer.tcp?.destroy(); } catch {}
  activeTransfers.delete(intentId);
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
    return send(ws, { type: "error", message: "No active transfer for upload_end" });
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
  }

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
intent.storedBytes = t.bytesExpected;
intent.plainStoredBytes = uploadBytesToPlainBytes(intent, t.bytesExpected);
intent.status = "stored";
intent.transferState = "delivered";
intent.uploadedAt = Date.now();
saveIntent(intent);

    } catch (err) {
      console.error("❌ Failed to finalize intent after upload:", err);
      send(ws, { type: "upload_failed", intentId, message: "Server failed finalizing upload" });
      return;
    }
    //test

    // 🔔 IMPORTANT: notify recipient that file is now ready
    // 🔔 IMPORTANT: notify recipient that file is now ready
const receiverSockets = getOnlineSocketsForUser(intent.to);
if (!intent.groupId && receiverSockets.length) {
  const safeIntent = intentForClient(intent);
  sendToUser(intent.to, {
    type: "incoming_file",
    intent: safeIntent
  });
  try {
    sendToUser(intent.to, { type: "inbox", items: loadIntentsForUser(intent.to) });
  } catch {}

  // ✅ FIX 2: if recipient is iOS, immediately trigger TCP download
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
  const requestedGroupId = String(data.groupId || "").trim();
  let to = String(data.to || "").trim();
  const rawFileName = String(data.fileName || "").trim();
  const fileName = rawFileName ? safeBasename(rawFileName) : "";
  const fileSize = Number(data.fileSize || 0);
  const uploadBytesExpected = normalizeUploadBytesExpected(data.uploadBytesExpected, fileSize);
  const note = typeof data.note === "string" ? data.note.trim().slice(0, 500) : "";
  const text = typeof data.text === "string" ? data.text.trim().slice(0, 5000) : "";
  const isTextOnly = Boolean(data.isTextOnly) || (!!text && !fileName && !fileSize);
  const clientIntentId = String(data.clientIntentId || "").trim();
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
    if (!text) {
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
      if (receiverOnline && !isGroupSend) {
        const safeExistingIntent = intentForClient(existing);
        if (existing.isTextOnly || existing.messageType === "text") {
          sendToUser(existing.to, { type: "incoming_file", intent: safeExistingIntent });
        } else {
          sendToUser(existing.to, { type: "incoming_intent", intent: safeExistingIntent });
        }
        try { sendToUser(existing.to, { type: "inbox", items: loadIntentsForUser(existing.to) }); } catch {}
      }
      return send(ws, {
        type: "intent_ok",
        intentId: existing.id,
        clientIntentId,
        to: existing.to,
        fileName: existing.fileName || "",
        downloadToken: existing.downloadToken || null,
        receiverOnline,
        receiverClient,
        expiresAt: existing.expiresAt,
        createdAt: existing.createdAt,
        isTextOnly: Boolean(existing.isTextOnly || existing.messageType === "text"),
        text: existing.text || "",
        fileSize: Number(existing.fileSize || 0),
        uploadBytesExpected: Number(existing.uploadBytesExpected || existing.fileSize || 0),
        encryption: existing.encryption || null,
        passwordProtected: isIntentPasswordProtected(existing),
        passwordMode: getIntentPasswordMode(existing),
        passwordHint: String(existing.passwordHint || ""),
        customExpiry: hasIntentCustomExpiry(existing),
        transferState: existing.transferState || (existing.readByRecipientAt ? "read" : (existing.stored ? "delivered" : "queued"))
      });
    }
  }

  const baseIntent = {
    from: ws.username,
    fileName: isTextOnly ? "" : fileName,
    fileSize: isTextOnly ? 0 : fileSize,
    note: isTextOnly ? "" : note,
    text: isTextOnly ? text : "",
    isTextOnly,
    messageType: isTextOnly ? "text" : "file",
    encryption: encryption || null,
    accessControl: isTextOnly ? null : (accessControl || null),
    passwordProtected: Boolean(!isTextOnly && accessControl),
    passwordMode: Boolean(!isTextOnly && accessControl) ? normalizeIntentPasswordMode(accessControl?.unlockMode || "once", "once") : "once",
    passwordHint: passwordHint || "",
    uploadBytesExpected: isTextOnly ? 0 : uploadBytesExpected,
    createdAt: now,
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
  if (isTextOnly) {
    intent.stored = true;
    intent.storedFile = null;
    intent.storedBytes = 0;
    intent.plainStoredBytes = 0;
    intent.uploadedAt = now;
    intent.completedAt = now;
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
        mirrorIntent.storedBytes = 0;
        mirrorIntent.plainStoredBytes = 0;
        mirrorIntent.uploadedAt = now;
        mirrorIntent.completedAt = now;
      }
      saveIntent(mirrorIntent);
      mirrorIntents.push(mirrorIntent);
    }
    intent.groupMirrorIntentIds = mirrorIntents.map((entry) => entry.id);
    saveIntent(intent);
  }

  if (isGroupSend) {
    for (const mirrorIntent of mirrorIntents) {
      if (!isUserOnline(mirrorIntent.to)) continue;
      const safeIntent = intentForClient(mirrorIntent);
      if (isTextOnly) {
        sendToUser(mirrorIntent.to, { type: "incoming_file", intent: safeIntent });
      } else {
        sendToUser(mirrorIntent.to, { type: "incoming_intent", intent: safeIntent });
      }
      try {
        sendToUser(mirrorIntent.to, { type: "inbox", items: loadIntentsForUser(mirrorIntent.to) });
      } catch {}
    }
  } else {
    if (isUserOnline(to)) {
      const safeIntent = intentForClient(intent);
      if (isTextOnly) {
        sendToUser(to, { type: "incoming_file", intent: safeIntent });
      } else {
        sendToUser(to, { type: "incoming_intent", intent: safeIntent });
      }
      try {
        sendToUser(to, { type: "inbox", items: loadIntentsForUser(to) });
      } catch {}
    }
  }

  emitTransferState(intent, intent.transferState || "queued", {
    sentBytes: Number(intent.storedBytes || 0),
    totalBytes: resolveUploadExpectedBytes(intent),
    plainSentBytes: Number(intent.plainStoredBytes || 0),
    plainTotalBytes: Number(intent.fileSize || 0),
    retryable: false
  });

  // ✅ Always acknowledge sender
  return send(ws, {
    type: "intent_ok",
    intentId: intent.id,
    clientIntentId: clientIntentId || null,
    to: isGroupSend ? ws.username : to,
    groupId: isGroupSend ? intent.groupId : "",
    groupName: isGroupSend ? intent.groupName : "",
    fileName: intent.fileName || "",
    downloadToken: intent.downloadToken || null,
    receiverOnline: isGroupSend
      ? mirrorIntents.some((entry) => isUserOnline(entry.to))
      : isUserOnline(to),
    receiverClient: isGroupSend
      ? null
      : (getOnlineSocketsForUser(to)[0]?.client || null),
    expiresAt: intent.expiresAt,
    createdAt: intent.createdAt,
    isTextOnly,
    text: intent.text || "",
    fileSize: Number(intent.fileSize || 0),
    uploadBytesExpected: Number(intent.uploadBytesExpected || intent.fileSize || 0),
    encryption: intent.encryption || null,
    passwordProtected: isIntentPasswordProtected(intent),
    passwordMode: getIntentPasswordMode(intent),
    passwordHint: String(intent.passwordHint || ""),
    customExpiry: hasIntentCustomExpiry(intent),
    transferState: intent.transferState || (intent.readByRecipientAt ? "read" : (intent.stored ? "delivered" : "queued"))
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

server.listen(PORT, () => {
  console.log(`✅ Signaling server running on port ${PORT}`);

});
