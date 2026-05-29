import { render } from "preact";

import { App } from "./components/App.js";
import { html } from "./lib/html.js";

render(html`<${App} />`, document.getElementById("app"));
