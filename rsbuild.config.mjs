import { defineConfig } from "@rsbuild/core";

// Builds the web host into www/. The Lynx bundle is staged into host/public by
// scripts/stage-bundle.mjs, so www/main.web.bundle is served from the site root
// (the URL host/main.js points <lynx-view> at).
export default defineConfig({
  source: {
    entry: { index: "./host/main.js" },
  },
  html: {
    template: "./host/index.html",
  },
  output: {
    distPath: { root: "www" },
    // Keep filenames stable so a boot loop is byte-identical across runs.
    filenameHash: false,
  },
  server: {
    publicDir: { name: "host/public" },
  },
});
