/** Best-effort traversal of a split tree for leaf objects (API shape is not publicly typed). */
export function collectLeavesFromSplitTree(rootSplit: unknown): any[] {
  const root = rootSplit as Record<string, any> | null
  if (!root || typeof root !== 'object') return []

  try {
    if (typeof root.getLeafs === 'function') {
      const r = root.getLeafs()
      if (Array.isArray(r)) return r as any[]
    }
  } catch { }
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
