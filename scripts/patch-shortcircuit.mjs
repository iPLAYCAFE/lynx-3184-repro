// Control experiment for lynx-family/lynx-stack#3184.
//
// Disables ONLY the `templateCache.has(source)` short-circuit in the built host
// output, so `nativeApp.queryComponent` always takes the RPC branch — the branch
// that resolves from the same `LynxViewInstance.#bundleLoadCache` promise the
// main thread is on, and therefore cannot resolve before `processEvalResult`
// has registered the chunk's snapshots.
//
//   node scripts/patch-shortcircuit.mjs --off        disable the short-circuit
//   node scripts/patch-shortcircuit.mjs --force      take it unconditionally
//   node scripts/patch-shortcircuit.mjs --restore    put it back
//
// Note the POLARITY. Forcing the short-circuit ALWAYS ON does not reproduce the
// bug, because then `loadDynamicComponent`'s synchronous XHR misses the HTTP
// cache and blocks the worker long enough for the page thread to catch up. The
// informative experiment is removing it, not forcing it.
//
// Patches the built artifact rather than node_modules so the change is a single
// verifiable byte-level edit that needs no rebuild.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "www", "static", "js", "async", "web-core-worker-chunk.js");
const backup = `${target}.orig`;
const mode = process.argv.includes("--restore")
  ? "restore"
  : process.argv.includes("--force")
  ? "force"
  : "off";

if (!existsSync(target)) {
  console.error(`patch-shortcircuit: ${target} missing — run \`pnpm run build\` first.`);
  process.exit(1);
}

if (mode === "restore") {
  if (!existsSync(backup)) {
    console.error("patch-shortcircuit: no .orig backup to restore.");
    process.exit(1);
  }
  copyFileSync(backup, target);
  console.log("patch-shortcircuit: restored the original short-circuit.");
  process.exit(0);
}

const source = readFileSync(target, "utf8");

// Minified identifiers are not stable across builds, so match structurally:
//   queryComponent:(a,b)=>{c.has(a)?b({__hasReady:!0}):...
const pattern = /queryComponent:\((\w+),(\w+)\)=>\{(\w+)\.has\(\1\)\?/g;
const matches = [...source.matchAll(pattern)];

// A matcher that gates a decision must be shown to discriminate: assert it found
// exactly the one site, and that the file really does contain the sentinel.
if (matches.length !== 1) {
  console.error(
    `patch-shortcircuit: expected exactly 1 queryComponent short-circuit, found ${matches.length}. `
      + "The bundle shape changed — inspect it instead of trusting this script.",
  );
  process.exit(1);
}
if (!source.includes("__hasReady")) {
  console.error("patch-shortcircuit: '__hasReady' not present — wrong file?");
  process.exit(1);
}

const [match] = matches;
// `false?` => always the RPC branch (B). `true?` => always the short-circuit (A).
const predicate = mode === "force" ? "true" : "false";
const patched = source.replace(
  pattern,
  (_all, sourceArg, callbackArg) =>
    `queryComponent:(${sourceArg},${callbackArg})=>{${predicate}?`,
);

if (patched === source) {
  console.error("patch-shortcircuit: replacement produced no change.");
  process.exit(1);
}

if (!existsSync(backup)) copyFileSync(target, backup);
writeFileSync(target, patched, "utf8");
console.log(
  `patch-shortcircuit: ${
    mode === "force"
      ? "FORCED the templateCache short-circuit (always branch A)"
      : "disabled the templateCache short-circuit (always branch B / RPC)"
  }\n`
    + `  before: ${match[0]}\n`
    + `  after : queryComponent:(${match[1]},${match[2]})=>{${predicate}?`,
);
