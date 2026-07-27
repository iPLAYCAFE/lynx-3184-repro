// The lazy chunk. Everything visible in the app lives here, so the FIRST
// snapshot the main thread must materialise from a background-thread patch is
// necessarily one this chunk defines. That is why the real-world symptom is a
// blank page and a constant snapshot id rather than a missing subtree:
// `snapshotPatchApply`'s `CreateElement` case is unguarded, and
// `patch-listener.js` wraps the apply in try/**finally with no catch** while
// `__FlushElementTree()` runs after it — so one unregistered snapshot type
// discards the entire patch.

import { GeneratedBody } from "./lazy-chunk-generated.js";

export default function LazyRoot() {
  return (
    <view className="lazy-root" style="background-color:#0a3527;padding:8px">
      {/* The harness asserts on this id: present => the patch applied. */}
      <text id="lazy-marker" style="color:#ffffff">lazy-root-mounted</text>
      <GeneratedBody />
    </view>
  );
}
