type LayoutToken =
  | { kind: 'title'; text: string; height: number }
  | { kind: 'body'; text: string; height: number }
  | { kind: 'space'; height: number }

type LayoutRequest = {
  id: number
  type: 'layout'
  payload: {
    title: string
    body: string
    width: number
    height: number
    paddingLeft: number
    paddingTop: number
    paddingRight: number
    paddingBottom: number
    fontFamily: string
    fontSize: number
    lineHeight: number
    titleFontSize: number
    titleLineHeight: number
    titleBottomSpacing: number
    paragraphSpacing: number
  }
}

type LayoutResponse =
  | { id: number; type: 'result'; result: { pages: LayoutToken[][] } }
  | { id: number; type: 'error'; error: string }

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const isCjk = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  )
}

function wrapTextByWidth(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number
): string[] {
  const cleaned = text.replace(/\t/g, '  ')
  if (!cleaned) return ['']

  const widthAll = ctx.measureText(cleaned).width
  if (widthAll <= maxWidth) return [cleaned]

  const avgCharWidth = Math.max(4, fontSize * 0.9)
  const approxChars = Math.max(1, Math.floor(maxWidth / avgCharWidth))

  const lines: string[] = []
  let start = 0

  while (start < cleaned.length) {
    const remaining = cleaned.length - start

    const low = start + 1
    let high = start + Math.min(remaining, approxChars * 4)
    high = Math.min(high, cleaned.length)

    // 如果初始 high 仍然太小/太大，二分找最大可放入字符数。
    while (high < cleaned.length && ctx.measureText(cleaned.slice(start, high)).width < maxWidth) {
      const nextHigh = Math.min(cleaned.length, high + approxChars)
      if (nextHigh === high) break
      high = nextHigh
    }

    let l = low
    let r = high
    while (l < r) {
      const mid = Math.ceil((l + r) / 2)
      const w = ctx.measureText(cleaned.slice(start, mid)).width
      if (w <= maxWidth) {
        l = mid
      } else {
        r = mid - 1
      }
    }

    let end = l

    // 非 CJK 优先按空白断开
    const sample = cleaned[start]
    if (sample && !isCjk(sample)) {
      const slice = cleaned.slice(start, end)
      const lastSpace = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('　'))
      if (lastSpace > 0 && lastSpace >= Math.floor(slice.length * 0.5)) {
        end = start + lastSpace
      }
    }

    const line = cleaned.slice(start, end).trimEnd()
    lines.push(line)

    start = end
    while (start < cleaned.length && (cleaned[start] === ' ' || cleaned[start] === '　')) start++
  }

  return lines.length ? lines : ['']
}

function layoutToPages(payload: LayoutRequest['payload']): LayoutToken[][] {
  const {
    title,
    body,
    width,
    height,
    paddingLeft,
    paddingTop,
    paddingRight,
    paddingBottom,
    fontFamily,
    fontSize,
    lineHeight,
    titleFontSize,
    titleLineHeight,
    titleBottomSpacing,
    paragraphSpacing
  } = payload

  const canvas = new OffscreenCanvas(1, 1)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('OffscreenCanvas 不可用')
  }

  const contentWidth = Math.max(0, width - paddingLeft - paddingRight)
  const contentHeight = Math.max(0, height - paddingTop - paddingBottom)

  const pages: LayoutToken[][] = []
  let current: LayoutToken[] = []
  let y = 0

  const pushPage = () => {
    pages.push(current)
    current = []
    y = 0
  }

  const pushToken = (token: LayoutToken) => {
    const tokenHeight = token.kind === 'space' ? token.height : token.height

    if (current.length > 0 && y + tokenHeight > contentHeight) {
      pushPage()
    }

    current.push(token)
    y += tokenHeight
  }

  // title
  ctx.font = `600 ${titleFontSize}px ${fontFamily}`
  const titleLines = wrapTextByWidth(ctx, title || '正文', contentWidth, titleFontSize)
  for (const line of titleLines) {
    pushToken({ kind: 'title', text: line, height: titleLineHeight })
  }
  if (titleBottomSpacing > 0) {
    pushToken({ kind: 'space', height: titleBottomSpacing })
  }

  // body
  ctx.font = `${fontSize}px ${fontFamily}`
  const normalized = normalizeNewlines(body)
  const paras = normalized.split('\n')

  for (let i = 0; i < paras.length; i++) {
    const raw = paras[i] ?? ''
    const trimmed = raw.replace(/^\s+/, '')

    if (!trimmed) {
      if (paragraphSpacing > 0) pushToken({ kind: 'space', height: paragraphSpacing })
      continue
    }

    const paraText = `　　${trimmed}`
    const lines = wrapTextByWidth(ctx, paraText, contentWidth, fontSize)
    for (const line of lines) {
      pushToken({ kind: 'body', text: line, height: lineHeight })
    }

    if (paragraphSpacing > 0) pushToken({ kind: 'space', height: paragraphSpacing })
  }

  if (current.length > 0) pages.push(current)
  if (pages.length === 0) pages.push([])

  return pages
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const req = event.data
  if (!req || typeof req !== 'object') return

  const { id, type } = req
  if (type !== 'layout') return

  try {
    const pages = layoutToPages(req.payload)
    const res: LayoutResponse = { id, type: 'result', result: { pages } }
    ;(self as any).postMessage(res)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const res: LayoutResponse = { id, type: 'error', error: message }
    ;(self as any).postMessage(res)
  }
}
