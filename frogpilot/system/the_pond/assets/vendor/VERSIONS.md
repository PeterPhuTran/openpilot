# Vendored frontend libraries — pinned versions

These ES modules are **vendored** (committed as static `.mjs`/`.js`) and served by Flask, then loaded
by the browser via the import map in `templates/index.html`. There is **no build step** and **no
runtime CDN** — this is the fix for both the offline-device breakage and the "an upstream `latest`
release broke it" failures the old Pond hit (REWRITE_PLAN §6, Constraint 8, §16).

To upgrade a library: change the version below, re-download the exact files from the source URL,
re-strip any `//# sourceMappingURL=` trailer, and re-run the frontend suite.

| Library      | Version  | Files                                   | Import-map specifier        |
| ------------ | -------- | --------------------------------------- | --------------------------- |
| preact       | 10.29.2  | `preact.mjs`                            | `preact`                    |
| preact hooks | 10.29.2  | `hooks.mjs`                             | `preact/hooks`              |
| htm          | 3.1.1    | `htm.mjs`                               | `htm`                       |
| preact-iso   | 2.12.0   | `preact-iso/{index,router,lazy,hydrate}.js` | `preact-iso`            |

## Source URLs (downloaded 2026-05-28)

- `preact.mjs`      — https://unpkg.com/preact@10.29.2/dist/preact.module.js
- `hooks.mjs`       — https://unpkg.com/preact@10.29.2/hooks/dist/hooks.module.js
- `htm.mjs`         — https://unpkg.com/htm@3.1.1/dist/htm.module.js
- `preact-iso/*`    — https://unpkg.com/preact-iso@2.12.0/src/{index,router,lazy,hydrate}.js

## Notes

- `preact-iso` is published as unbundled source whose `module` entry is a re-export shim. We vendor its
  `src` tree as-is: the relative imports (`./router.js`) resolve by URL in the browser, and its bare
  `preact` / `preact/hooks` imports resolve through the import map. `prerender.js` is intentionally
  omitted — `index.js` only loads it via a dynamic `import()` inside `prerender()` (server-only), which
  the client never calls.
- `//# sourceMappingURL=` trailers were stripped from the minified bundles so the browser does not emit
  console noise / 404s fetching maps that are not vendored.
