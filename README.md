# Minimum reproduction — `lynx-family/lynx-stack#3184`

On the **web** target, a `lazy()` bundle can resolve on the **background thread**
before the **main thread** has registered that chunk's snapshots. The background
thread then emits a `CreateElement` patch for a snapshot type the main thread
does not know, `SnapshotInstance`'s constructor throws
`Snapshot not found: __snapshot_…`, and because the patch loop has no `catch`,
the whole patch is discarded.

```
$ pnpm install && pnpm run build
$ node repro.mjs --delay 0 --runs 12

delay(ms)  pass  snapshot  blank  noboot   snapshot ids
---------  ----  --------  -----  ------   ------------
        0     0        12      0       0   __snapshot_8a94a_6df73_1

12/12 boots hit "Snapshot not found".
```

Deterministic on the machine below, with **no artificial timing hooks, no
patched library code, and an ordinary app shape** — one `lazy()` boundary
rendered at first screen.

- `@lynx-js/web-core` **0.22.2** — and the two sites below are **byte-identical
  in the latest published `0.23.0`**, so this is not a stale-version issue.
- `@lynx-js/lynx-core` 0.1.4 · `@lynx-js/react` 0.123.0 · `@lynx-js/rspeedy` 0.16.0
- Default `engineVersion` → the **`QueryComponent`** lazy path
  (`FetchBundle` needs `>= '3.9'`). Verify: `grep -c fetchBundle dist/main.web.bundle` → `0`.
- Measured on Windows 11, Node 26, headless Chrome. No throttling needed;
  `--cpu <rate>` makes it fail on faster machines too.

## Run it

```bash
pnpm install
pnpm run build                     # generates the lazy chunk, builds app + host
node repro.mjs --delay 0 --runs 12
```

The harness serves `www/`, boots it in headless Chrome over raw CDP (no
Playwright, no downloaded browser) and classifies each boot as `pass`
(the lazy subtree rendered), `snapshot` (`Snapshot not found` was reported),
`blank`, or `noboot` (harness problem — reported separately so it can never be
counted as evidence either way).

## The mechanism

The two threads reach the same lazy boundary through different code, and only
one of them is ordered against the main thread's registration.

**Main thread** — `loadLazyBundleWithQueryComponent`, `__LEPUS__` branch
(`packages/react/runtime/lib/core/lynx/lazy-bundle.js`):

```js
const query = __QueryComponent(source);
let result;
try { result = query.evalResult } catch (e) { return new Promise(() => {}) }
```

and web-core's main-thread `__QueryComponent`
(`web-core/ts/client/mainthread/createMainThreadGlobalAPIs.ts:117`):

```ts
__QueryComponent: (url, callback) => {
  lynxViewInstance.queryComponent(url).then(...);
  return null;                                   // <- always, synchronously
},
```

So `query.evalResult` is a `TypeError` on **every** boot, the `catch` swallows
it, and the main thread renders nothing for the subtree. Its only effect is
starting `lynxViewInstance.queryComponent(url)`, whose
`await mtsRealm.loadScript(rootUrl)` + `processEvalResult(...)` is the one and
only thing that registers this chunk's snapshot creators on the main thread.
Nothing awaits it.

**Background thread** — `nativeApp.queryComponent`
(`web-core/ts/client/background/background-apis/createNativeApp.ts:150`):

```ts
queryComponent: (source, callback) => {
  if (templateCache.has(source)) {
    callback({ __hasReady: true });                       // (A)
  } else {
    queryComponent(source).then(res => callback?.(res));  // (B)
  }
},
```

- **(B)** is an RPC that resolves from the *same* cached promise the main thread
  is on (`LynxViewInstance.#bundleLoadCache`), so it cannot resolve before
  `processEvalResult` has run. **That shared promise is the entire barrier — and
  it is incidental, not designed.**
- **(A)** skips it. `lynx-core` turns `__hasReady` into `loadDynamicComponent()`
  *inside the worker* (sync XHR + `new Function`) and synthesises
  `{code: 0, mode: "cache"}`, so `withSyncResolvers` resolves `lazy()` in the
  same render pass and a `CreateElement` patch goes out immediately.

`templateCache` is populated by the `updateBTSChunk` RPC the moment the bundle
finishes **decoding**, which is strictly earlier than the page thread running
the `loadScript` + `processEvalResult` continuation for that same bundle.
Between those two points, (A) reports a readiness the main thread does not have.

Observed timeline on a failing boot (`node probe-timing.mjs 0`):

```
 208  worker  request  /main.web.bundle
 239  worker  request  /async/src/lazy-root.tsx.<hash>.bundle     <- main thread kicks off the load
 293  page    error    Error: Snapshot not found: __snapshot_8a94a_6df73_1
```

54 ms after the chunk was requested — while the page thread was still fetching,
decoding and evaluating it.

