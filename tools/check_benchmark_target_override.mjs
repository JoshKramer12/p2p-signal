#!/usr/bin/env node
import WebSocket from "ws";

const httpBaseUrl = process.env.MERM_SIGNAL_HTTP_BASE_URL || "https://p2p-signal-staging.fly.dev";
const wsUrl = process.env.MERM_SIGNAL_WS_URL || "wss://p2p-signal-staging.fly.dev";
const fileSize = 23 * 1024 * 1024;
const fileName = "bench-23mb.mp4";

function waitForMessage(ws, predicate, timeoutMs = 15000, label = "message") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
  });
}

async function jsonReq(pathname, { method = "GET", headers = {}, body = null } = {}) {
  const res = await fetch(`${httpBaseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: body != null ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  return {
    status: res.status,
    payload,
    headers: Object.fromEntries(res.headers.entries())
  };
}

function uploadHostFromPayload(payload = null) {
  const directUrl = String(payload?.upload?.url || "").trim();
  if (!directUrl) return "";
  try {
    return String(new URL(directUrl).host || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

async function createBenchAuth() {
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("WebSocket connect timed out")), 15000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const username = `bench_diag_${suffix}`.slice(0, 32);
  const password = `bench-${suffix}-pw`;

  ws.send(JSON.stringify({
    type: "auth_signup",
    username,
    password,
    name: "Benchmark Diag"
  }));
  const signup = await waitForMessage(ws, (msg) => msg.type === "signup_ok" || msg.type === "error", 15000, "signup");
  if (signup.type === "error") throw new Error(String(signup.message || "signup failed"));

  ws.send(JSON.stringify({
    type: "auth_login",
    username,
    password,
    client: "web"
  }));
  const login = await waitForMessage(ws, (msg) => msg.type === "login_ok" || msg.type === "error", 15000, "login");
  if (login.type === "error") throw new Error(String(login.message || "login failed"));

  return {
    ws,
    username,
    sessionToken: String(login.sessionToken || "").trim()
  };
}

async function createIntent(ws, username, note = "benchmark target check") {
  const clientIntentId = `bench-diag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const waitAck = waitForMessage(
    ws,
    (msg) => (msg.type === "intent_ok" && msg.clientIntentId === clientIntentId) || msg.type === "error",
    15000,
    "intent_ok"
  );
  ws.send(JSON.stringify({
    type: "send_intent",
    clientIntentId,
    to: username,
    fileName,
    fileSize,
    uploadBytesExpected: fileSize,
    note
  }));
  const ack = await waitAck;
  if (ack.type === "error") throw new Error(String(ack.message || "intent failed"));
  return String(ack.intentId || "").trim();
}

async function initUpload(username, sessionToken, intentId, diagnosticStorageTarget = "") {
  return jsonReq(`/api/intents/${encodeURIComponent(intentId)}/object-upload/init`, {
    method: "POST",
    headers: {
      "x-merm-username": username,
      "x-merm-session": sessionToken
    },
    body: {
      name: fileName,
      size: fileSize,
      diagnosticUploadPlan: { mode: "single" },
      diagnosticStorageTarget: diagnosticStorageTarget || undefined
    }
  });
}

async function main() {
  const auth = await createBenchAuth();
  try {
    const defaultIntentId = await createIntent(auth.ws, auth.username, "benchmark default target check");
    const r2IntentId = await createIntent(auth.ws, auth.username, "benchmark r2 target check");

    const defaultInit = await initUpload(auth.username, auth.sessionToken, defaultIntentId, "");
    const r2Init = await initUpload(auth.username, auth.sessionToken, r2IntentId, "r2_global");

    process.stdout.write(`${JSON.stringify({
      default: {
        requestedDiagnosticStorageTarget: "",
        responseStorageTarget: defaultInit.payload?.storageTarget || null,
        uploadHost: uploadHostFromPayload(defaultInit.payload),
        uploadMode: String(defaultInit.payload?.upload?.mode || "").trim() || null
      },
      r2_global: {
        requestedDiagnosticStorageTarget: "r2_global",
        responseStorageTarget: r2Init.payload?.storageTarget || null,
        uploadHost: uploadHostFromPayload(r2Init.payload),
        uploadMode: String(r2Init.payload?.upload?.mode || "").trim() || null
      }
    }, null, 2)}\n`);
  } finally {
    try { auth.ws.close(); } catch {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
