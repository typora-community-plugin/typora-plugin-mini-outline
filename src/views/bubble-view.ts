import { resolveEditorHostEl } from '../dom/mounting'
import type { AnchorEntry } from '../dom/headings'
import { positionBubble } from '../dom/positioning'

/** Delay (ms) before closing the panel after the mouse leaves, to allow crossing gaps. */
const CLOSE_DELAY_MS = 150

export class OutlineBubbleView {
  readonly containerEl: HTMLElement | null
  viewContainer: HTMLElement | null = null
  editorHostEl: HTMLElement | null = null

  private bubble: HTMLElement | null = null
  private indicatorEl: HTMLElement | null = null
  private panel: HTMLElement | null = null
  private list: HTMLElement | null = null
  /** Watches the editor host so the bubble is re-mounted if Typora re-renders `<content>`. */
  private hostObserver: MutationObserver | null = null
  private hostParentObserver: MutationObserver | null = null
  private observedHost: HTMLElement | null = null

  private anchors: AnchorEntry[] = []
  private _activeIdx = -1
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(containerEl: HTMLElement | null, private readonly onJump: (idx: number) => void) {
    this.containerEl = containerEl
  }

  get built(): boolean {
    return this.bubble !== null
  }

  get loaded(): boolean {
    return this.built && this.bubble!.parentNode !== null
  }

  get bubbleEl(): HTMLElement | null {
    return this.bubble
  }

  build(): void {
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

    const onContainerClick = (e: MouseEvent): void => {
      const row = (e.target as HTMLElement | null)?.closest('[data-idx]') as HTMLElement | null
      if (!row) return
      const idx = Number(row.dataset.idx)
      if (!Number.isFinite(idx) || idx < 0 || idx >= this.anchors.length) return
      this.onJump(idx)
    }
    panel.addEventListener('click', onContainerClick)
    indicator.addEventListener('click', onContainerClick)

    this.position()
  }

  destroy(): void {
    if (this.loaded && this.bubble) this.bubble.remove()
    this.hostObserver?.disconnect()
    this.hostParentObserver?.disconnect()
    this.hostObserver = null
    this.hostParentObserver = null
    this.observedHost = null
    this.bubble = null
    this.indicatorEl = null
    this.panel = null
    this.list = null
    this.viewContainer = null
    this.editorHostEl = null
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
  syncMount(): void {
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
    if (bubble.parentElement === target) return

    target.appendChild(bubble)
  }

  /** Cheap re-mount check: put a bubble back into its resolved editor host after a re-render. */
  ensureMounted(): void {
    if (this.editorHostEl && this.bubble && this.bubble.parentElement !== this.editorHostEl) this.syncMount()
  }

  /** Keep watching `host` so a bubble that Typora drops during a document re-render (or a
   * `<content>` element that gets replaced) is mounted again right away, without waiting for
   * the next host event. Cheap: both observers watch childList only (no subtree). */
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
    if (i === this._activeIdx) {
      btn.classList.add(`${baseClass}-active`)
    }
    return btn
  }

  render(anchors: AnchorEntry[], activeIdx: number): void {
    this.anchors = anchors
    this._activeIdx = activeIdx

    const el = this.indicatorEl
    if (el) {
      el.replaceChildren()
      for (let i = 0; i < anchors.length; i++) {
        el.appendChild(this.makeRow(i, 'typ-mini-outline-indicator-line'))
      }
    }

    const list = this.list
    if (!list) return
    list.replaceChildren()
    for (let i = 0; i < anchors.length; i++) {
      list.appendChild(this.makeRow(i, 'typ-mini-outline-row'))
    }
  }

  applyActive(idx: number, keepVisible: boolean): void {
    if (!this.bubble || !this.list) return
    const changed = idx !== this._activeIdx
    this._activeIdx = idx

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

  get activeIdx(): number {
    return this._activeIdx
  }

  show(): void {
    if (this.bubble) this.bubble.style.display = ''
  }

  hideDom(): void {
    const bubble = this.bubble
    if (!bubble || !this.loaded) return
    if (this.list && this.indicatorEl) {
      this.list.replaceChildren()
      this.indicatorEl.replaceChildren()
    }
    this._activeIdx = -1
    bubble.style.display = 'none'
  }

  openPanel(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    this.position()
    this.bubble?.classList.add('typ-mini-outline-open')
  }

  closePanelSoon(): void {
    if (this.closeTimer !== null) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      this.bubble?.classList.remove('typ-mini-outline-open')
    }, CLOSE_DELAY_MS)
  }

  cancelCloseTimer(): void {
    if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null }
  }

  position(): void {
    if (!this.bubble) return
    positionBubble(this.bubble, this.containerEl, this.viewContainer)
  }
}