## Controls

Three, because the failure is a race and a race is easy to misattribute.

**1. The failure tracks branch (A) exactly** — same build, same harness, three
arms, only the branch predicate changed (`scripts/patch-shortcircuit.mjs`):

| `nativeApp.queryComponent`          | boots | `Snapshot not found` |
| ----------------------------------- | ----- | -------------------- |
| as shipped (`templateCache.has(…)`) | 12    | **12/12**            |
| forced to (A) — always short-circuit| 12    | **12/12**            |
| forced to (B) — always the RPC      | 12    | **0/12**             |

Disabling (A) eliminates the failure; nothing else about the build changes.

Note on the middle arm: in [an earlier comment on the issue][forced] the
reporter (me) forced (A) unconditionally in a large app, got a clean boot, and
concluded the mechanism was not established. **That null result does not
replicate here** — forcing (A) reproduces 12/12. So that experiment said
something about that particular patched build, not about the mechanism, and the
conclusion drawn from it should be disregarded.

[forced]: https://github.com/lynx-family/lynx-stack/issues/3184#issuecomment-5078040211

**2. Dose-response on the chunk's size** — the mechanism says the window is the
page thread's `loadScript` + `processEvalResult` interval, so it should widen
with the main-thread section's byte size and fade out as it shrinks. It does
(`node scripts/sweep-chunk-size.mjs 8`, 8 boots each):

| rows | lazy chunk | `Snapshot not found` |
| ---- | ---------- | -------------------- |
| 100  | 30.8 kB    | 0/8                  |
| 300  | 87.6 kB    | 0/8                  |
| 900  | 258 kB     | 0/8                  |
| 2000 | 576 kB     | 1/8                  |
| 4000 | 1172 kB    | 7/8                  |
| 6000 | 1768 kB    | 8/8                  |

A configuration broken for an unrelated reason would fail at every size.

**3. The failing id is defined only in the lazy chunk** — 0 occurrences in
`main.web.bundle`, present in the lazy chunk. It is also always the *same* id
and always the `_1` suffix: the first snapshot the main thread must materialise
from that chunk.

## What this repro does and does not show

- It **does** show a background-thread `lazy()` resolution racing ahead of
  main-thread registration on the `QueryComponent` path, causally tied to
  branch (A).
- The eager shell survives here (`eager-marker` is present, `lazy-marker` is
  not) because the eager content shipped in an earlier, already-flushed patch.
  In the app where we hit this, the composition root itself is inside the lazy
  chunk, so the discarded patch is the *whole first screen* → blank page.
- Failure rates are from one machine. The rate is timing-dependent by nature;
  the size threshold will move on faster or slower hardware. Use `--cpu <rate>`
  (CDP CPU throttling, emulating a loaded CI runner) if the default size passes.

## Suggested fixes

Any one of these closes it; they are not mutually exclusive.

1. **Make (A) correct.** `templateCache.has(url)` is *background-thread* state
   used to assert a *main-thread* property. Either drop the short-circuit and
   let the RPC be the only path, or keep `templateCache` purely as a fetch dedupe
   and still await the shared load promise.
2. **Give `CreateElement` the recovery the other opcodes already have.** Seven
   opcodes in `snapshotPatchApply` recover via `sendCtxNotFoundEventToBackground`
   when a referenced instance id is missing; a missing snapshot *type* throws.
   And `patch-listener.js` wraps the apply in `try`/`finally` with **no
   `catch`**, with `__FlushElementTree()` after it — so one unregistered type
   discards an entire patch. That is the difference between a lost subtree and a
   blank page.
3. **Install the prepare-MTS handshake on the `QueryComponent` path too.**
   `rLynxPrepareLazyBundleMTS` exists precisely so that otherwise *"a later patch
   referencing it hits snapshot not found"* — but `injectPrepareLazyBundleMTS`
   is only wired on the `FetchBundle` path (`runtime/lib/lynx.js`), i.e.
   `engineVersion >= '3.9'`.

## Files

| Path                            | What                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `src/index.tsx`                 | The app. One lazy boundary; the whole mechanism is commented.    |
| `src/lazy-root.tsx`             | The lazy chunk's root.                                          |
| `host/main.js`                  | Minimal `<lynx-view>` host — no auth, analytics or bridges.      |
| `repro.mjs`                     | Boot loop + classifier (zero deps, raw CDP).                    |
| `probe-timing.mjs`              | Diagnostic: when is the lazy bundle requested, and by whom.      |
| `scripts/patch-shortcircuit.mjs`| Control 1: disable branch (A) in the built output.               |
| `scripts/sweep-chunk-size.mjs`  | Control 2: the dose-response sweep.                             |
| `scripts/gen-lazy-chunk.mjs`    | Sizes the lazy chunk.                                           |
