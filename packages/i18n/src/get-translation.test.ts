import { describe, expect, it } from 'vitest'
import {
  defaultLocale,
  getLocaleLabel,
  getTranslation,
  isValidLocale,
  locales,
  localeLabels,
} from './get-translation'

describe('getTranslation', () => {
  it('returns the English dictionary for "en"', () => {
    const t = getTranslation('en')
    expect(t.common.siteName).toBe('Mega')
  })

  it('returns the Chinese dictionary for "zh-CN"', () => {
    const t = getTranslation('zh-CN')
    expect(t.common.siteName).toBe('Mega')
  })

  it('defaults to "en"', () => {
    expect(defaultLocale).toBe('en')
  })

  it.each(locales)('omits trailing periods in %s change overview prompts', (locale) => {
    const { description, inlineSection, mergeBox } = getTranslation(locale).workspace.clDetail.conversation
    const prompts = [description.empty, inlineSection.empty, mergeBox.ciQueuedSubtitle,
      mergeBox.ciRunningSubtitle, mergeBox.ciFailingSubtitle, mergeBox.ciSkippedSubtitle]
    for (const prompt of prompts) expect(prompt).not.toMatch(/[.。]$/)
  })
})

describe('isValidLocale', () => {
  it('accepts every locale in `locales`', () => {
    for (const locale of locales) {
      expect(isValidLocale(locale)).toBe(true)
    }
  })

  it('rejects unsupported locale strings', () => {
    expect(isValidLocale('fr')).toBe(false)
    expect(isValidLocale('')).toBe(false)
  })
})

describe('getLocaleLabel', () => {
  it('returns a human-readable label for supported locales', () => {
    expect(getLocaleLabel('en')).toBe(localeLabels.en)
    expect(getLocaleLabel('zh-CN')).toBe(localeLabels['zh-CN'])
  })

  it('falls back to the raw locale code when unknown', () => {
    expect(getLocaleLabel('fr')).toBe('fr')
  })
})
