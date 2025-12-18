const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;


// username -> ws
const online = new Map();

const server = http.createServer();
const wss = new WebSocket.Server({ server });

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
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
  ws.ip = data.ip;       // ⬅️ ADD THIS
  ws.port = data.port;  // ⬅️ ADD THIS

  online.set(name, ws);

  send(ws, { type: "login_ok", username: name });
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
return send(ws, {
  type: "send_now",
  ip: receiver.ip,
  port: receiver.port,
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
