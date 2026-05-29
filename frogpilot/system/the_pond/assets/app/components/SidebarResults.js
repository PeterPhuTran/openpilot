import { html } from "../lib/html.js";
import { strings } from "../lib/strings.js";

// The content-search results (command palette): each match navigates to the view that owns it, with a
// type chip for context. Capped at RESULT_LIMIT with a "+N more" hint so a broad query never renders an
// unbounded list silently. When there are no matches, `emptyMessage` (loading / no-results) renders under
// the same divider + title, so the empty state lands where the first result would instead of jumping up.
// Split out of Sidebar so the component stays within the max-lines budget.
const RESULT_LIMIT = 12;

export function SidebarResults({ title, matches, emptyMessage, onNavigate }) {
  const isEmpty = matches.length === 0;

  // Nothing to show and no placeholder — render nothing rather than an empty divided widget.
  if (isEmpty && !emptyMessage) {
    return null;
  }

  const shown = matches.slice(0, RESULT_LIMIT);
  const overflow = matches.length - shown.length;

  return html`
    <div class="sidebar-results">
      <div class="sidebar-results-title">${title}</div>
      ${isEmpty
        ? html`<div class="sidebar-results-empty">${emptyMessage}</div>`
        : shown.map(
            (entry) => html`
              <a
                href=${entry.href}
                class="sidebar-result"
                key=${`${entry.type}:${entry.label}:${entry.href}`}
                onClick=${onNavigate}
              >
                <span class="sidebar-result-label">${entry.label}</span>
                <span class="sidebar-result-type">${entry.type}</span>
              </a>
            `,
          )}
      ${overflow > 0 ? html`<div class="sidebar-empty">${strings.nav.searchMore(overflow)}</div>` : null}
    </div>
  `;
}
