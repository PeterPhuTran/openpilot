import { html } from "../lib/html.js";
import { strings } from "../lib/strings.js";

export function NotFound() {
  return html`
    <div class="not-found">
      <h1>${strings.notFound.title}</h1>
      <p>${strings.notFound.message}</p>
      <a class="btn btn-primary" href="/">${strings.notFound.back}</a>
    </div>
  `;
}
