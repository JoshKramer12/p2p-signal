#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dns from "node:dns";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

function parseArgs(argv = []) {
  const out = {
    wsUrl: process.env.ACCOUNT_UPLOAD_BENCH_WS_URL || process.env.MERM_SIGNAL_WS_URL || "ws://127.0.0.1:3000",
    httpBaseUrl: process.env.ACCOUNT_UPLOAD_BENCH_HTTP_BASE_URL || process.env.MERM_SIGNAL_HTTP_BASE_URL || "http://127.0.0.1:3000",
    file: "/Users/josh/Desktop/1000.dat",
    concurrency: 0,
    runs: 1,
    label: "",
    timeoutMs: 180000,
    retries: 3,
    hostOverrides: {}
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    const next = argv[i + 1];
    if (arg === "--ws-url" && next) { out.wsUrl = String(next); i += 1; continue; }
    if (arg === "--http-base-url" && next) { out.httpBaseUrl = String(next); i += 1; continue; }
    if (arg === "--file" && next) { out.file = String(next); i += 1; continue; }
    if (arg === "--concurrency" && next) { out.concurrency = Math.max(0, Number(next) || 0); i += 1; continue; }
    if (arg === "--runs" && next) { out.runs = Math.max(1, Number(next) || 1); i += 1; continue; }
    if (arg === "--label" && next) { out.label = String(next); i += 1; continue; }
    if (arg === "--timeout-ms" && next) { out.timeoutMs = Math.max(0, Number(next) || 0); i += 1; continue; }
    if (arg === "--retries" && next) { out.retries = Math.max(1, Number(next) || 1); i += 1; continue; }
    if (arg === "--resolve-host" && next) {
      const [host, ip] = String(next).split("=");
      if (host && ip) out.hostOverrides[String(host).trim().toLowerCase()] = String(ip).trim();
      i += 1;
      continue;
    }
  }
  return out;
}

function applyHostOverrides(overrides = {}) {
  const entries = Object.entries(overrides || {})
    .map(([host, ip]) => [String(host || "").trim().toLowerCase(), String(ip || "").trim()])
    .filter(([host, ip]) => host && ip);
  if (!entries.length) return;
  const byHost = new Map(entries);
  const originalLookup = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, callback) => {
    const host = String(hostname || "").trim().toLowerCase();
    const ip = byHost.get(host);
    if (!ip) return originalLookup(hostname, options, callback);
    const family = ip.includes(":") ? 6 : 4;
    if (typeof options === "function") {
      process.nextTick(() => options(null, ip, family));
      return;
    }
    if (options?.all) {
      process.nextTick(() => callback(null, [{ address: ip, family }]));
      return;
    }
    process.nextTick(() => callback(null, ip, family));
  };
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function withTimeout(promise, timeoutMs, label = "operation") {
  if (!timeoutMs) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function jsonReq(baseUrl, pathname, {
  method = "GET",
  headers = {},
  body = null,
  timeoutMs = 0
} = {}) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: body != null ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller?.signal
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const err = new Error(String(payload?.message || `HTTP ${res.status}`));
      err.status = res.status;
      err.payload = payload;
      err.headers = Object.fromEntries(res.headers.entries());
      throw err;
    }
    return payload || {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("WebSocket connect timed out")), 15000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs, label) {
  return withTimeout(new Promise((resolve, reject) => {
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
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
  }), timeoutMs, label);
}

async function signupAndLogin(ws, opts) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const username = `bench_${suffix}`.slice(0, 32);
  const password = `bench-${suffix}-pw`;
  ws.send(JSON.stringify({
    type: "auth_signup",
    username,
    password,
    name: "Bench User"
  }));
  await waitForMessage(ws, (msg) => msg.type === "signup_ok" || msg.type === "error", opts.timeoutMs, "signup").then((msg) => {
    if (msg.type === "error") throw new Error(String(msg.message || "signup failed"));
  });

  ws.send(JSON.stringify({
    type: "auth_login",
    username,
    password,
    client: "web"
  }));
  const login = await waitForMessage(ws, (msg) => msg.type === "login_ok" || msg.type === "error", opts.timeoutMs, "login");
  if (login.type === "error") throw new Error(String(login.message || "login failed"));
  return {
    username,
    sessionToken: String(login.sessionToken || "").trim()
  };
}

