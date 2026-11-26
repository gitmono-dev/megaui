import { $applyNodeReplacement, DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical'

export type MegaImageValue = { src: string; alt: string }
export type SerializedMegaImageNode = Spread<{ text?: string; image?: MegaImageValue }, SerializedLexicalNode>

export function formatRoamImage({ src, alt }: MegaImageValue): string {
  return `![${alt.replace(/[\\\]]/g, '\\$&').replace(/[\r\n]/g, ' ')}](${src})`
}

export function parseRoamImageSource(text: string): MegaImageValue | null {
  const match = /^!\[((?:\\[\\\]]|[^\]\\\r\n])*)\]\((\S+)\)$/.exec(text)
  if (!match) return null
  return { src: match[2]!, alt: match[1]!.replace(/\\([\\\]])/g, '$1') }
}

export function imageFromSerialized(serialized: SerializedMegaImageNode): MegaImageValue {
  const image = typeof serialized.text === 'string' ? parseRoamImageSource(serialized.text) : serialized.image
  if (!image) throw new Error('Invalid image source')
  return image
}

/** Serializable image payload. UI packages provide the editor and reader renderers. */
export class MegaImageNode extends DecoratorNode<unknown> {
  __source: string

  static getType(): string { return 'mega-image' }

  static clone(node: MegaImageNode): MegaImageNode { return new MegaImageNode(node.getImage(), node.__key) }

  constructor(image: MegaImageValue = { src: 'https://invalid.invalid/', alt: '' }, key?: NodeKey) {
    super(key)
    this.__source = formatRoamImage(image)
  }

  static importJSON(serialized: SerializedMegaImageNode): MegaImageNode {
    return new MegaImageNode(imageFromSerialized(serialized))
  }

  exportJSON(): SerializedMegaImageNode {
    return { ...super.exportJSON(), text: this.__source, type: 'mega-image', version: 1 }
  }

  getImage(): MegaImageValue {
    const image = parseRoamImageSource(this.getLatest().__source)
    if (!image) throw new Error('Invalid image source')
    return image
  }

  getTextContent(): string { return this.getImage().alt }

  isInline(): boolean { return false }
}

export function $isMegaImageNode(node: LexicalNode | null | undefined): node is MegaImageNode {
  return node instanceof MegaImageNode
}

export function $createMegaImageNode(image: MegaImageValue): MegaImageNode {
  return $applyNodeReplacement(new MegaImageNode(image))
}
