import { defineConfig } from "@lynx-js/rspeedy";

import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";

// Deliberately minimal, and by default a DEFAULT `engineVersion`.
//
// `pluginReactLynx` with no `engineVersion` selects the **QueryComponent**
// lazy-bundle path (`resolveLazyBundleFetcher` returns `FetchBundle` only when
// engineVersion >= '3.9'). That is the path this reproduction is about: it has
// no `rLynxPrepareLazyBundleMTS` handshake, so nothing orders the main thread's
// snapshot registration before the background thread's first patch.
//
// Verify after building:  grep -c fetchBundle dist/main.web.bundle   -> 0
//                         grep -c QueryComponent dist/main.web.bundle -> >0
//
// `REPRO_ENGINE_VERSION=3.9` builds the same source on the **FetchBundle** path
// instead, which DOES install the prepare handshake — i.e. it tests the obvious
// mitigation. See the "Does engineVersion 3.9 fix it?" section of the README.
const engineVersion = process.env["REPRO_ENGINE_VERSION"];

export default defineConfig({
  source: {
    entry: "./src/index.tsx",
  },
  plugins: [pluginReactLynx(engineVersion ? { engineVersion } : {})],
  environments: {
    // Web only — the bug is Lynx-for-Web specific (see README).
    web: {},
  },
  performance: {
    // Cold, reproducible builds.
    buildCache: false,
  },
});
