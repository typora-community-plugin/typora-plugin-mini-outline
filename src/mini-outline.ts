import { app } from '@typora-community-plugin/core'
import { editor } from 'typora'

/** A heading entry collected for the outline. */
export interface AnchorEntry {
  el: HTMLElement
  text: string
  level: number
}

/** Delay (ms) before closing the panel after the mouse leaves, to allow crossing gaps. */
const CLOSE_DELAY_MS = 150
/** Scroll factor for active-heading detection (slightly above viewport center). */
const MID_FACTOR = 0.4
/** Hard timeout (ms) after which a jump-settle watcher force-releases the lock even if not yet stable. */
const JUMP_SETTLE_TIMEOUT_MS = 1500

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

/**
 * Collect h1..h6 inside `container`, skipping those nested in code blocks or footnotes.
 */
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

/** Find the nearest ancestor of `el` whose overflow-y is auto/scroll. */
function findScrollAncestor(el: HTMLElement | null): HTMLElement | null {
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

/** Resolve the leaf's mount point element defensively (direct prop or view wrapper). */
export function resolveLeafContainer(leaf: unknown): HTMLElement | null {
  const l = leaf as Record<string, any> | null
  if (!l) return null
  const candidates = [l.containerEl, l.view?.containerEl]
  for (const c of candidates) {
    if (c instanceof HTMLElement) return c
  }
  return null
}

/** The editor host (`<content>`, `#write`'s parent) while it is bound to a plug-in tab and rendering a
 *  non-empty document — the surface the outline must float above in Editor mode. */
function resolveEditorHostEl(): HTMLElement | null {
  let writingArea: HTMLElement | null = null
  try {
    writingArea = (editor.writingArea as HTMLElement | null) ?? null
  } catch {
    return null
  }
  const contentEl = writingArea?.parentElement as HTMLElement | null
  // Editor mode marker: MdEditorMode adds this class to `<content>` while a tab is bound.
  if (!writingArea || !contentEl?.classList.contains('typ-workspace-binding')) return null
  // Only mount when the editor is on screen (deactive tabs are 0×0) and holds content.
  if (writingArea.getClientRects().length === 0 || writingArea.childElementCount === 0) return null
  // Race guard: several views can briefly claim editor mode, but `<content>` has one owner.
  if (document.querySelectorAll('.typ-markdown-view.mode-typora').length !== 1) return null
  return contentEl
}

/** MiniOutline: a bubble-style floating outline on the right edge of one markdown view.
 * One instance per leaf; DOM mounted into `leaf.containerEl`, except in Editor mode where Typora's
 * own editor paints above the plug-in workspace — there the bubble is appended to `<content>`
 * (`#write`'s parent, see `syncMount()`), falling back to `document.body` when no container applies.
 * Heading source — local `.typ-markdown-view` first, falls back to global #write in source mode. */
export class MiniOutline {

  readonly app: typeof app
  /** Whether this instance currently sources headings from the global #write editor area. */
  usesGlobalEditor = false

  private readonly leaf: unknown
  /** Mount point — the element (leaf.containerEl) our bubble DOM lives in. */
  readonly containerEl: HTMLElement | null = null

  get loaded(): boolean {
    return this.bubble !== null && this.bubble.parentNode !== null
  }

  private bubble: HTMLElement | null = null
  private indicatorEl: HTMLElement | null = null
  private panel: HTMLElement | null = null
  private list: HTMLElement | null = null
  /** The `.typ-markdown-view` element inside containerEl (may be the mount itself). */
  private viewContainer: HTMLElement | null = null
  /** The `<content>` element we are appended to in Editor mode (null otherwise). */
  private editorHostEl: HTMLElement | null = null
  /** Watches the editor host so the bubble is re-mounted if Typora re-renders `<content>`. */
  private hostObserver: MutationObserver | null = null
  private hostParentObserver: MutationObserver | null = null
  /** The host the observers above are currently attached to. */
  private observedHost: HTMLElement | null = null

  private anchors: AnchorEntry[] = []
  private activeIdx = -1

  /** Scroll container used for sync; re-resolved on every refresh(). */
  private scrollEl: HTMLElement | null = null
  /** Our own passive scroll listener (previewer mode only). */
  private _scrollListener: (() => void) | null = null

  private rafId: number | null = null
  /** Timer for the delayed close when the mouse leaves bubble/panel. */
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  /** Jump lock — non-null while a click-triggered smooth scroll is in flight (set by `jumpTo()`).
    * While locked, `syncActive()` fully suppresses activeIdx re-computation so the animation can't
    * overwrite the clicked highlight. Cleared to null once `watchJumpSettle()` observes the final
    * settled position (or on unload/reset), at which point `guardScrollTop` is adopted as that
    * settled baseline for the user-manual-scroll release path below. */
  private pendingJumpIdx: number | null = null
  /** rAF id of the jump-settle watcher started by `watchJumpSettle()`. */
  private jumpWatchRafId: number | null = null

  /** Scroll position guard — set to the final settled `scrollTop` when a jump completes, and used as
    * the baseline for detecting real user scrolling afterwards. While `pendingJumpIdx !== null`
    * (jump in flight) it holds the pre-click position; once settle is confirmed by `watchJumpSettle()`
    * it becomes the post-landing position. Guard is cleared **only** when `syncActive()` detects real
    * scroll displacement (delta >= 2px); `refresh()` / `resetTransientState()` intentionally do NOT
    * clear it, so that host-triggered refreshes during/after a programmatic smooth scroll cannot
    * re-overwrite the click highlight. If the user manually scrolls away, `syncActive()` will detect
    * the displacement and clear the guard; if no further real scroll happens, the guard persists —
    * keeping the clicked item highlighted throughout. */
  private guardScrollTop: number | null = null


  constructor(appInstance: typeof app, leaf: unknown) {
    this.app = appInstance
    this.leaf = leaf
    const el = resolveLeafContainer(leaf)
    if (el) this.containerEl = el
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Build the bubble DOM and place it where it is visible (`syncMount()`), then refresh content. */
  load(): void {
    if (!this.bubble && !this.containerEl) return
    if (this.bubble) return
    this.buildBubble()
    this.refresh()
  }

  unload(): void {
    this.resetTransientState()
    if (this.loaded) this.bubble?.remove()
    this.bubble = null
    this.indicatorEl = null
    this.panel = null
    this.list = null
    this.viewContainer = null
    this.editorHostEl = null
    this.hostObserver?.disconnect()
    this.hostParentObserver?.disconnect()
    this.hostObserver = null
    this.hostParentObserver = null
    this.observedHost = null
    this.anchors = []
    this.activeIdx = -1
    this.scrollEl = null
    this.usesGlobalEditor = false
  }

  // ---- content ------------------------------------------------------------

  /** Re-resolve view container, heading source and scroll target; re-render indicator + panel. */
  refresh(): void {
    if (!this.bubble) return

    const mount = this.containerEl
    if (!mount || !document.contains(mount)) {
      this.hideBubble()
      return
    }

    // Resolve the view: direct or child .typ-markdown-view.
    const view = mount.classList.contains('typ-markdown-view') ? mount : (mount.querySelector<HTMLElement>('.typ-markdown-view') ?? mount)
    this.viewContainer = view

    // Mount first, before any early exit below: syncMount() only decides which element hosts the
    // bubble and must not depend on view size or heading count. If a leaf is still laying out (0×0)
    // or the document has no headings yet, an early return would leave the bubble stranded in
    // `leaf.containerEl` where Typora's workspace paints over it — and none of those exit paths
    // ever moves it back into `<content>`. Calling syncMount() on those branches is harmless: it
    // only re-parents, never changes visibility.
    this.syncMount()

    const rect = view.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      this.hideBubble()
      return
    }

    this.detachScrollListener()

    // Collect headings from the local view first (previewer panes + Typora Preview Mode both have real <h1>-<h6>).
    const localAnchors = collectHeadings(view)

    if (localAnchors.length > 0) {
      // Local view has real heading DOM — use this view as scroll target.
      this.anchors = localAnchors
      this.usesGlobalEditor = false
      const scroller = findScrollAncestor(view)
      if (scroller && 'scrollTop' in scroller) {
        this.scrollEl = scroller as HTMLElement
        this.attachOwnScrollListener()
      } else {
        this.scrollEl = null
      }
    } else {
      // No local headings — classic source mode (transparent placeholder). Fall back to global #write.
      try {
        const writingArea = editor.writingArea as HTMLElement | null
        this.scrollEl = (writingArea?.parentElement ?? document.documentElement) as HTMLElement
        this.anchors = collectHeadings(writingArea)
        this.usesGlobalEditor = true
      } catch {
        // Global fallback also failed; revert to local and hide bubble if empty.
        this.usesGlobalEditor = false
        this.scrollEl = findScrollAncestor(view)
        this.anchors = collectHeadings(view)
        if (this.anchors.length > 0) {
          this.attachOwnScrollListener()
        }
      }
    }

    if (this.anchors.length === 0) {
      this.hideBubble()
      return
    }

    // syncMount() already ran right after viewContainer was resolved, so the bubble is in its final
    // host by here; just make it visible and render content.
    this.showBubble()
    this.renderIndicator()
    this.renderPanelRows()
    this.positionFromRect()
    this.syncActive()
  }

  /** Scroll-sync entry point; also called by the host for editor-mode instances. */
  onScroll(): void {
    // Typora can re-render `<content>` and drop the bubble — put it back before bailing out.
    if (this.editorHostEl && this.bubble && this.bubble.parentElement !== this.editorHostEl) this.syncMount()
    if (!this.loaded || !this.scrollEl) return
    this.syncActive()
  }

  // ---- positioning --------------------------------------------------------

  /** Position bubble + panel from the view's current rect (fixed coordinates). */
  positionFromRect(): void {
    const view = this.viewContainer ?? this.containerEl
    if (!view || !this.bubble) return
    const r = view.getBoundingClientRect()
    this.bubble.style.right = `${window.innerWidth - r.right + 16}px`
  }

  position(): void {
    if (this.loaded) this.positionFromRect()
  }

  // ---- DOM construction ---------------------------------------------------

  private buildBubble(): void {
    const bubble = document.createElement('div')
    bubble.className = 'typ-mini-outline-bubble'
    bubble.dataset.miniOutline = ''

    const indicator = document.createElement('div')
    indicator.className = 'typ-mini-outline-indicator'
    bubble.appendChild(indicator)

    const panel = document.createElement('div')
    panel.className = 'typ-mini-outline-panel'
    const list = document.createElement('div')
    list.className = 'typ-mini-outline-list'
    panel.appendChild(list)
    bubble.appendChild(panel)

    const onEnter = () => this.openPanel()
    const onLeave = () => this.closePanelSoon()
    ;[bubble, panel].forEach((el: HTMLDivElement) => { el.addEventListener('mouseenter', onEnter); el.addEventListener('mouseleave', onLeave) })

    this.bubble = bubble
    this.indicatorEl = indicator
    this.panel = panel
    this.list = list
    this.syncMount()

    const onContainerClick = (e: MouseEvent) => {
      const row = (e.target as HTMLElement | null)?.closest('[data-idx]') as HTMLElement | null
      if (!row) return
      const idx = Number(row.dataset.idx)
      if (!Number.isFinite(idx) || idx < 0 || idx >= this.anchors.length) return
      this.jumpTo(idx)
    }
    panel.addEventListener('click', onContainerClick)
    indicator.addEventListener('click', onContainerClick)

    this.positionFromRect()
  }

  /**
   * Mount the bubble where it is actually visible.
   *
   * Editor mode: Typora's editor host `<content>` (`#write`'s parent, carrying
   * `typ-workspace-binding`) sits at the same level as — but painted above — the
   * plug-in workspace, and Typora does not rebuild it when re-rendering the document.
   * The bubble is therefore appended to `<content>`, so no framework stacking rule
   * has to be touched. Everywhere else the bubble goes back into `leaf.containerEl`
   * (falling back to `document.body`).
   *
   * Called from `refresh()` and re-checked cheaply (O(1)) from `onScroll()`, because
   * Typora can drop foreign children during a document re-render.
   */
  private syncMount(): void {
    const bubble = this.bubble
    if (!bubble) return

    const view = this.viewContainer ?? this.containerEl
    const hostEl = view?.classList.contains('mode-typora') ? resolveEditorHostEl() : null
    this.editorHostEl = hostEl
    // Point the self-healing observers at whatever host we just resolved — even when the bubble is
    // already parented to `target` and we return early below.
    this.observeHost(hostEl)

    const target = hostEl ?? (this.containerEl && document.contains(this.containerEl) ? this.containerEl : document.body)
    if (!target) return
    // Both mounts append; `<content>` is Typora's editor host, painted above the plug-in workspace.
    if (bubble.parentElement === target) return

    target.appendChild(bubble)
  }

  /**
   * Keep watching `host` so a bubble that Typora drops during a document re-render (or a
   * `<content>` element that gets replaced) is mounted again right away, without waiting for
   * the next host event. Cheap: both observers watch childList only (no subtree).
   */
  private observeHost(host: HTMLElement | null): void {
    if (this.observedHost === host) return
    this.hostObserver?.disconnect()
    this.hostParentObserver?.disconnect()
    this.hostObserver = null
    this.hostParentObserver = null
    this.observedHost = host
    if (!host) return

    const repair = () => {
      if (!this.bubble) return
      // Removed from the host, or the host itself was detached/replaced.
      if (this.bubble.parentElement !== this.editorHostEl || !this.bubble.isConnected) this.syncMount()
    }

    this.hostObserver = new MutationObserver(repair)
    this.hostObserver.observe(host, { childList: true })

    const parent = host.parentElement
    if (parent) {
      this.hostParentObserver = new MutationObserver(repair)
      this.hostParentObserver.observe(parent, { childList: true })
    }
  }

  /** Build a row button for the given heading index (shared by indicator and panel). */
  private makeRow(i: number, baseClass: string): HTMLButtonElement {
    const a = this.anchors[i]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `${baseClass} typ-lvl-${a.level}`
    btn.dataset.idx = String(i)
    if (baseClass === 'typ-mini-outline-row') {
      btn.style.paddingLeft = `${8 + (a.level - 1) * 12}px`
      btn.textContent = a.text
    } else {
      const bar = document.createElement('span')
      bar.className = 'typ-mini-outline-indicator-bar'
      btn.appendChild(bar)
      btn.title = a.text
    }
    if (i === this.activeIdx) {
      btn.classList.add(`${baseClass}-active`)
    }
    return btn
  }

  /** Render one clickable line per heading. */
  private renderIndicator(): void {
    const el = this.indicatorEl
    if (!el) return
    el.replaceChildren()
    for (let i = 0; i < this.anchors.length; i++) {
      const btn = this.makeRow(i, 'typ-mini-outline-indicator-line')
      el.appendChild(btn)
    }
  }

  /** Render the full outline tree rows. */
  private renderPanelRows(): void {
    const list = this.list
    if (!list) return
    list.replaceChildren()
    for (let i = 0; i < this.anchors.length; i++) {
      list.appendChild(this.makeRow(i, 'typ-mini-outline-row'))
    }
  }

  // ---- interactions -------------------------------------------------------

  /** Smooth-scroll to a heading and highlight it immediately; hold that highlight for the whole
   * animation via the jump lock (see watchJumpSettle / cancelJumpWatch). */
  private jumpTo(idx: number): void {
    const anchor = this.anchors[idx]
    if (!anchor) return

    // Replace any in-flight watch, then arm the lock before triggering the smooth scroll so that
    // every syncActive() call during the animation is suppressed (pendingJumpIdx !== null).
    this.cancelJumpWatch()
    this.pendingJumpIdx = idx
    // Pre-click baseline; replaced by the settled position once watchJumpSettle() confirms landing.
    this.guardScrollTop = this.scrollEl ? (this.scrollEl.scrollTop ?? 0) : null

    try {
      anchor.el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch {
    }

    // Highlight immediately so the clicked heading shows as active right away, then start watching
    // for settle; the watcher releases the lock and adopts the final scrollTop as guard baseline.
    this.applyActive(idx, true)
    this.watchJumpSettle()
  }

  /** Watch a click-triggered smooth scroll and release the jump lock once it settles.
   * Reads `scrollTop` every frame; after >= 3 consecutive stable frames (delta < 1px), or on the
   * hard timeout, adopts the final position as `guardScrollTop`, clears `pendingJumpIdx` and stops
   * watching — WITHOUT re-running syncActive(), so the clicked heading stays highlighted. */
  private watchJumpSettle(): void {
    this.cancelJumpWatch()

    if (!this.scrollEl) {
      // No scroll container to observe (e.g. global-editor fallback); end the lock immediately
      // so a later real interaction is not left permanently suppressed. guardScrollTop stays as-is.
      this.pendingJumpIdx = null
      return
    }

    const scrollEl = this.scrollEl
    let last = scrollEl.scrollTop ?? 0
    let stableFrames = 0
    const start = performance.now()

    const tick = () => {
      this.jumpWatchRafId = null
      if (!this.loaded || !this.scrollEl) return // instance gone / scroller swapped — drop the watch

      const cur = scrollEl.scrollTop ?? 0
      stableFrames = Math.abs(cur - last) < 1 ? stableFrames + 1 : 0
      last = cur

      if (stableFrames >= 3 || performance.now() - start >= JUMP_SETTLE_TIMEOUT_MS) {
        this.cancelJumpWatch()
        // Adopt the final settled position as the guard baseline for subsequent manual scrolling.
        this.guardScrollTop = cur
        this.pendingJumpIdx = null
      } else {
        this.jumpWatchRafId = requestAnimationFrame(tick)
      }
    }

    this.jumpWatchRafId = requestAnimationFrame(tick)
  }

  /** Cancel the in-flight jump-settle watcher. Does NOT clear `pendingJumpIdx` — callers decide. */
  private cancelJumpWatch(): void {
    if (this.jumpWatchRafId !== null) {
      cancelAnimationFrame(this.jumpWatchRafId)
      this.jumpWatchRafId = null
    }
  }

  private openPanel(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    this.positionFromRect()
    this.bubble?.classList.add('typ-mini-outline-open')
  }

  /** Schedule closing the panel after a short delay to allow crossing gaps. */
  private closePanelSoon(): void {
    if (this.closeTimer !== null) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      this.bubble?.classList.remove('typ-mini-outline-open')
    }, CLOSE_DELAY_MS)
  }

  // ---- scroll sync --------------------------------------------------------

  private attachOwnScrollListener(): void {
    if (!this.scrollEl) return
    this._scrollListener = () => this.onScroll()
    this.scrollEl.addEventListener('scroll', this._scrollListener, true)
  }

  private detachScrollListener(): void {
    if (this._scrollListener && this.scrollEl) {
      this.scrollEl.removeEventListener('scroll', this._scrollListener, true)
      this._scrollListener = null
    }
  }

  /** rAF-throttled active-heading sync against the current scroll position. */
  private syncActive(): void {
    if (!this.loaded || !this.scrollEl) return
    // Jump lock: a click-triggered smooth scroll is in flight — fully suppress re-computation so
    // the animation cannot overwrite the clicked highlight; watchJumpSettle() releases this later.
    if (this.pendingJumpIdx !== null) return
    if (this.rafId !== null) return

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      if (!this.loaded || !this.bubble || this.anchors.length === 0) return
      // A jump may have been armed between scheduling and this frame — bail before re-computing.
      if (this.pendingJumpIdx !== null) return

      const scrollEl = this.scrollEl!

      // Guard check: `guardScrollTop` holds the settled position after a completed jump. If the
      // current position hasn't noticeably changed, preserve activeIdx; only real user scrolling
      // (delta >= 2px from that baseline) clears the guard and resumes normal sync.
      if (this.guardScrollTop !== null) {
        const currentTop = scrollEl.scrollTop ?? 0
        if (Math.abs(currentTop - this.guardScrollTop) < 2) {
          return // still at / near the recorded position — keep activeIdx as-is
        }
        // Real displacement detected: clear guard and continue to normal sync.
        this.guardScrollTop = null
      }

      const scrollTop = scrollEl.scrollTop ?? 0
      const clientH = scrollEl.clientHeight || document.documentElement.clientHeight
      const midY = scrollTop + clientH * MID_FACTOR

      let activeIdx = -1
      for (let i = this.anchors.length - 1; i >= 0; i--) {
        const anchorTop = this.anchors[i].el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollTop
        if (anchorTop <= midY) {
          activeIdx = i
          break
        }
      }

      this.applyActive(activeIdx, true)
    })
  }

  /** Apply the active state to both panel rows and indicator lines. */
  private applyActive(idx: number, keepVisible: boolean): void {
    if (!this.bubble || !this.list) return
    const changed = idx !== this.activeIdx
    this.activeIdx = idx

    const rows = Array.from(this.list.children) as HTMLElement[]
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('typ-mini-outline-row-active', i === idx)
    }

    if (!this.indicatorEl) return
    const lines = this.indicatorEl.querySelectorAll<HTMLElement>('.typ-mini-outline-indicator-line')
    for (const line of Array.from(lines)) {
      const li = parseInt(line.dataset.idx ?? '-1', 10)
      line.classList.toggle('typ-mini-outline-indicator-line-active', li === idx)
    }

    if (changed && keepVisible && idx >= 0 && rows[idx]) {
      try {
        rows[idx].scrollIntoView({ block: 'nearest' })
      } catch {
      }
    }
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  // ---- visibility helpers --------------------------------------------------

  private showBubble(): void {
    if (this.bubble) this.bubble.style.display = ''
  }

  /** Hide the bubble and reset per-content state; a later refresh() rebuilds everything. */
  private hideBubble(): void {
    if (!this.bubble || !this.loaded) return
    this.resetTransientState()
    this.anchors = []
    this.activeIdx = -1
    this.scrollEl = null
    this.usesGlobalEditor = false
    if (this.list && this.indicatorEl) {
      this.list.replaceChildren()
      this.indicatorEl.replaceChildren()
    }
    this.bubble.style.display = 'none'
  }

  /** Cancel rAF, timers, detach scroll listener; resets transient state only (no DOM). */
  private resetTransientState(): void {
    this.cancelRaf()
    // Drop any in-flight jump watch and release the lock so an unload/refresh never leaves a
    // permanently suppressed syncActive(). Both hideBubble() and unload() funnel through here.
    this.cancelJumpWatch()
    this.pendingJumpIdx = null
    if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null }
    this.detachScrollListener()
    // NOTE: intentionally NOT clearing `guardScrollTop` here — guard lifecycle is managed by
    // syncActive()'s position-based detection; host-triggered resets must not wipe it.
  }

}
