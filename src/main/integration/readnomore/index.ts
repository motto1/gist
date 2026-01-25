export type SignatureParams = {
  method: string
  path: string
  query?: string
  body?: unknown
}

export function generateSignature(_params: SignatureParams): Record<string, string> {
  return {}
}
