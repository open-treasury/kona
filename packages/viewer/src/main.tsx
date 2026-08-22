/** Mount. Nothing else belongs here. */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// The fonts are imported here, not from the stylesheet, so that BUN resolves them: it emits
// each woff2 as an asset and rewrites the `url()` to match. §6.10 rule 9 forbids an outbound
// call, so Google's CDN — which is how the kit loads these in a Next app — is not available.
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/crimson-pro";
import "./styles.css";

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
