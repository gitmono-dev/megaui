import type { Klass, LexicalNode } from 'lexical'
import { BlockRefNode } from './block-ref-node'
import { EmbedNode } from './embed-node'
import { MegaImageNode } from './image-node'
import { MEGA_CONTENT_BLOCK_NODES } from './nodes-core'
import { RefNode } from './ref-node'

export * from './block-ref-node'
export * from './embed-node'
export * from './image-node'
export * from './nodes-core'
export * from './ref-node'
export * from './table-source'

/** The full mega nodes-core set, ready to spread into a Lexical editor's `nodes` config. */
export const NODES_CORE: readonly Klass<LexicalNode>[] = [
  RefNode,
  EmbedNode,
  MegaImageNode,
  BlockRefNode,
  ...MEGA_CONTENT_BLOCK_NODES,
]
