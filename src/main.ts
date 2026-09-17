import './style.scss'
import { Plugin, debounce } from '@typora-community-plugin/core'
import { OutlineRegistry } from './registry'

const ATTACH_EXISTING_MAX_RETRIES = 3

export default class extends Plugin {

  private registry: OutlineRegistry | null = null

  onload() {
    const registry = new OutlineRegistry(this.app)
    this.registry = registry

    // Backfill markdown views that were already open when the plugin loaded (rAF so it runs after layout).
    requestAnimationFrame(() => registry.attachExisting(ATTACH_EXISTING_MAX_RETRIES))

    this.register(this.app.workspace.rootSplit.on('leaf:open', (leaf: unknown) => {
      registry.attachLeaf(leaf as any)
    }))
    this.register(this.app.workspace.rootSplit.on('leaf:close', (leaf: unknown) => {
      registry.detachLeaf(leaf as any)
    }))
    this.register(this.app.workspace.rootSplit.on('layout-changed', () => {
      // Split creation / pane moves can happen without a file, editor or active-leaf event.
      requestAnimationFrame(() => registry.refreshAll())
    }))

    const refreshAll = debounce(() => {
      registry.refreshAll()
    }, 300)

    this.register(this.app.workspace.on('file:open', () => refreshAll()))
    this.register(this.app.features.markdownEditor.on('load', () => refreshAll()))
    this.register(this.app.features.markdownEditor.on('edit', () => refreshAll()))

    this.register(this.app.features.markdownEditor.on('scroll', () => {
      registry.handleEditorScroll()
    }))

    this.register(this.app.workspace.on('active-leaf:change', (leaf) => {
      registry.positionLeaf(leaf)
      requestAnimationFrame(() => registry.refreshAll())
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
    this.registry?.unloadAll()
    this.registry = null
  }
}