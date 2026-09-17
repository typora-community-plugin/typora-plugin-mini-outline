import type { AnchorEntry } from '../dom/headings'

/** Scroll factor for active-heading detection (slightly above viewport center). */
const MID_FACTOR = 0.4
/** Hard timeout (ms) after which a jump-settle watcher force-releases the lock even if not yet stable. */
const JUMP_SETTLE_TIMEOUT_MS = 1500

export class ScrollSyncController {
  anchors: AnchorEntry[] = []
  scrollEl: HTMLElement | null = null

  // Injected by MiniOutline after construction.
  onSelfSync!: () => void
  isViewAlive!: () => boolean

  private readonly onActive: (idx: number, keepVisible: boolean) => void
  private activeIdxValue = -1

  private rafId: number | null = null
  private _scrollListener: (() => void) | null = null

  /** Jump lock — non-null while a click-triggered smooth scroll is in flight (set by `jumpTo()`).
    * While locked, `syncActive()` fully suppresses activeIdx re-computation so the animation can't
    * overwrite the clicked highlight. Cleared to null once `watchJumpSettle()` observes the final
    * settled position (or on unload/reset), at which point `guardScrollTop` is adopted as that
    * settled baseline for the user-manual-scroll release path below. */
  private pendingJumpIdx: number | null = null
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

  constructor(onActive: (idx: number, keepVisible: boolean) => void) {
    this.onActive = onActive
  }

  get activeIdx(): number {
    return this.activeIdxValue
  }

  bind(anchors: AnchorEntry[], scrollEl: HTMLElement | null, attachOwnListener: boolean): void {
    this.scrollEl = scrollEl
    this.anchors = anchors
    if (!attachOwnListener || !scrollEl) return // global-editor path / no scroller — host drives onScroll()
    this._scrollListener = () => { this.onSelfSync() }
    scrollEl.addEventListener('scroll', this._scrollListener, true)
  }

  detachOwnListener(): void {
    if (this._scrollListener && this.scrollEl) {
      this.scrollEl.removeEventListener('scroll', this._scrollListener, true)
      this._scrollListener = null
    }
  }

  unbind(): void {
    this.detachOwnListener()
    this.anchors = []
    this.scrollEl = null
    this.activeIdxValue = -1
  }

  /** Drop the in-flight rAF + jump watch and release the lock (the scroll-related half of
   * `resetTransientState()`). Does NOT clear `guardScrollTop` — see its lifecycle note above. */
  resetTransient(): void {
    this.cancelRaf()
    // Drop any in-flight jump watch and release the lock so an unload/refresh never leaves a
    // permanently suppressed syncActive(). Both hideBubble() and unload() funnel through here.
    this.cancelJumpWatch()
    this.pendingJumpIdx = null
  }

  /** resetTransient + clear the guard — terminal teardown only (`unload()`). */
  dispose(): void {
    this.resetTransient()
    this.guardScrollTop = null
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /** Smooth-scroll to a heading and highlight it immediately; hold that highlight for the whole
   * animation via the jump lock (see watchJumpSettle / cancelJumpWatch). */
  jumpTo(idx: number): void {
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
    this.activeIdxValue = idx
    this.onActive(idx, true)
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
      if (!this.isViewAlive() || !this.scrollEl) return // instance gone / scroller swapped — drop the watch

      const cur = scrollEl.scrollTop ?? 0
      stableFrames = Math.abs(cur - last) < 1 ? stableFrames + 1 : 0
      last = cur

      if (stableFrames >= 3 || performance.now() - start >= JUMP_SETTLE_TIMEOUT_MS) {
        this.cancelJumpWatch()
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

  sync(): void {
    if (!this.isViewAlive() || !this.scrollEl) return
    // Jump lock: a click-triggered smooth scroll is in flight — fully suppress re-computation so
    // the animation cannot overwrite the clicked highlight; watchJumpSettle() releases this later.
    if (this.pendingJumpIdx !== null) return
    if (this.rafId !== null) return

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      if (!this.isViewAlive() || this.anchors.length === 0) return
      // A jump may have been armed between scheduling and this frame — bail before re-computing.
      if (this.pendingJumpIdx !== null) return

      const scrollEl = this.scrollEl!

      // Guard check: `guardScrollTop` holds the settled position after a completed jump. If the
      // current position hasn't noticeably changed, preserve activeIdx; only real user scrolling
      // (delta >= 2px from that baseline) clears the guard and resumes normal sync.
      if (this.guardScrollTop !== null) {
        const currentTop = scrollEl.scrollTop ?? 0
        if (Math.abs(currentTop - this.guardScrollTop) < 2) {
          return
        }
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

      // Write activeIdx before invoking the callback so both stay in lockstep.
      this.activeIdxValue = activeIdx
      this.onActive(activeIdx, true)
    })
  }
}
