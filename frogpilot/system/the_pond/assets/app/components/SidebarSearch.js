import { Icon } from "./Icon.js";
import { html } from "../lib/html.js";
import { strings } from "../lib/strings.js";

// The sidebar's search field plus its screen-reader result-count announcer. Split out of Sidebar so the
// component stays within the max-lines budget. Clicking the field activates search (the parent expands
// the rail first when collapsed); focusing it builds the content index.
export function SidebarSearch({ inputRef, query, onInput, onActivate, onFocus, searching, resultCount }) {
  return html`
    <div class="sidebar-search" role="search">
      <div class="sidebar-search-field" onClick=${onActivate}>
        <${Icon} name="search" size=${18} />
        <input
          ref=${inputRef}
          class="sidebar-search-input"
          type="text"
          value=${query}
          placeholder=${strings.nav.searchPlaceholder}
          aria-label=${strings.nav.searchPlaceholder}
          onInput=${onInput}
          onFocus=${onFocus}
        />
      </div>
    </div>
    <div class="sr-only" role="status" aria-live="polite">${searching ? strings.nav.searchCount(resultCount) : ""}</div>
  `;
}
