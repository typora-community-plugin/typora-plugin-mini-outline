import { app } from '@typora-community-plugin/core'
import { editor } from 'typora'
import type { AnchorEntry } from '../dom/headings'
import { collectHeadings, findScrollAncestor } from '../dom/headings'
import { resolveLeafContainer } from '../dom/mounting'
import { positionBubble } from '../dom/positioning'
import { OutlineBubbleView } from './bubble-view'
import { ScrollSyncController } from './scroll-sync'

/** MiniOutline: a bubble-style floating outline on the right edge of one markdown view.
 * One instance per leaf; DOM mounted into `leaf.containerEl`, except in Editor mode where Typora's
 * own editor paints above the plug-in workspace — there the bubble is appended to `<content>`
 * (`#write`'s parent, see `OutlineBubbleView.syncMount()`), falling back to `document.body` when no
 * container applies. Heading source — local `.typ-markdown-view` first, falls back to global #write in
 * source mode. */
export class MiniOutline {

  readonly app: typeof app
  usesGlobalEditor = false

  private readonly leaf: unknown
  readonly containerEl: HTMLElement | null = null

  // Assigned below; each collaborator's callback may reference the other through `this` because both
  // are only invoked after construction completes (clicks / rAF frames), never during it.
  private view!: OutlineBubbleView
  private sync!: ScrollSyncController
  private anchors: AnchorEntry[] = []

  get loaded(): boolean {
    return this.view.loaded
  }

  constructor(appInstance: typeof app, leaf: unknown) {
    this.app = appInstance
    this.leaf = leaf
    const el = resolveLeafContainer(leaf)
    if (el) this.containerEl = el
    this.view = new OutlineBubbleView(this.containerEl, idx => this.sync.jumpTo(idx))
    this.sync = new ScrollSyncController((idx, keepVisible) => {
      this.view.applyActive(idx, keepVisible)
    })
    // Route our own scroll events through onScroll() so the host re-mount check runs before syncing.
    this.sync.onSelfSync = () => { this.onScroll() }
    this.sync.isViewAlive = () => this.loaded
  }

  // ---- lifecycle ----------------------------------------------------------

  load(): void {
    if (this.view.built) return
    if (!this.containerEl) return
    this.view.build()
    this.refresh()
  }

  unload(): void {
    this.resetTransientState()
    this.view.destroy()
    this.sync.unbind()
    this.anchors = []
    this.usesGlobalEditor = false
    this.sync.dispose()
  }

  // ---- content ------------------------------------------------------------

  refresh(): void {
    if (!this.view.built) return

    const mount = this.containerEl
    if (!mount || !document.contains(mount)) {
      this.hideBubble()
      return
    }

    const view = mount.classList.contains('typ-markdown-view') ? mount : (mount.querySelector<HTMLElement>('.typ-markdown-view') ?? mount)
    this.view.viewContainer = view

    // Mount first, before any early exit below: syncMount() only decides which element hosts the
    // bubble and must not depend on view size or heading count. If a leaf is still laying out (0×0)
    // or the document has no headings yet, an early return would leave the bubble stranded in
    // `leaf.containerEl` where Typora's workspace paints over it — and none of those exit paths
    // ever moves it back into `<content>`. Calling syncMount() on those branches is harmless: it
    // only re-parents, never changes visibility.
    this.view.syncMount()

    const rect = view.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      this.hideBubble()
      return
    }

    this.sync.detachOwnListener()

    // Collect headings from the local view first (previewer panes + Typora Preview Mode both have real <h1>-<h6>).
    const localAnchors = collectHeadings(view)

    if (localAnchors.length > 0) {
      this.anchors = localAnchors
      this.usesGlobalEditor = false
      const scroller = findScrollAncestor(view)
      if (scroller && 'scrollTop' in scroller) {
        this.sync.bind(localAnchors, scroller, true)
      } else {
        this.sync.bind(localAnchors, null, false)
      }
    } else {
      // No local headings — classic source mode (transparent placeholder). Fall back to global #write.
      try {
        const writingArea = editor.writingArea as HTMLElement | null
        const scrollTarget = (writingArea?.parentElement ?? document.documentElement) as HTMLElement
        this.sync.bind(collectHeadings(writingArea), scrollTarget, false) // host drives onScroll()
        this.usesGlobalEditor = true
      } catch {
        this.usesGlobalEditor = false
        const scroller = findScrollAncestor(view)
        const local = collectHeadings(view)
        this.sync.bind(local, scroller, local.length > 0)
      }
    }

    this.anchors = this.sync.anchors
    if (this.anchors.length === 0) {
      this.hideBubble()
      return
    }

    this.view.show()
    this.view.render(this.anchors, this.sync.activeIdx)
    this.positionFromRect()
    this.sync.sync()
  }

  /** Scroll-sync entry point; also called by the host for editor-mode instances. */
  onScroll(): void {
    // Typora can re-render `<content>` and drop the bubble — put it back before bailing out.
    this.view.ensureMounted()
    if (!this.loaded || !this.sync.scrollEl) return
    this.sync.sync()
  }

  // ---- positioning --------------------------------------------------------

  positionFromRect(): void {
    if (!this.view.bubbleEl) return
    positionBubble(this.view.bubbleEl, this.containerEl, this.view.viewContainer ?? this.containerEl)
  }

  position(): void {
    if (this.loaded) this.positionFromRect()
  }

  // ---- visibility helpers --------------------------------------------------

  private hideBubble(): void {
    if (!this.view.built || !this.loaded) return
    this.resetTransientState()
    this.sync.unbind()
    this.anchors = []
    this.usesGlobalEditor = false
    this.view.hideDom()
  }

  /** Cancel rAF, timers and the jump lock; resets transient state only (no DOM). Does NOT clear
   * `guardScrollTop` — see ScrollSyncController's guard lifecycle note. */
  private resetTransientState(): void {
    this.sync.detachOwnListener()
    this.sync.resetTransient()
    this.view.cancelCloseTimer()
  }

}
