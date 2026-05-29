import { Icon } from "./Icon.js";
import { html } from "../lib/html.js";

// One nav section: a collapsible header (chevron + name + count) over its list of links. Split out of
// Sidebar so each component stays within the max-lines budget; the markup and classes are unchanged, so
// the styling and the onroad/teardown behavior live exactly where they did.
export function SidebarGroup({ group, collapsed, path, onToggle, onNavigate }) {
  return html`
    <div class=${`sidebar-group ${collapsed ? "is-collapsed" : ""}`}>
      <button class="sidebar-group-header" type="button" aria-expanded=${!collapsed} onClick=${onToggle}>
        <span class="sidebar-chevron"><${Icon} name="chevron" size=${14} /></span>
        <span class="sidebar-group-name">${group.section}</span>
        <span class="sidebar-group-count">${group.items.length}</span>
      </button>
      <div class="sidebar-items" aria-hidden=${collapsed ? "true" : null} inert=${collapsed ? true : null}>
        <div class="sidebar-items-inner">
          ${group.items.map(
            (item) => html`
              <a
                href=${item.href}
                class=${`sidebar-link ${path === item.href ? "is-active" : ""}`}
                aria-current=${path === item.href ? "page" : null}
                onClick=${onNavigate}
              >
                <${Icon} name=${item.icon} />
                <span class="sidebar-label">${item.label}</span>
              </a>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}
