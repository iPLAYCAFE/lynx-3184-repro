import { defineConfig } from "@lynx-js/rspeedy";

import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";

// Deliberately minimal, and deliberately DEFAULT `engineVersion`.
//
// `pluginReactLynx` defaults to engineVersion '3.2', which selects the
// **QueryComponent** lazy-bundle path (`FetchBundle` needs >= '3.9'). That is
// the path this reproduction is about: it has no `rLynxPrepareLazyBundleMTS`
// handshake, so nothing orders the main thread's snapshot registration before
// the background thread's first patch.
//
// Verify after building:  grep -c fetchBundle dist/main.web.bundle   -> 0
//                         grep -c QueryComponent dist/main.web.bundle -> >0
export default defineConfig({
  source: {
    entry: "./src/index.tsx",
  },
  plugins: [pluginReactLynx()],
  environments: {
    // Web only — the bug is Lynx-for-Web specific (see README).
    web: {},
  },
  performance: {
    // Cold, reproducible builds.
    buildCache: false,
  },
});
