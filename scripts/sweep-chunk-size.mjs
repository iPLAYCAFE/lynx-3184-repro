// Dose-response control for lynx-family/lynx-stack#3184.
//
// Rebuilds the lazy chunk at several sizes and measures the failure rate at
// each. The mechanism predicts a monotonic relationship: the failure window is
// `await mtsRealm.loadScript(rootUrl)` + `processEvalResult(...)` on the page
// thread, so the bigger the chunk's main-thread section, the wider the window
// in which the worker's `__hasReady` short-circuit can emit a patch first.
//
// A configuration that is simply broken for some unrelated reason would fail at
// every size; a race window should fade out as the chunk shrinks.
//
// Usage: node scripts/sweep-chunk-size.mjs [runs] [rows...]

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [runsArg, ...rowsArgs] = process.argv.slice(2);
const runs = Number(runsArg ?? 8);
const rowCounts = rowsArgs.length ? rowsArgs.map(Number) : [100, 300, 900, 2000, 4000, 6000];

function run(command, args, { tolerateExitCode = false } = {}) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      shell: process.platform === "win32",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // repro.mjs exits non-zero when it saw NO failures, which is a legitimate
    // (and expected) result for the small-chunk arms of this sweep.
    if (tolerateExitCode && typeof error.stdout === "string") return error.stdout;
    throw error;
  }
}

const results = [];
for (const rows of rowCounts) {
  run("node", ["scripts/gen-lazy-chunk.mjs", String(rows)]);
  const buildLog = run("pnpm", ["exec", "rspeedy", "build"]);
  const sizeMatch = buildLog.match(/lazy-root\.tsx\.[0-9a-f]+\.bundle\s+([\d.]+)\s*kB/);
  const chunkKb = sizeMatch ? Number(sizeMatch[1]) : null;
  run("node", ["scripts/stage-bundle.mjs"]);
  run("pnpm", ["exec", "rsbuild", "build"]);

  const reproLog = run(
    "node",
    ["repro.mjs", "--delay", "0", "--runs", String(runs), "--cpu", "1"],
    { tolerateExitCode: true },
  );
  const tally = reproLog.match(/^\s*0\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
  const row = {
    rows,
    chunkKb,
    pass: tally ? Number(tally[1]) : null,
    snapshot: tally ? Number(tally[2]) : null,
    blank: tally ? Number(tally[3]) : null,
    noboot: tally ? Number(tally[4]) : null,
  };
  results.push(row);
  console.log(
    `rows=${String(rows).padStart(5)}  lazyChunk=${String(row.chunkKb).padStart(8)} kB  `
      + `snapshot-failures=${row.snapshot}/${runs}  (pass=${row.pass} blank=${row.blank} noboot=${row.noboot})`,
  );
}

console.log("\nrows | lazy chunk kB | failures/%d".replace("%d", String(runs)));
console.log("-----|---------------|------------");
for (const row of results) {
  console.log(
    `${String(row.rows).padStart(4)} | ${String(row.chunkKb).padStart(13)} | ${row.snapshot}/${runs}`,
  );
}
