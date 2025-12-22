const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;


// username -> ws
const online = new Map();

// username -> [intent, intent, intent]
const inboxes = new Map();

const server = http.createServer();
const wss = new WebSocket.Server({ server });

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
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


wss.on("connection", (ws, req) => {

  const endpoint = getPublicEndpoint(req);
ws.publicIp = endpoint.ip;
ws.publicPort = endpoint.port;

console.log("🌍 Client public endpoint:", ws.publicIp, ws.publicPort);


  console.log("🔌 WebSocket client connected");

  ws.username = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
      console.log("📩 Message received:", data);

    } catch {
      return send(ws, { type: "error", message: "Bad JSON" });
    }

    // 1) login
    // 1) login
if (data.type === "login") {
  const name = String(data.username || "").trim();
  if (!name) return send(ws, { type: "error", message: "Missing username" });
  if (online.has(name)) return send(ws, { type: "error", message: "Username already online" });

  ws.username = name;
  ws.tcpPort = Number(data.tcpPort || 0);
  ws.candidates = Array.isArray(data.candidates) ? data.candidates : [];

  online.set(name, ws);

  send(ws, {
    type: "login_ok",
    username: name,
    publicIp: ws.publicIp,
    publicPort: ws.publicPort,
  });

  return;
}




    // Require login for everything else
    if (!ws.username) {
      return send(ws, { type: "error", message: "Not logged in" });
    }

    // 2) who is online?
    if (data.type === "who") {
      return send(ws, { type: "online_list", users: Array.from(online.keys()) });
    }


    // 3a) send intent only (NO transport)
    // 3a) send intent only (NO transport)
if (data.type === "send_intent") {
  const to = String(data.to || "").trim();
  const fileName = String(data.fileName || "").trim();
  const fileSize = Number(data.fileSize || 0);

  if (!to || !fileName || !fileSize) {
    return send(ws, { type: "error", message: "Missing to/fileName/fileSize" });
  }

  // ✅ Create + store intent even if receiver is offline
  const intent = {
    id: randomUUID(),
    from: ws.username,
    to,
    fileName,
    fileSize,
    createdAt: Date.now(),
  };

  if (!inboxes.has(to)) inboxes.set(to, []);
  inboxes.get(to).push(intent);

  // 🔔 If receiver is online, notify immediately
  const receiver = online.get(to);
  if (receiver) {
    send(receiver, {
      type: "incoming_file",
      intent,
    });
  }

  // ✅ Always acknowledge sender
  return send(ws, {
    type: "intent_ok",
    intentId: intent.id,
    to,
    fileName,
  });
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
