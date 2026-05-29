import { useEffect, useRef } from "preact/hooks";

import { Icon } from "./Icon.js";
import { html } from "../lib/html.js";
import { strings } from "../lib/strings.js";

// The shell renders this instead of routed views while the car is onroad, so route-owned background work
// unmounts structurally.
export function Lockout() {
  const root = useRef(null);

  useEffect(() => {
    document.title = `${strings.lockout.title} | ${strings.app.name}`;
    root.current?.focus({ preventScroll: true });
  }, []);

  return html`
    <div ref=${root} class="lockout" role="alert" tabindex="-1">
      <div class="lockout-icon"><${Icon} name="alert" size=${48} /></div>
      <h1 class="lockout-title">${strings.lockout.title}</h1>
      <p class="lockout-message">${strings.lockout.message}</p>
    </div>
  `;
}
