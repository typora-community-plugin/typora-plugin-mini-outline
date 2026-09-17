import { editor } from 'typora'

export function resolveLeafContainer(leaf: unknown): HTMLElement | null {
  const l = leaf as Record<string, any> | null
  if (!l) return null
  const candidates = [l.containerEl, l.view?.containerEl]
  for (const c of candidates) {
    if (c instanceof HTMLElement) return c
  }
  return null
}

export function resolveEditorHostEl(): HTMLElement | null {
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

/** Canonical instance key + mount point for a markdown view: its owning `.typ-workspace-leaf`.
 *  The leaf-object path and the DOM fallback both resolve to this element, so one view can
 *  never end up with two instances (one mounted in the leaf, one in the view element). */
export function toLeafMount(el: HTMLElement | null): HTMLElement | null {
  return el ? (el.closest<HTMLElement>('.typ-workspace-leaf') ?? el) : null
}
