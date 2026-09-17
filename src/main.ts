import './style.scss'
import { Plugin, debounce } from '@typora-community-plugin/core'
import { MiniOutline, resolveLeafContainer } from './mini-outline'

/** Max frames to retry backfilling already-open views before giving up. */
const ATTACH_EXISTING_MAX_RETRIES = 3

/** Canonical instance key + mount point for a markdown view: its owning `.typ-workspace-leaf`.
 *  The leaf-object path and the DOM fallback both resolve to this element, so one view can
 *  never end up with two instances (one mounted in the leaf, one in the view element). */
function toLeafMount(el: HTMLElement | null): HTMLElement | null {
  return el ? (el.closest<HTMLElement>('.typ-workspace-leaf') ?? el) : null
}

export default class extends Plugin {

  /** One instance per markdown view, keyed by the owning .typ-workspace-leaf element. */
  private instances = new Map<HTMLElement, MiniOutline>()

  onload() {
    this.register(this.app.workspace.rootSplit.on('leaf:open', (leaf: unknown) => {
      this.attachLeaf(leaf as any)
    }))
    this.register(this.app.workspace.rootSplit.on('leaf:close', (leaf: unknown) => {
      this.detachLeaf(leaf as any)
    }))
    // 'layout-changed' is typed on WorkspaceRootEvents, so no cast is required here.
    this.register(this.app.workspace.rootSplit.on('layout-changed', () => {
      // Split creation / pane moves can happen without a file, editor or active-leaf event.
      requestAnimationFrame(() => this.refreshAll())
    }))

    requestAnimationFrame(() => this.attachExisting(ATTACH_EXISTING_MAX_RETRIES))

    const refreshAll = debounce(() => {
      this.refreshAll()
    }, 300)

    this.register(this.app.workspace.on('file:open', () => refreshAll()))
    this.register(this.app.features.markdownEditor.on('load', () => refreshAll()))
    this.register(this.app.features.markdownEditor.on('edit', () => refreshAll()))

    this.register(this.app.features.markdownEditor.on('scroll', () => {
      this.handleEditorScroll()
    }))

    this.register(this.app.workspace.on('active-leaf:change', (leaf) => {
      const anyLeaf = leaf as any
      if (anyLeaf?.viewType === 'core.markdown') {
        const containerEl = toLeafMount(resolveLeafContainer(anyLeaf))
        if (containerEl) {
          this.instances.get(containerEl)?.position()
        }
      }
      requestAnimationFrame(() => this.refreshAll())
    }))
    this.register(this.app.workspace.rootSplit.on('split:resized', () => refreshAll()))

    this.registerCommand({
      id: 'mini-outline:toggle',
      title: 'Toggle Mini Outline',
      scope: 'editor',
      callback: () => {
        document.body.classList.toggle('typ-mini-outline-hidden-all')
      },
    })
  }

  onunload() {
    this.instances.forEach(inst => inst.unload())
    this.instances.clear()
  }

  // ---- leaf lifecycle ------------------------------------------------------

  /**
   * Attach a MiniOutline bubble for an opened markdown leaf (no-op for other view types).
   * The instance key and mount point are unified to the owning `.typ-workspace-leaf` element:
   * whatever container is resolved here gets normalized via toLeafMount(), so when
   * attachExisting()'s DOM fallback passes a bare `.typ-markdown-view`, it resolves back to its
   * leaf — one view can only ever get one instance. When `containerElOverride` is given, the
   * viewType check and container resolution are skipped (no real leaf object exists in that case).
   */
  private attachLeaf(leaf: any, containerElOverride?: HTMLElement | null): void {
    let resolvedContainer = containerElOverride ?? null
    if (!resolvedContainer) {
      if (!leaf || leaf.viewType !== 'core.markdown') return
      resolvedContainer = resolveLeafContainer(leaf) as HTMLElement | null
    }

    const containerEl = toLeafMount(resolvedContainer)
    if (!containerEl || this.instances.has(containerEl)) return

    const inst = new MiniOutline(this.app, containerElOverride ? { viewType: 'core.markdown', containerEl } : leaf)
    this.instances.set(containerEl, inst)
    this.addChild(inst)
    inst.load()
    requestAnimationFrame(() => inst.positionFromRect())
  }

