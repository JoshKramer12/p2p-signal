//p2p-signal/server.js

const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");
const net = require("net");

const PORT = process.env.PORT || 8080;


// username -> ws
const online = new Map();

// username -> [intent, intent, intent]
const inboxes = new Map();

// intentId -> { tcp: net.Socket, bytesExpected, bytesSent, senderWs, receiverWs }
const activeTransfers = new Map();

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");


const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "p2p-storage");

const INTENTS_DIR = path.join(STORAGE_DIR, "intents");
const FILES_DIR = path.join(STORAGE_DIR, "files");
const USERS_DIR = path.join(STORAGE_DIR, "users");

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

function loadIntentsForUser(username) {
  const intents = [];
  for (const file of fs.readdirSync(INTENTS_DIR)) {
    const intent = JSON.parse(
      fs.readFileSync(path.join(INTENTS_DIR, file), "utf8")
    );
    if (intent.to === username) {
  // Only show if:
  // - stored file is ready, OR
  // - it's pending/accepted (still valid intent)
  // (uploading should show, but NOT as downloadable unless stored=true)
  intents.push(intent);
}

  }
  return intents;
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
  return u;
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
      try { t.tcp?.destroy(); } catch {}
      try { t.writeStream?.destroy(); } catch {}
      activeTransfers.delete(intentId);
      ws.currentUploadIntentId = null;
      return send(ws, { type: "error", message: "Upload exceeded expected size" });
    }

    // OFFLINE MODE: write to disk
    if (t.mode === "offline") {
      if (!t.writeStream) {
        console.log("❌ Offline transfer missing writeStream", intentId);
        return send(ws, { type: "error", message: "Server not ready for offline upload" });
      }

      t.writeStream.write(msg);
      t.bytesSent += incomingLen;

      if (t.bytesSent % (1024 * 1024) < incomingLen) {
        console.log(`💾 Stored ${t.bytesSent}/${t.bytesExpected} bytes`);
      }
      return;
    }

    // LIVE MODE: forward to TCP (existing behavior)
    if (!t.tcp) {
      console.log("⏳ Binary received but TCP not connected yet");
      return;
    }

    t.tcp.write(msg);
    t.bytesSent += incomingLen;

    if (t.bytesSent % (1024 * 1024) < incomingLen) {
      console.log(`➡️ Forwarded ${t.bytesSent}/${t.bytesExpected} bytes`);
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
    const publicTypes = ["auth_signup", "auth_login", "ping"];
    if (!ws.username && !publicTypes.includes(data.type)) {
      console.log("🛑 Blocked unauthorized message:", data.type);
      return send(ws, { type: "error", message: "Not logged in" });
    }


// =========================
// 🔐 AUTH: SIGNUP
// =========================
if (data.type === "auth_signup") {
  const username = String(data.username || "").trim();
  const password = String(data.password || "");

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

  const user = {
    username,
    passwordHash,
    friends: [],
    createdAt: Date.now(),
  };

  saveUser(user);

  return send(ws, { type: "signup_ok", username });
}

// =========================
// 🔐 AUTH: LOGIN (password)
// =========================
if (data.type === "auth_login") {
  const username = String(data.username || "").trim();
  const password = String(data.password || "");
  const client = String(data.client || "unknown");

  if (!username) return send(ws, { type: "error", message: "Missing username" });
  if (!password) return send(ws, { type: "error", message: "Missing password" });

  const user = loadUser(username);
  if (!user) return send(ws, { type: "error", message: "Invalid username or password" });

  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return send(ws, { type: "error", message: "Invalid username or password" });

  // Enforce single online session per username (keep your behavior)
  // Enforce single session: kick old one (prevents "password incorrect" UX)
const prev = online.get(username);
if (prev && prev.readyState === WebSocket.OPEN) {
  try { send(prev, { type: "error", message: "Logged in elsewhere" }); } catch {}
  try { prev.close(4001, "Replaced by new login"); } catch {}
}
online.delete(username);


  ws.username = username;
  ws.client = client;

  ws.tcpPort = Number(data.tcpPort || 0);
  ws.candidates = Array.isArray(data.candidates) ? data.candidates : [];

  online.set(username, ws);

  send(ws, {
    type: "login_ok",
    username,
    publicIp: ws.publicIp,
    publicPort: ws.publicPort,
    client: ws.client,
  });

  // Send inbox (existing behavior)
  const pending = loadIntentsForUser(username);
  if (pending.length > 0) {
    send(ws, { type: "inbox", items: pending });
  } else {
    send(ws, { type: "inbox", items: [] });
  }

  // Also send friends list immediately
  const u2 = ensureUserShape(loadUser(username));
  send(ws, { type: "friends_list", friends: u2?.friends || [] });

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
    return send(ws, { type: "error", message: "Intent not found" });
  }

  const intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
  if (intent.to !== ws.username) {
    return send(ws, { type: "error", message: "Not authorized for this intent" });
  }
  if (!intent.stored || !intent.storedFile) {
    return send(ws, { type: "error", message: "File not stored on server" });
  }

  const filePath = path.join(FILES_DIR, intent.storedFile);
  if (!fs.existsSync(filePath)) {
    return send(ws, { type: "error", message: "Stored file missing" });
  }

  // Tell browser what's coming
  send(ws, {
    type: "download_ws_begin",
    intentId,
    name: intent.fileName,
    size: intent.fileSize,
  });

  const rs = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });

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

  tcp.on("error", err => {
    console.error("❌ TCP error:", err);
    activeTransfers.delete(intent.id);
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
  return; // silently ignore or keepalive ack not needed
}





// =========================
// 👥 FRIENDS: LIST
// =========================
if (data.type === "friends_list") {
  const u0 = loadUser(ws.username);
if (!u0) return send(ws, { type: "friends_list", friends: [] });

const user = ensureUserShape(u0);
return send(ws, { type: "friends_list", friends: user.friends });

  return send(ws, { type: "friends_list", friends: user?.friends || [] });
}

// =========================
// 👥 FRIENDS: ADD (symmetric)
// =========================
if (data.type === "add_friend") {
  const friend = String(data.username || "").trim();
  if (!friend) return send(ws, { type: "error", message: "Missing friend username" });
  if (friend === ws.username) return send(ws, { type: "error", message: "Cannot friend yourself" });

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

// FORCE STORAGE FOR WEBSITE USERS
if (!receiverWs || receiverWs.client !== "ios") {
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
    const writeStream = fs.createWriteStream(filePath, { flags: "w" });

    writeStream.on("error", (err) => {
      console.error("❌ File writeStream error:", err);
      activeTransfers.delete(intentId);
      ws.currentUploadIntentId = null;
      try { fs.unlinkSync(filePath); } catch {}
      try { send(ws, { type: "error", message: "Server failed writing file" }); } catch {}
    });

    activeTransfers.set(intentId, {
      mode: "offline",
      tcp: null,
      writeStream,
      filePath,
      bytesExpected: size,
      bytesSent: 0,
      ended: false,
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
  bytesExpected: size,
  bytesSent: 0,
  ended: false,
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
    try { t.tcp?.destroy(); } catch {}
    try { t.writeStream?.destroy(); } catch {}
    activeTransfers.delete(intentId);
    ws.currentUploadIntentId = null;
    return send(ws, { type: "error", message: "Upload incomplete (size mismatch)" });
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

    } catch {
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
  const fileName = String(data.fileName || "").trim();
  const fileSize = Number(data.fileSize || 0);

  if (!to || !fileName || !fileSize) {
    return send(ws, { type: "error", message: "Missing to/fileName/fileSize" });
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

  // ✅ Create + store intent even if receiver is offline
  const intent = {
    id: randomUUID(),
    from: ws.username,
    to,
    fileName,
    fileSize,
    createdAt: Date.now(),
    status: "pending", // pending | accepted | completed
  };

  if (!inboxes.has(to)) inboxes.set(to, []);
  inboxes.get(to).push(intent);
  saveIntent(intent);

  // ✅ Always acknowledge sender
  return send(ws, {
    type: "intent_ok",
    intentId: intent.id,
    to,
    fileName,
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
  });
});

server.listen(PORT, () => {
  console.log(`✅ Signaling server running on port ${PORT}`);

});