// One ref-counted body scroll lock shared by every overlay and modal. Ref-counting means a dialog
// stacked over an overlay does not release the lock the overlay still needs when it closes
// (REWRITE_PLAN §5.2).
let lockCount = 0;

export function lockScroll() {
  lockCount += 1;
  document.documentElement.classList.add("no-scroll");
}

export function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.documentElement.classList.remove("no-scroll");
  }
}
