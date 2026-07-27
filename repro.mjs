// Reproduction harness for lynx-family/lynx-stack#3184.
//
// Serves www/ and boots it in headless Chrome over raw CDP (no Playwright, no
// downloaded browser — uses a locally installed Chrome/Edge). For each boot it
// classifies the outcome:
//
//   pass          the lazy subtree rendered (#lazy-marker is in the DOM)
//   snapshot      "Snapshot not found: __snapshot_…" was reported -> #3184
//   blank         booted (eager shell present) but the lazy subtree never
//                 appeared and no snapshot error was seen
//   noboot        the eager shell never appeared (harness/browser problem,
//                 NOT a finding — reported separately so it can never be
//                 silently counted as evidence either way)
//
// Usage:
//   node repro.mjs                          # sweep the default delay grid
//   node repro.mjs --delay 40 --runs 20     # 20 boots at one delay
//   node repro.mjs --sweep 0:200:10 --runs 5
//   REPRO_BROWSER=<path to chrome.exe>      # override browser discovery
//
// The `--delay` value is forwarded to the app as
// `lynx.__globalProps.reproDelayMs` and is how long AFTER first screen the
// BACKGROUND thread waits before mounting the lazy boundary. The main thread
// always renders it at first screen. See src/index.tsx.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(root, "www");

const BOOT_TIMEOUT_MS = 15_000;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function findBrowser() {
  if (process.env.REPRO_BROWSER) return process.env.REPRO_BROWSER;
  const candidates = process.platform === "win32"
    ? [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ]
    : [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".bundle": "application/octet-stream",
};

function serveDist(dir) {
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let filePath = path.join(dir, urlPath);
    if (urlPath.endsWith("/")) filePath = path.join(filePath, "index.html");
    if (!filePath.startsWith(dir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      // Logged rather than silent: a repro should not contain an unexplained
      // 404. (The only one in a clean run is /favicon.ico, which Chrome always
      // asks for and this host does not ship.)
      if (process.env.REPRO_LOG_404) console.log(`  [404] ${urlPath}`);
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
          message.error
            ? reject(new Error(`${method}: ${message.error.message}`))
            : resolve(message.result));
        setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      });
    },
  };
}

function launchBrowser(browserPath, attempt) {
  const browser = spawn(
    browserPath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${path.join(root, ".repro-profile", String(attempt))}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let stderrText = "";
    const timer = setTimeout(() => {
      browser.kill();
      reject(new Error("no DevTools endpoint within 25s"));
    }, 25_000);
    browser.stderr.on("data", (chunk) => {
      stderrText += String(chunk);
      const match = stderrText.match(/DevTools listening on ws:\/\/([^/]+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ browser, devtoolsOrigin: match[1] });
      }
    });
    browser.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited before it was ready (code ${code})`));
    });
  });
}

// Walks <lynx-view>'s shadow tree (Lynx renders into it, and web-elements nest
// their own shadow roots) looking for the two markers.
const MARKER_PROBE = `(() => {
  const view = document.querySelector('lynx-view');
  if (!view || !view.shadowRoot) return JSON.stringify({ eager: false, lazy: false });
  let eager = false, lazy = false, rows = 0;
  (function walk(node) {
    for (const el of node.querySelectorAll('*')) {
      const id = el.getAttribute && el.getAttribute('id');
      if (id === 'eager-marker') eager = true;
      else if (id === 'lazy-marker') lazy = true;
      const cls = (el.getAttribute && el.getAttribute('class')) || '';
      if (cls.indexOf('row-') === 0) rows++;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  })(view.shadowRoot);
  return JSON.stringify({ eager, lazy, rows });
})()`;

const SNAPSHOT_PATTERN = /Snapshot not found:\s*(\S+)/;

async function bootOnce(devtoolsOrigin, url, cpuRate) {
  // Open blank first so CPU throttling is in place BEFORE the page loads.
  const created = await fetch(
    `http://${devtoolsOrigin}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  ).then((response) => response.json());

  const socket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
  });

  const messages = [];
  const cdp = createCdp(socket);
  cdp.on((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      messages.push(
        (message.params.args ?? [])
          .map((a) => a.description ?? a.value ?? "")
          .join(" "),
      );
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      messages.push(details?.exception?.description ?? details?.text ?? "");
    } else if (message.method === "Log.entryAdded") {
      messages.push(message.params.entry?.text ?? "");
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  // The background thread is a Worker; its console/errors only arrive if we
  // attach to that target too.
  cdp.on((message) => {
    if (message.method === "Target.attachedToTarget") {
      const sessionId = message.params.sessionId;
      cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
      cdp.send("Log.enable", {}, sessionId).catch(() => {});
    }
  });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  }).catch(() => {});

  // Emulate the loaded CI runner this was first observed on. The main-thread
  // realm runs on the PAGE thread, so slowing the page stretches the interval
  // between the lazy bundle being decoded (which populates the worker's
  // templateCache) and the page thread finishing loadScript + processEvalResult.
  if (cpuRate > 1) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate }).catch(() => {});
  }
  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Page.navigate", { url });

  const started = Date.now();
  let marker = { eager: false, lazy: false, rows: 0 };
  let snapshotId = null;
  while (Date.now() - started < BOOT_TIMEOUT_MS) {
    const hit = messages.map((m) => SNAPSHOT_PATTERN.exec(m)).find(Boolean);
    if (hit) {
      snapshotId = hit[1];
      break;
    }
    const result = await cdp
      .send("Runtime.evaluate", { expression: MARKER_PROBE, returnByValue: true })
      .catch(() => null);
    if (result?.result?.value) marker = JSON.parse(result.result.value);
    if (marker.lazy) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  socket.close();
  await fetch(`http://${devtoolsOrigin}/json/close/${created.id}`).catch(() => {});

  let outcome;
  if (snapshotId) outcome = "snapshot";
  else if (marker.lazy) outcome = "pass";
  else if (marker.eager) outcome = "blank";
  else outcome = "noboot";
  return { outcome, snapshotId, marker, messages };
}

