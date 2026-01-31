export type AppEdition = 'basic' | 'pro'

export const DEFAULT_EDITION: AppEdition = 'pro'

export const normalizeEdition = (value: unknown): AppEdition => {
  return value === 'basic' ? 'basic' : 'pro'
}

export const isBasicEdition = (edition?: AppEdition): boolean => edition === 'basic'
