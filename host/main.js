// Minimal Lynx-for-Web host: registers <lynx-view> and points it at the built
// bundle. Nothing else — no auth, no analytics, no bridges.
//
// `?delay=<ms>` is forwarded to the app as `lynx.__globalProps.reproDelayMs`,
// which is how the harness sweeps when the BACKGROUND thread reaches the lazy
// boundary without rebuilding.

import "@lynx-js/web-core/client";
import "@lynx-js/web-elements/all";
import "@lynx-js/web-elements/index.css";

const params = new URLSearchParams(window.location.search);
const delayMs = Number(params.get("delay") ?? 0);

const view = document.createElement("lynx-view");
view.setAttribute("url", "/main.web.bundle");
view.globalProps = { reproDelayMs: Number.isFinite(delayMs) ? delayMs : 0 };
view.style.cssText = "display:block;height:100vh;width:100vw";

// Surface runtime errors to the console so the harness can classify a boot.
view.addEventListener("error", (event) => {
  console.error("lynx-view error event", event?.detail ?? "");
});

document.body.appendChild(view);