async function run() {
  if (!existsSync(path.join(distDir, "index.html"))) {
    console.error("repro FAILED: www/index.html missing — run `pnpm run build` first.");
    process.exit(1);
  }
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error("repro FAILED: no Chrome/Edge found — set REPRO_BROWSER.");
    process.exit(1);
  }

  const runs = Number(arg("runs", "10"));
  const cpuRate = Number(arg("cpu", "1"));
  const singleDelay = arg("delay", null);
  const sweepSpec = arg("sweep", singleDelay === null ? "0:160:10" : null);
  const delays = [];
  if (singleDelay !== null) {
    delays.push(Number(singleDelay));
  } else {
    const [from, to, step] = sweepSpec.split(":").map(Number);
    for (let d = from; d <= to; d += step) delays.push(d);
  }

  const { server, port } = await serveDist(distDir);
  let browser, devtoolsOrigin;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ({ browser, devtoolsOrigin } = await launchBrowser(browserPath, attempt));
      break;
    } catch (error) {
      console.error(`browser launch attempt ${attempt}/3 failed: ${error.message}`);
      if (attempt === 3) {
        server.close();
        process.exit(1);
      }
    }
  }

  console.log(
    `lynx-stack#3184 repro — ${delays.length} delay value(s) x ${runs} boot(s) `
      + `= ${delays.length * runs} boots, cpuThrottle=${cpuRate}x\n`,
  );
  console.log("delay(ms)  pass  snapshot  blank  noboot   snapshot ids");
  console.log("---------  ----  --------  -----  ------   ------------");

  const table = [];
  let firstFailureMessages = null;
  for (const delay of delays) {
    const tally = { pass: 0, snapshot: 0, blank: 0, noboot: 0 };
    const ids = new Set();
    for (let i = 0; i < runs; i++) {
      const url = `http://127.0.0.1:${port}/?delay=${delay}`;
      let result;
      try {
        result = await bootOnce(devtoolsOrigin, url, cpuRate);
      } catch (error) {
        console.error(`  boot error at delay=${delay}: ${error.message}`);
        tally.noboot++;
        continue;
      }
      tally[result.outcome]++;
      if (result.snapshotId) ids.add(result.snapshotId);
      if (result.outcome === "snapshot" && !firstFailureMessages) {
        firstFailureMessages = { delay, messages: result.messages };
      }
    }
    table.push({ delay, ...tally, ids: [...ids] });
    console.log(
      `${String(delay).padStart(9)}  ${String(tally.pass).padStart(4)}  `
        + `${String(tally.snapshot).padStart(8)}  ${String(tally.blank).padStart(5)}  `
        + `${String(tally.noboot).padStart(6)}   ${[...ids].join(", ")}`,
    );
  }

  browser.kill();
  server.close();

  const totalSnapshot = table.reduce((sum, row) => sum + row.snapshot, 0);
  const totalBoots = table.reduce(
    (sum, row) => sum + row.pass + row.snapshot + row.blank + row.noboot,
    0,
  );
  console.log(
    `\n${totalSnapshot}/${totalBoots} boots hit "Snapshot not found".`,
  );
  if (firstFailureMessages) {
    console.log(`\nFirst failing boot (delay=${firstFailureMessages.delay}) console:`);
    for (const message of firstFailureMessages.messages.slice(0, 12)) {
      console.log(`  ${message.slice(0, 200)}`);
    }
  }
  process.exit(totalSnapshot > 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