  /** Detach and unload the MiniOutline instance bound to a closing leaf, if any. */
  private detachLeaf(leaf: any): void {
    const containerEl = toLeafMount(resolveLeafContainer(leaf) as HTMLElement | null)
    if (!containerEl) return
    this.instances.get(containerEl)?.unload()
    this.instances.delete(containerEl)
  }

  /** Idempotent safety net: attach any markdown view that currently has no instance
   *  (e.g. a pane created or re-created by a layout change we never got an event for). */
  private attachMissingViews(): void {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.typ-markdown-view'))) {
      const mount = toLeafMount(el)
      if (!mount || this.instances.has(mount)) continue
      this.attachLeaf(null, mount)
    }
  }

  /** Attach instances to markdown views already open when the plugin loads. The DOM fallback is
   *  deduplicated against attachLeaf() via the same canonical key (the owning `.typ-workspace-leaf`),
   *  so a view reachable through both paths never gets two instances. */
  private attachExisting(retriesLeft: number): void {
    const leaves = this.collectLeavesFromSplitTree()
    let attachedAny = false

    for (const leaf of leaves as any[]) {
      if (leaf?.viewType === 'core.markdown') {
        const before = this.instances.size
        this.attachLeaf(leaf)
        attachedAny = attachedAny || this.instances.size > before
      }
    }
    // DOM fallback reuses the same idempotent pass; count new instances to drive the retry logic.
    const elsBefore = this.instances.size
    this.attachMissingViews()
    attachedAny = attachedAny || this.instances.size > elsBefore

    if (!attachedAny && retriesLeft > 0) {
      requestAnimationFrame(() => this.attachExisting(retriesLeft - 1))
    }
  }

  /** Best-effort traversal of rootSplit for leaf objects (API shape is not publicly typed). */
  private collectLeavesFromSplitTree(): any[] {
    const root: any = this.app.workspace.rootSplit
    if (!root || typeof root !== 'object') return []

    try {
      if (typeof root.getLeafs === 'function') {
        const r = root.getLeafs()
        if (Array.isArray(r)) return r as any[]
      }
    } catch { /* fall through */ }
    if (Array.isArray(root.leaves) && root.leaves.length > 0) return root.leaves

    const found: any[] = []
    const walk = (node: unknown, depth: number): void => {
      if (!node || typeof node !== 'object' || depth > 16) return
      const n = node as Record<string, unknown>
      if ('viewType' in n && ('containerEl' in n || (n.view != null))) found.push(n)
      for (const key of ['children', 'leaves']) {
        const arr = n[key]
        if (Array.isArray(arr)) for (const c of arr as unknown[]) walk(c, depth + 1)
      }
    }
    walk(root, 0)
    return found
  }

  // ---- refresh / scroll ----------------------------------------------------

  /** Refresh all instances' content and reposition them. */
  private refreshAll(): void {
    // Backfill any view that lost its instance first — must run BEFORE iterating the map, since it
    // may add new entries while we are about to walk values().
    this.attachMissingViews()

    for (const inst of this.instances.values()) {
      try {
        inst.refresh()
        inst.positionFromRect()
      } catch (e) {
        console.error('[mini-outline] refresh failed', e)
      }
    }
  }

  /** Forward editor scroll events to instances that source from the global #write. */
  private handleEditorScroll(): void {
    for (const inst of this.instances.values()) {
      if (inst.usesGlobalEditor) {
        try {
          inst.onScroll()
        } catch (e) {
          console.error('[mini-outline] onScroll failed', e)
        }
      }
    }
  }

}
