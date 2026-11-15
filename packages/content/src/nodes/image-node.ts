import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical'

export type MegaImageValue = { src: string; alt: string }
export type SerializedMegaImageNode = Spread<{ image: MegaImageValue }, SerializedLexicalNode>

/** Serializable image payload. UI packages provide the editor and reader renderers. */
export class MegaImageNode extends DecoratorNode<unknown> {
  __image: MegaImageValue

  static getType(): string { return 'mega-image' }

  static clone(node: MegaImageNode): MegaImageNode { return new MegaImageNode(node.__image, node.__key) }

  constructor(image: MegaImageValue, key?: NodeKey) {
    super(key)
    this.__image = image
  }

  static importJSON(serialized: SerializedMegaImageNode): MegaImageNode {
    return new MegaImageNode(serialized.image)
  }

  exportJSON(): SerializedMegaImageNode {
    return { ...super.exportJSON(), image: this.__image, type: 'mega-image', version: 1 }
  }

  getImage(): MegaImageValue { return this.getLatest().__image }

  getTextContent(): string { return this.__image.alt }

  isInline(): boolean { return false }
}

export function $isMegaImageNode(node: LexicalNode | null | undefined): node is MegaImageNode {
  return node instanceof MegaImageNode
}
