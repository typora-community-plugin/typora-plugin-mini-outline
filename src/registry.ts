import { app } from '@typora-community-plugin/core'
import { MiniOutline } from './views/mini-outline'
import { resolveLeafContainer, toLeafMount } from './dom/mounting'
import { collectLeavesFromSplitTree } from './dom/leaf-tree'

/** Max frames to retry backfilling already-open views before giving up. */
const ATTACH_EXISTING_MAX_RETRIES = 3

export class OutlineRegistry {
  /** One instance per markdown view, keyed by the owning .typ-workspace-leaf element. */
  private instances = new Map<HTMLElement, MiniOutline>()
  private readonly app: typeof app

  constructor(appInstance: typeof app) {
    this.app = appInstance
  }

  /**
   * Attach a MiniOutline bubble for an opened markdown leaf (no-op for other view types).
   * The instance key and mount point are unified to the owning `.typ-workspace-leaf` element:
   * whatever container is resolved here gets normalized via toLeafMount(), so when
   * attachExisting()'s DOM fallback passes a bare `.typ-markdown-view`, it resolves back to its
   * leaf — one view can only ever get one instance. When `containerElOverride` is given, the
   * viewType check and container resolution are skipped (no real leaf object exists in that case).
   */
  attachLeaf(leaf: any, containerElOverride?: HTMLElement | null): void {
    let resolvedContainer = containerElOverride ?? null
    if (!resolvedContainer) {
      if (!leaf || leaf.viewType !== 'core.markdown') return
      resolvedContainer = resolveLeafContainer(leaf) as HTMLElement | null
    }

    const containerEl = toLeafMount(resolvedContainer)
    if (!containerEl || this.instances.has(containerEl)) return

    const inst = new MiniOutline(this.app, containerElOverride ? { viewType: 'core.markdown', containerEl } : leaf)
    this.instances.set(containerEl, inst)
    inst.load()
    requestAnimationFrame(() => inst.positionFromRect())
  }

  detachLeaf(leaf: any): void {
    const containerEl = toLeafMount(resolveLeafContainer(leaf) as HTMLElement | null)
    if (!containerEl) return
    this.instances.get(containerEl)?.unload()
    this.instances.delete(containerEl)
  }

  /** Idempotent safety net: attach any markdown view that currently has no instance
   * (e.g. a pane created or re-created by a layout change we never got an event for). */
  private attachMissingViews(): void {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.typ-markdown-view'))) {
      const mount = toLeafMount(el)
      if (!mount || this.instances.has(mount)) continue
      this.attachLeaf(null, mount)
    }
  }

  /** Attach instances to markdown views already open when the plugin loads; deduplication against
    * attachLeaf() happens via its canonical-key check. */
  attachExisting(retriesLeft: number): void {
    const leaves = collectLeavesFromSplitTree(this.app.workspace.rootSplit)
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

  refreshAll(): void {
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

  handleEditorScroll(): void {
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

  positionLeaf(leaf: unknown): void {
    const anyLeaf = leaf as any
    if (anyLeaf?.viewType === 'core.markdown') {
      const containerEl = toLeafMount(resolveLeafContainer(anyLeaf))
      if (containerEl) {
        this.instances.get(containerEl)?.position()
      }
    }
  }

  unloadAll(): void {
    this.instances.forEach(inst => inst.unload())
    this.instances.clear()
  }
}
