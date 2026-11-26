import { describe, expect, it } from 'vitest'
import { formatRoamImage, parseRoamImageSource } from './image-node'

describe('Roam image source', () => {
  it('round-trips Unicode and escaped brackets in an image description', () => {
    const image = { src: 'https://example.com/a(b).png', alt: '报告 [一] \\ draft' }
    expect(parseRoamImageSource(formatRoamImage(image))).toEqual(image)
  })
})
