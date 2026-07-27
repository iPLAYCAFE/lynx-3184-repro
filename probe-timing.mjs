// Diagnostic, not a repro: boots once and prints WHEN the lazy bundle is
// requested relative to navigation, and from which CDP target.
//
// This exists to check the harness's own premise. src/index.tsx claims the MAIN
// THREAD starts the lazy-bundle load at first screen (t≈0) while the background
// thread mounts the boundary at t≈delay. If the request instead appears at
// t≈delay, the main-thread kickoff never happened and the whole "background
// arrives inside the window" setup is measuring nothing.
//
// Usage: node probe-timing.mjs [delayMs]

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(root, "www");
const delay = Number(process.argv[2] ?? 1200);

const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

function serveDist(dir) {
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let filePath = path.join(dir, urlPath);
    if (urlPath.endsWith("/")) filePath = path.join(filePath, "index.html");
    if (!filePath.startsWith(dir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
    });
    response.end(readFileSync(filePath));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

let messageId = 0;
function createCdp(socket) {
  const pending = new Map();
  const listeners = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });
  return {
    on(listener) {
      listeners.push(listener);
    },
    send(method, params = {}, sessionId) {
      const id = ++messageId;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => {
        pending.set(id, (message) =>
          message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
        setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      });
    },
  };
}

const { server, port } = await serveDist(distDir);
const browserPath = process.env.REPRO_BROWSER
  ?? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((c) => existsSync(c));

const browser = spawn(browserPath, [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  `--user-data-dir=${path.join(root, ".repro-profile", "probe")}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const devtoolsOrigin = await new Promise((resolve, reject) => {
  let text = "";
  browser.stderr.on("data", (chunk) => {
    text += String(chunk);
    const match = text.match(/DevTools listening on ws:\/\/([^/]+)/);
    if (match) resolve(match[1]);
  });
  setTimeout(() => reject(new Error("no devtools endpoint")), 25_000);
});

const created = await fetch(
  `http://${devtoolsOrigin}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?delay=${delay}`)}`,
  { method: "PUT" },
).then((r) => r.json());

const socket = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
const cdp = createCdp(socket);

const t0 = Date.now();
const events = [];
cdp.on((message) => {
  const from = message.sessionId ? `worker:${message.sessionId.slice(0, 6)}` : "page";
  if (message.method === "Network.requestWillBeSent") {
    events.push({
      at: Date.now() - t0,
      kind: "request",
      from,
      url: message.params.request.url.replace(`http://127.0.0.1:${port}`, ""),
    });
  } else if (message.method === "Runtime.consoleAPICalled") {
    events.push({
      at: Date.now() - t0,
      kind: `console.${message.params.type}`,
      from,
      url: (message.params.args ?? []).map((a) => a.description ?? a.value ?? "").join(" ").slice(0, 140),
    });
  } else if (message.method === "Target.attachedToTarget") {
    const sessionId = message.params.sessionId;
    events.push({
      at: Date.now() - t0,
      kind: "target",
      from: `worker:${sessionId.slice(0, 6)}`,
      url: message.params.targetInfo.url.replace(`http://127.0.0.1:${port}`, "").slice(0, 90),
    });
    cdp.send("Network.enable", {}, sessionId).catch(() => {});
    cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
  }
});

await cdp.send("Network.enable");
await cdp.send("Runtime.enable");
await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

await new Promise((resolve) => setTimeout(resolve, delay + 2500));

const MARKER = `(() => {
  const view = document.querySelector('lynx-view');
  if (!view || !view.shadowRoot) return '{}';
  let eager=false, lazy=false;
  (function walk(n){ for (const el of n.querySelectorAll('*')) {
    const id = el.getAttribute && el.getAttribute('id');
    if (id==='eager-marker') eager=true; else if (id==='lazy-marker') lazy=true;
    if (el.shadowRoot) walk(el.shadowRoot);
  }})(view.shadowRoot);
  return JSON.stringify({eager,lazy});
})()`;
const marker = await cdp.send("Runtime.evaluate", { expression: MARKER, returnByValue: true });

console.log(`delay=${delay}ms — event timeline (ms from CDP attach):\n`);
for (const event of events) {
  if (event.kind === "request" && !/\.(bundle|js|wasm|css|html)$/.test(event.url) && !event.url.includes("?")) continue;
  console.log(`  ${String(event.at).padStart(6)}  ${event.from.padEnd(14)} ${event.kind.padEnd(16)} ${event.url}`);
}
console.log(`\nmarkers: ${marker.result.value}`);

socket.close();
browser.kill();
server.close();
