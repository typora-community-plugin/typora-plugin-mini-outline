export interface AnchorEntry {
  el: HTMLElement
  text: string
  level: number
}

function headingLevel(el: HTMLElement): number {
  const m = el.tagName.match(/^H([1-6])$/)
  return m ? parseInt(m[1], 10) : 1
}

/** Normalize heading text: collapse whitespace and trim. Overlong titles are NOT truncated here — the
 * ellipsis is rendered by CSS (`text-overflow` on `.typ-mini-outline-row`) while the full normalized text is
 * kept for display and for the indicator's `title` tooltip. */
export function normalizeHeadingText(raw: string | null): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  return text
}

export function collectHeadings(container: HTMLElement | null): AnchorEntry[] {
  if (!container) return []
  const rawEls = container.querySelectorAll('h1,h2,h3,h4,h5,h6')
  const result: AnchorEntry[] = []

  for (const el of Array.from(rawEls) as HTMLElement[]) {
    if (el.closest('pre, code, .footnotes')) continue

    const text = normalizeHeadingText(el.textContent)
    if (!text) continue

    result.push({ el, text, level: headingLevel(el) })
  }

  return result
}

export function findScrollAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null
  while (cur) {
    const style = getComputedStyle(cur)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      return cur
    }
    cur = cur.parentElement
  }
  return null
}
