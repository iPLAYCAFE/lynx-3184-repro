// Diagnostic for the `engineVersion: '3.9'` (FetchBundle) build.
//
// That build produces a SILENT failure: no "Snapshot not found", but the lazy
// subtree never renders. ReactLynx's async FetchBundle path resolves `lazy()`
// only inside the `callLepusMethod(PREPARE_LAZY_BUNDLE_MTS, …)` callback:
//
//   lynx.getNativeApp().callLepusMethod(PREPARE_LAZY_BUNDLE_MTS, {url, host},
//     () => { fetchBundleBgCache.set(source, btsResult); resolve(btsResult); });
//
// so a callback that never fires looks exactly like what we observe. This probe
// runs INSIDE the background-thread worker and asks three things directly:
// does `lynx.fetchBundle` exist, does it resolve, and does the prepare
// callback ever fire.
//
// Usage: node probe-fetchbundle.mjs

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(root, "www");

const lazyDir = path.join(distDir, "async", "src");
const lazyFile = readdirSync(lazyDir).find((f) => f.endsWith(".bundle"));
if (!lazyFile) throw new Error("no lazy bundle in www/async/src");
const lazyPath = `/async/src/${lazyFile}`;

const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};

const server = http.createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, "http://x").pathname);
  let filePath = path.join(distDir, urlPath);
  if (urlPath.endsWith("/")) filePath = path.join(filePath, "index.html");
  if (!filePath.startsWith(distDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
  });
  response.end(readFileSync(filePath));
});
const port = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

let messageId = 0;
function createCdp(socket) {
  const pending = new Map();
  const listeners = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) for (const l of listeners) l(message);
  });
  return {
    on: (l) => listeners.push(l),
    send(method, params = {}, sessionId) {
      const id = ++messageId;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => {
        pending.set(id, (m) => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
        setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      });
    },
  };
}

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
  `--user-data-dir=${path.join(root, ".repro-profile", "fbprobe")}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const devtoolsOrigin = await new Promise((resolve, reject) => {
  let text = "";
  browser.stderr.on("data", (chunk) => {
    text += String(chunk);
    const m = text.match(/DevTools listening on ws:\/\/([^/]+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("no devtools endpoint")), 25_000);
});

const created = await fetch(
  `http://${devtoolsOrigin}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?delay=0`)}`,
  { method: "PUT" },
).then((r) => r.json());

const socket = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((r) => socket.addEventListener("open", r));
const cdp = createCdp(socket);

const workers = [];
cdp.on((message) => {
  if (message.method === "Target.attachedToTarget") {
    workers.push({
      sessionId: message.params.sessionId,
      url: message.params.targetInfo.url,
    });
  }
});
await cdp.send("Runtime.enable");
await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

// Let the app boot fully; the lazy bundle is already fetched by then.
await new Promise((r) => setTimeout(r, 4000));

const bts = workers.find((w) => w.url.includes("web-core-worker-chunk"));
if (!bts) {
  console.log("background-thread worker target not found; attached targets:");
  for (const w of workers) console.log("  " + w.url);
  process.exit(1);
}

const EXPR = `(async () => {
  const out = {};
  const url = ${JSON.stringify(lazyPath)};
  out.lynx = typeof lynx;
  out.fetchBundle = typeof lynx?.fetchBundle;
  out.loadScript = typeof lynx?.loadScript;
  out.getNativeApp = typeof lynx?.getNativeApp;
  out.callLepusMethod = typeof lynx?.getNativeApp?.()?.callLepusMethod;
  try {
    const handler = lynx.fetchBundle(url, {});
    out.handlerType = typeof handler;
    out.handlerHasThen = typeof handler?.then;
    out.handlerHasWait = typeof handler?.wait;   // the sync path needs .wait()
    const res = await Promise.race([
      Promise.resolve(handler),
      new Promise((r) => setTimeout(() => r("__TIMEOUT__"), 4000)),
    ]);
    out.fetchResult = res === "__TIMEOUT__"
      ? "TIMEOUT (never settled)"
      : { code: res?.code, url: res?.url, keys: res && Object.keys(res) };
  } catch (e) { out.fetchThrew = String(e && e.message || e); }
  // The decisive one: does the prepare-MTS callback ever come back?
  try {
    out.prepareCallback = await Promise.race([
      new Promise((r) => {
        lynx.getNativeApp().callLepusMethod(
          "rLynxPrepareLazyBundleMTS", { url, host: undefined }, () => r("FIRED"),
        );
      }),
      new Promise((r) => setTimeout(() => r("NEVER FIRED (4s)"), 4000)),
    ]);
  } catch (e) { out.prepareThrew = String(e && e.message || e); }
  return JSON.stringify(out, null, 2);
})()`;

// Control first: a probe that returns nothing is a broken instrument, not a
// finding. Prove the session evaluates at all, and that `lynx` is reachable in
// THIS realm, before believing anything the real probe says.
const control = await cdp.send(
  "Runtime.evaluate",
  {
    expression:
      `JSON.stringify({ control: 1 + 1, hasLynx: typeof lynx, globals: Object.getOwnPropertyNames(globalThis).filter(k => /lynx|Lynx|tt/.test(k)).slice(0, 12) })`,
    returnByValue: true,
  },
  bts.sessionId,
);
console.log("control (must be non-empty or the probe below means nothing):");
console.log("  " + JSON.stringify(control.result));
if (control.exceptionDetails) {
  console.log("  control threw: " + JSON.stringify(control.exceptionDetails.text));
}

const result = await cdp.send(
  "Runtime.evaluate",
  { expression: EXPR, awaitPromise: true, returnByValue: true },
  bts.sessionId,
);

console.log("\nbackground-thread probe (engineVersion 3.9 / FetchBundle build):\n");
if (result.exceptionDetails) {
  console.log("probe threw: " + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
}
console.log(result.result?.value ?? `raw result: ${JSON.stringify(result, null, 2)}`);

socket.close();
browser.kill();
server.close();
