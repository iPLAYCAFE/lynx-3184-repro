import { lazy, root, Suspense, useEffect, useState } from "@lynx-js/react";

// The single lazy boundary. Default `engineVersion` ('3.2') means this compiles
// to the **QueryComponent** path, not FetchBundle.
const LazyRoot = lazy(() => import("./lazy-root.js"));

/**
 * The whole reproduction is the two-thread schedule below.
 *
 * On the web target the two threads reach this boundary through completely
 * different code, and only one of them is gated:
 *
 * MAIN THREAD (`__LEPUS__` branch of `loadLazyBundleWithQueryComponent`):
 *     const query = __QueryComponent(source);
 *     try { result = query.evalResult } catch { return new Promise(() => {}) }
 *   and web-core's main-thread `__QueryComponent`
 *   (`createMainThreadGlobalAPIs.ts:117`) **returns `null`, synchronously,
 *   always**. So `query.evalResult` is a TypeError on every boot, the catch
 *   swallows it, and the main thread renders nothing for this subtree.
 *   Its ONLY effect is starting `lynxViewInstance.queryComponent(url)` — and
 *   that call's `await mtsRealm.loadScript(rootUrl)` + `processEvalResult(...)`
 *   is the one and only thing that registers this chunk's snapshot creators on
 *   the main thread. Nobody awaits it. Nothing is ordered against it.
 *
 * BACKGROUND THREAD (`__JS__` branch): `lynx.QueryComponent(source, cb)` ->
 *   `nativeApp.queryComponent` (`createNativeApp.ts:150`):
 *
 *     if (templateCache.has(source)) callback({ __hasReady: true });   // (A)
 *     else queryComponent(source).then(res => callback?.(res));        // (B)
 *
 *   (B) is an RPC that resolves from the SAME cached promise the main thread is
 *   on (`LynxViewInstance.#bundleLoadCache`), so it cannot resolve before the
 *   main thread has registered. That shared promise is the entire barrier — and
 *   it is accidental.
 *   (A) skips it. `lynx-core` turns `__hasReady` into `loadDynamicComponent()`
 *   **inside the worker** (sync XHR + `new Function`) and synthesises
 *   `{code:0, mode:"cache"}`, so `withSyncResolvers` resolves `lazy()` in the
 *   same render pass and a `CreateElement` patch goes out immediately.
 *
 * `templateCache` is populated by the `updateBTSChunk` RPC the moment the bundle
 * finishes DECODING — which is strictly earlier than the page thread running the
 * `loadScript` + `processEvalResult` continuation for the same bundle. Between
 * those two points, branch (A) is taken and reports a readiness the main thread
 * does not have.
 *
 * MEASURED, so the knobs are not guesses:
 *   - The main thread requests the lazy bundle at t≈220ms (see
 *     `probe-timing.mjs`), i.e. the load really is kicked off at first screen.
 *   - The background thread's first render lands close behind it. That is
 *     already the EARLIEST it can arrive, so `reproDelayMs > 0` only makes the
 *     boot safer (0/105 boots failed across delays 0..200ms).
 *   - Therefore the window is widened on the MAIN-THREAD side: the interval is
 *     `await mtsRealm.loadScript(rootUrl)` + `processEvalResult(...)`, whose
 *     duration scales with the size of the chunk's main-thread section, plus
 *     however long the page thread is kept from running that continuation.
 *     `repro.mjs --cpu <rate>` emulates the loaded CI runner where this was
 *     first observed; `scripts/gen-lazy-chunk.mjs <rows>` sizes the chunk.
 */
function App() {
  const delayMs = Number(
    (lynx.__globalProps as Record<string, unknown> | undefined)?.["reproDelayMs"] ?? 0,
  );
  // delay <= 0 (the default) is the ORDINARY production shape: both threads
  // render the boundary at first screen. That is the configuration that flakes
  // in the wild. A positive delay only moves the background thread LATER, i.e.
  // strictly safer — measured: 0/105 boots fail at delays 0..200ms, because by
  // then the main thread has long finished registering.
  const [mountedOnBackground, setMountedOnBackground] = useState(delayMs <= 0);

  useEffect(() => {
    // Background thread only (effects never run on the main thread).
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setMountedOnBackground(true), delayMs);
    return () => clearTimeout(timer);
  }, []);

  // The main thread renders the boundary at first screen — exactly what an
  // ordinary first-screen lazy boundary does, and what kicks off the load.
  // The background thread mounts it later, which is what an ordinary
  // "reveal a lazy screen after data/interaction" app does.
  const renderLazy = __MAIN_THREAD__ ? true : mountedOnBackground;

  return (
    <view style="background-color:#f5f1e8;height:100%;width:100%">
      {/* Eager, so the harness can tell "booted but patch discarded" (this is
          present, lazy-marker is not) from "never booted at all". */}
      <text id="eager-marker" style="color:#0a3527">eager-shell-mounted</text>
      {renderLazy
        ? (
          <Suspense fallback={null}>
            <LazyRoot />
          </Suspense>
        )
        : <text id="idle-marker">idle</text>}
    </view>
  );
}

root.render(<App />);
