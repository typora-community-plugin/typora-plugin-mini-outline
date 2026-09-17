/** Returns `null` only when neither yields a non-degenerate (width > 0 && height > 0) rect — in
 * that case callers must not write any inline style at all. */
export function resolveAnchorRect(containerEl: HTMLElement | null, view: HTMLElement | null): DOMRect | null {
  const leaf = containerEl?.closest<HTMLElement>('.typ-workspace-leaf') ?? containerEl
  if (leaf) {
    const r = leaf.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return r
  }
  if (view) {
    const r = view.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return r
  }
  return null
}

/** The anchor is the **WorkspaceLeaf (.typ-workspace-leaf / pane) box itself** — never the
 * `.typ-markdown-view` rect: a preview pane's view element is as tall as the whole document and
 * is moved by an ancestor scroller, so its raw center (and even its intersection with the viewport
 * after scrolling down) can sit far outside the leaf; deriving the vertical position from that
 * rect failed twice before. The leaf box, in contrast, has full window height under a left/right
 * split and half of it under a top/bottom split — so `top = anchor.top + anchor.height / 2` (plus
 * the CSS `transform: translateY(-50%)`) lands on 50% of that pane for either layout. */
export function positionBubble(bubble: HTMLElement, containerEl: HTMLElement | null, view: HTMLElement | null): void {
  const r = resolveAnchorRect(containerEl, view)
  // No usable anchor rect (leaf and view both un-laid-out / degenerate): keep the previous
  // inline styles untouched instead of writing meaningless or negative coordinates.
  if (!r || r.width <= 0 || r.height <= 0) return
  const top = Math.round(Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight))
  const right = Math.round(Math.max(window.innerWidth - r.right + 16, 0))
  bubble.style.top = `${top}px`
  bubble.style.right = `${right}px`
  // Clear any residual `bottom` (theme/inheritance leftovers); top and bottom must not coexist.
  bubble.style.bottom = 'auto'
}
