const MAX_VISIBLE = 2;
const TOAST_TIMEOUT_MS = 3500;

let container;

function ensureContainer() {
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  return container;
}

// The toast/snackbar layer as an imported module rather than the old undeclared `showSnackbar` global
// (REWRITE_PLAN §3.4). Uses textContent, so a message can never inject markup.
export function showToast(text, level = "info") {
  const host = ensureContainer();
  while (host.childElementCount >= MAX_VISIBLE) {
    host.firstElementChild.remove();
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  // Errors are announced assertively so a failed action is surfaced immediately; info politely.
  toast.setAttribute("role", level === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", level === "error" ? "assertive" : "polite");
  toast.textContent = text;
  host.appendChild(toast);

  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("toast-visible")));

  setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, TOAST_TIMEOUT_MS);
}