async function createSelfIntent(ws, username, fileName, fileSize, timeoutMs) {
  const clientIntentId = `bench-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const waitAck = waitForMessage(
    ws,
    (msg) => (msg.type === "intent_ok" && msg.clientIntentId === clientIntentId) || msg.type === "error",
    timeoutMs,
    "intent_ok"
  );
  ws.send(JSON.stringify({
    type: "send_intent",
    clientIntentId,
    to: username,
    fileName,
    fileSize,
    uploadBytesExpected: fileSize,
    note: "account upload benchmark"
  }));
  const ack = await waitAck;
  if (ack.type === "error") throw new Error(String(ack.message || "intent failed"));
  const intentId = String(ack.intentId || "").trim();
  if (!intentId) throw new Error("Missing intentId");
  return intentId;
}

async function putPart(url, headers, buffer, timeoutMs = 0) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        ...(headers || {}),
        "content-length": String(buffer.byteLength)
      },
      body: buffer,
      signal: controller?.signal,
      cache: "no-store"
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const err = new Error(`PUT ${res.status}${bodyText ? ` ${bodyText.slice(0, 220)}` : ""}`);
      err.status = res.status;
      throw err;
    }
    return { etag: String(res.headers.get("etag") || "").replace(/"/g, "") };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fmtSeconds(ms = 0) {
  return (Math.max(0, ms) / 1000).toFixed(2);
}

function fmtMbps(bytes = 0, ms = 1) {
  const bps = Math.max(0, bytes) / Math.max(0.001, ms / 1000);
  return (bps * 8 / 1_000_000).toFixed(1);
}

function parseRetryAfterMs(value = "") {
  const seconds = Number(String(value || "").trim());
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(10000, Math.round(seconds * 1000));
  return 2000;
}

async function runOnce(opts) {
  const stat = await fs.stat(opts.file);
  const fileSize = Number(stat.size || 0);
  const fileName = path.basename(opts.file);
  if (!fileSize) throw new Error(`File is empty: ${opts.file}`);

  const ws = await connectWs(opts.wsUrl);
  const authStart = performance.now();
  const auth = await signupAndLogin(ws, opts);
  const authMs = performance.now() - authStart;
  const authHeaders = {
    "x-merm-username": auth.username,
    "x-merm-session": auth.sessionToken
  };

  try {
    const intentStart = performance.now();
    const intentId = await createSelfIntent(ws, auth.username, fileName, fileSize, opts.timeoutMs);
    const intentMs = performance.now() - intentStart;

    const initStart = performance.now();
    const initPayload = await jsonReq(opts.httpBaseUrl, `/api/intents/${encodeURIComponent(intentId)}/object-upload/init`, {
      method: "POST",
      headers: authHeaders,
      body: {
        name: fileName,
        size: fileSize
      },
      timeoutMs: opts.timeoutMs
    });
    const initMs = performance.now() - initStart;
    const mode = String(initPayload?.upload?.mode || "").trim().toLowerCase();
    if (mode === "single") {
      const upload = initPayload?.upload || {};
      if (!upload?.url) throw new Error("Missing single upload URL");

      const uploadStart = performance.now();
      const buffer = await fs.readFile(opts.file);
      await putPart(upload.url, upload.headers || {}, buffer, opts.timeoutMs);
      const uploadMs = performance.now() - uploadStart;

      const completeStart = performance.now();
      await jsonReq(opts.httpBaseUrl, `/api/intents/${encodeURIComponent(intentId)}/object-upload/complete`, {
        method: "POST",
        headers: authHeaders,
        body: {
          size: fileSize
        },
        timeoutMs: opts.timeoutMs
      });
      const completeMs = performance.now() - completeStart;

      return {
        mode,
        fileSize,
        totalParts: 1,
        partSize: fileSize,
        serverMaxConcurrency: 1,
        usedConcurrency: 1,
        authMs,
        intentMs,
        initMs,
        planMs: 0,
        uploadMs,
        completeMs,
        totalMs: authMs + intentMs + initMs + uploadMs + completeMs,
        uploadedBytes: fileSize,
        p50PartMs: uploadMs,
        p95PartMs: uploadMs,
        maxPartMs: uploadMs,
        retryCount: 0,
        intentId
      };
    }
    if (mode !== "multipart") throw new Error(`Expected single or multipart mode, got ${mode || "unknown"}`);

    const uploadId = String(initPayload?.upload?.uploadId || "").trim();
    const partSize = Math.max(5 * 1024 * 1024, Number(initPayload?.upload?.partSize || 0));
    const totalParts = Math.max(1, Number(initPayload?.upload?.totalParts || Math.ceil(fileSize / partSize)));
    const serverMaxConcurrency = Math.max(1, Number(initPayload?.upload?.maxConcurrency || 1));
    const concurrency = Math.max(1, opts.concurrency || serverMaxConcurrency);

    const allPartNumbers = Array.from({ length: totalParts }, (_, idx) => idx + 1);
    const planStart = performance.now();
    const partsPayload = await jsonReq(opts.httpBaseUrl, `/api/intents/${encodeURIComponent(intentId)}/object-upload/parts`, {
      method: "POST",
      headers: authHeaders,
      body: {
        uploadId,
        partNumbers: allPartNumbers
      },
      timeoutMs: opts.timeoutMs
    });
    const planMs = performance.now() - planStart;
    const planCache = new Map();
    for (const row of Array.isArray(partsPayload?.parts) ? partsPayload.parts : []) {
      const partNumber = Math.max(1, Number(row?.partNumber || 0));
      if (!Number.isFinite(partNumber) || !row?.upload?.url) continue;
      planCache.set(partNumber, row.upload);
    }

    const fh = await fs.open(opts.file, "r");
    const completedParts = [];
    const partDurationsMs = [];
    const partAttempts = [];
    let uploadedBytes = 0;
    let nextIdx = 0;
    const uploadStart = performance.now();

    const getPartPlan = async (partNumber) => {
      const cached = planCache.get(partNumber);
      if (cached?.url) return cached;
      const row = await jsonReq(opts.httpBaseUrl, `/api/intents/${encodeURIComponent(intentId)}/object-upload/part`, {
        method: "POST",
        headers: authHeaders,
        body: { uploadId, partNumber },
        timeoutMs: opts.timeoutMs
      });
      const upload = row?.upload || null;
      if (!upload?.url) throw new Error(`Missing signed URL for part ${partNumber}`);
      planCache.set(partNumber, upload);
      return upload;
    };

    const worker = async () => {
      while (true) {
        const idx = nextIdx;
        nextIdx += 1;
        if (idx >= totalParts) return;
        const partNumber = idx + 1;
        const start = (partNumber - 1) * partSize;
        const endExclusive = Math.min(fileSize, start + partSize);
        const bytes = Math.max(0, endExclusive - start);
        const buffer = Buffer.allocUnsafe(bytes);
        await fh.read(buffer, 0, bytes, start);

        let lastErr = null;
        const partStart = performance.now();
        for (let attempt = 1; attempt <= opts.retries; attempt += 1) {
          try {
            const plan = await getPartPlan(partNumber);
            const result = await putPart(plan.url, plan.headers || {}, buffer, opts.timeoutMs);
            partDurationsMs.push(performance.now() - partStart);
            partAttempts.push(attempt);
            uploadedBytes += bytes;
            completedParts.push({
              partNumber,
              etag: String(result?.etag || "").trim(),
              size: bytes
            });
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            planCache.delete(partNumber);
            if (attempt >= opts.retries) break;
            await wait(Math.min(5000, 350 * Math.pow(1.7, attempt - 1)));
          }
        }
        if (lastErr) throw lastErr;
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, totalParts) }, () => worker()));
    const uploadMs = performance.now() - uploadStart;
    await fh.close();
    completedParts.sort((a, b) => a.partNumber - b.partNumber);

    const completeStart = performance.now();
    const etagCount = completedParts.filter((part) => String(part?.etag || "").trim()).length;
    console.log(`[bench_debug] multipart uploadedParts=${completedParts.length} etagCount=${etagCount} uploadedBytes=${uploadedBytes}`);
    let completeAttempt = 0;
    while (true) {
      completeAttempt += 1;
      try {
        await jsonReq(opts.httpBaseUrl, `/api/intents/${encodeURIComponent(intentId)}/object-upload/complete`, {
          method: "POST",
          headers: authHeaders,
          body: {
            uploadId,
            size: fileSize,
            parts: completedParts
          },
          timeoutMs: opts.timeoutMs
        });
        break;
      } catch (err) {
        const retryable = Boolean(err?.payload?.retryable) || Number(err?.status || 0) === 503;
        if (!retryable || completeAttempt >= opts.retries) throw err;
        const retryAfter = parseRetryAfterMs(err?.headers?.["retry-after"]);
        console.log(`[bench_debug] complete_retry attempt=${completeAttempt} status=${Number(err?.status || 0)} waitMs=${retryAfter}`);
        await wait(retryAfter);
      }
    }
    const completeMs = performance.now() - completeStart;

    partDurationsMs.sort((a, b) => a - b);
    const p50 = partDurationsMs.length ? partDurationsMs[Math.floor(partDurationsMs.length * 0.5)] : 0;
    const p95 = partDurationsMs.length ? partDurationsMs[Math.floor(partDurationsMs.length * 0.95)] : 0;
    const maxPartMs = partDurationsMs.length ? partDurationsMs[partDurationsMs.length - 1] : 0;
    const retryCount = partAttempts.reduce((sum, attempt) => sum + Math.max(0, Number(attempt || 1) - 1), 0);

    return {
      mode,
      fileSize,
      totalParts,
      partSize,
      serverMaxConcurrency,
      usedConcurrency: concurrency,
      authMs,
      intentMs,
      initMs,
      planMs,
      uploadMs,
      completeMs,
      totalMs: authMs + intentMs + initMs + planMs + uploadMs + completeMs,
      uploadedBytes,
      p50PartMs: p50,
      p95PartMs: p95,
      maxPartMs,
      retryCount,
      intentId
    };
  } finally {
    try { ws.close(); } catch {}
  }
}

function printResult(index, run, label = "") {
  const prefix = label ? `[${label}] ` : "";
  console.log(`${prefix}run=${index + 1}`);
  console.log(`${prefix}mode=${run.mode} size=${run.fileSize} parts=${run.totalParts} partSize=${run.partSize} serverHint=${run.serverMaxConcurrency} usedConcurrency=${run.usedConcurrency}`);
  console.log(`${prefix}timings_s auth=${fmtSeconds(run.authMs)} intent=${fmtSeconds(run.intentMs)} init=${fmtSeconds(run.initMs)} plan=${fmtSeconds(run.planMs)} upload=${fmtSeconds(run.uploadMs)} complete=${fmtSeconds(run.completeMs)} total=${fmtSeconds(run.totalMs)}`);
  console.log(`${prefix}throughput_mbps upload=${fmtMbps(run.uploadedBytes, run.uploadMs)} end_to_end=${fmtMbps(run.uploadedBytes, run.totalMs)}`);
  console.log(`${prefix}part_latency_s p50=${fmtSeconds(run.p50PartMs)} p95=${fmtSeconds(run.p95PartMs)} max=${fmtSeconds(run.maxPartMs)} retries=${run.retryCount}`);
  console.log(`${prefix}intentId=${run.intentId}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  applyHostOverrides(opts.hostOverrides);
  const results = [];
  for (let i = 0; i < opts.runs; i += 1) {
    const run = await runOnce(opts);
    results.push(run);
    printResult(i, run, opts.label);
  }
}

main().catch((err) => {
  console.error("bench_error", err?.stack || err?.message || err);
  process.exit(1);
});
