// Copies the rspeedy web output into the host's public dir so the built site
// serves /main.web.bundle next to index.html.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "dist");
const to = path.join(root, "host", "public");

if (!existsSync(path.join(from, "main.web.bundle"))) {
  console.error(
    "stage-bundle: dist/main.web.bundle missing — run `rspeedy build` first.",
  );
  process.exit(1);
}

// Wipe first: the lazy chunk's filename is content-hashed, so rebuilding at a
// different size would otherwise leave the previous chunk behind and make it
// ambiguous which bytes a boot actually loaded.
rmSync(to, { recursive: true, force: true });

// Recursive: the lazy bundle lands in dist/async/… and the app requests it at
// that same relative path, so the tree must be preserved.
let copied = 0;
function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir)) {
    const source = path.join(fromDir, entry);
    const target = path.join(toDir, entry);
    if (statSync(source).isDirectory()) {
      copyTree(source, target);
      continue;
    }
    copyFileSync(source, target);
    copied++;
  }
}
copyTree(from, to);
console.log(`stage-bundle: copied ${copied} file(s) from dist/ to host/public/`);
