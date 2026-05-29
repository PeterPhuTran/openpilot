import { h } from "preact";
import htm from "htm";

// The single htm-bound tag every component renders through. Importing it from here means there is
// exactly one binding of htm to Preact's `h`, not one per file (REWRITE_PLAN §17.4).
export const html = htm.bind(h);
