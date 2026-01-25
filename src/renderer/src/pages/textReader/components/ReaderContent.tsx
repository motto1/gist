import { Spinner } from '@heroui/react'
import { type LayoutToken,textLayoutService } from '@renderer/services/TextLayoutService'
import type { ReaderChapter } from '@shared/types'
import { type ScrollToOptions, useVirtualizer } from '@tanstack/react-virtual'
import {
  type KeyboardEventHandler,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEventHandler
} from 'react'

// 字体大小常量
const READER_FONT_SIZE_STORAGE_KEY = 'textReader.readerFontSize'
const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 32
const FONT_SIZE_STEP = 1

// 自定义 hook：管理阅读区字体大小
function useReaderFontSize() {
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = window.localStorage.getItem(READER_FONT_SIZE_STORAGE_KEY)
      const parsed = saved ? Number(saved) : NaN
      if (Number.isFinite(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE) {
        return parsed
      }
    } catch {
      // ignore
    }
    return DEFAULT_FONT_SIZE
  })

  const updateFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, prev + delta))
      try {
        window.localStorage.setItem(READER_FONT_SIZE_STORAGE_KEY, String(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  return { fontSize, updateFontSize }
}

type CacheChapter = ReaderChapter & {
  cachePath?: string
  charLength?: number
  order?: number
}

const highlightKeyframes = `
  @keyframes readerHighlight {
    from { background: rgba(255, 208, 102, 0.35); }
    to { background: transparent; }
  }
`

export type ReaderContentRef = {
  scrollToChapterId: (chapterId: string, options?: ScrollToOptions) => void
  scrollToTop: (behavior?: ScrollBehavior) => void
  scrollElement: () => HTMLDivElement | null
}

type Props = {
  preview: string
  chapters: CacheChapter[]
  onChapterVisible: (chapter: ReaderChapter | null) => void
}

const DomReaderContent = function DomReaderContent(
  { ref, preview, chapters, onChapterVisible }: Props & { ref?: React.RefObject<ReaderContentRef | null> }
) {
  const parentRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)

  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set())
  const textCacheRef = useRef(new Map<string, { text: string; at: number }>())
  const inflightRef = useRef(new Map<string, Promise<void>>())
  const [, forceRerender] = useState(0)

  const [highlightChapterId, setHighlightChapterId] = useState<string | null>(null)

  // 使用字体大小 hook
  const { fontSize, updateFontSize } = useReaderFontSize()
  const lineHeight = Math.round(fontSize * 1.8)

  const getScrollElement = useCallback(() => parentRef.current, [])

  const getItemKey = useCallback((index: number) => chapters[index]?.id ?? String(index), [chapters])

  const estimateSize = useCallback(
    (index: number) => {
      const c = chapters[index]
      const charLength = c?.id === 'preview' ? preview.length : c?.charLength
      const safeChars = typeof charLength === 'number' && Number.isFinite(charLength) ? Math.max(0, charLength) : 4000

      const approxCharsPerLine = 60
      const approxLines = Math.max(1, Math.ceil(safeChars / approxCharsPerLine))

      // 章节标题、padding、margin
      const base = 72
      const px = base + approxLines * lineHeight

      // 关键：不要对单章高度做过低的上限截断。
      // 否则当遇到"超长章节"且尚未完成真实测量时，会因高度被严重低估而导致下一章提前贴上来，出现重叠。
      return Math.max(220, px)
    },
    [chapters, preview.length, lineHeight]
  )

  const virtualizer = useVirtualizer({
    count: chapters.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: 3
  })

  const touchCache = useCallback((id: string, text: string) => {
    const nextAt = Date.now()
    textCacheRef.current.set(id, { text, at: nextAt })

    const MAX_CACHE = 24
    if (textCacheRef.current.size <= MAX_CACHE) return

    // 简单 LRU：按 at 排序，淘汰最旧的
    const entries = Array.from(textCacheRef.current.entries())
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, textCacheRef.current.size - MAX_CACHE)

    for (const [key] of entries) {
      textCacheRef.current.delete(key)
    }
  }, [])

  const loadChapterText = useCallback(
    async (chapter: CacheChapter) => {
      const id = chapter.id
      if (id === 'preview') {
        touchCache(id, preview)
        forceRerender((x) => x + 1)
        return
      }

      if (!chapter.cachePath) return
      if (textCacheRef.current.has(id)) return
      if (inflightRef.current.has(id)) return

      setLoadingIds((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })

      const p = (async () => {
        try {
          const text = await window.api.textReader.readChapter(chapter.cachePath as string)
          touchCache(id, text)
        } finally {
          inflightRef.current.delete(id)
          setLoadingIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          forceRerender((x) => x + 1)
          requestAnimationFrame(() => {
            virtualizer.measure()
          })
        }
      })()

      inflightRef.current.set(id, p)
    },
    [preview, touchCache, virtualizer]
  )

  const virtualItems = virtualizer.getVirtualItems()
  const virtualIndexesKey = virtualItems.map((v) => v.index).join(',')

  useEffect(() => {
    const indexes = new Set<number>()
    const items = virtualizer.getVirtualItems()

    for (const v of items) {
      for (let i = v.index - 2; i <= v.index + 2; i++) {
        if (i >= 0 && i < chapters.length) indexes.add(i)
      }
    }

    for (const idx of indexes) {
      const chapter = chapters[idx]
      if (chapter) void loadChapterText(chapter)
    }
  }, [chapters, loadChapterText, virtualIndexesKey, virtualizer])

  const updateVisibleChapter = useCallback(() => {
    const root = parentRef.current
    if (!root) return

    const top = root.scrollTop
    const threshold = top + 12

    const items = virtualizer.getVirtualItems()
    if (items.length === 0) {
      onChapterVisible(chapters[0] ?? null)
      return
    }

    let candidate = items[0]
    for (const item of items) {
      if (item.start <= threshold) {
        candidate = item
      } else {
        break
      }
    }

    onChapterVisible(chapters[candidate.index] ?? null)
  }, [chapters, onChapterVisible, virtualizer])

  useEffect(() => {
    updateVisibleChapter()
  }, [chapters.length, updateVisibleChapter])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      scrollToChapterId: (chapterId: string, options?: ScrollToOptions) => {
        const idx = chapters.findIndex((c) => c.id === chapterId)
        if (idx < 0) return

        setHighlightChapterId(chapterId)
        virtualizer.scrollToIndex(idx, { align: 'start', behavior: 'smooth', ...options })

        window.setTimeout(() => {
          setHighlightChapterId((prev) => (prev === chapterId ? null : prev))
        }, 900)
      },
      scrollToTop: (behavior: ScrollBehavior = 'smooth') => {
        parentRef.current?.scrollTo({ top: 0, behavior })
      },
      scrollElement: () => parentRef.current
    }),
    [chapters, virtualizer]
  )

  return (
    <>
      <style>{highlightKeyframes}</style>
      <div
        ref={parentRef}
        className="flex-1 overflow-auto px-5 py-[18px] min-w-0"
        onScroll={() => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current)
          rafRef.current = requestAnimationFrame(updateVisibleChapter)
        }}
        onWheel={(e) => {
          // Ctrl+滚轮：缩放字体大小
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            const delta = e.deltaY < 0 ? FONT_SIZE_STEP : -FONT_SIZE_STEP
            updateFontSize(delta)
          }
        }}>
        <div className="w-full relative" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualItems.map((virtualItem) => {
            const chapter = chapters[virtualItem.index]
            if (!chapter) return null

            const cached = textCacheRef.current.get(chapter.id)?.text
            const isLoading = loadingIds.has(chapter.id)
            const showPreview = chapter.id === 'preview'

            const MAX_PREVIEW_RENDER_CHARS = 30_000
            const previewText = preview.length > MAX_PREVIEW_RENDER_CHARS ? preview.slice(0, MAX_PREVIEW_RENDER_CHARS) : preview
            const isPreviewTruncated = preview.length > MAX_PREVIEW_RENDER_CHARS

            const text = showPreview ? previewText : cached

            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                className="absolute top-0 left-0 w-full"
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                  animation: chapter.id === highlightChapterId ? 'readerHighlight 900ms ease-out' : undefined,
                  borderRadius: chapter.id === highlightChapterId ? '8px' : undefined
                }}>
                <div id={`chapter-${chapter.id}`} className="pb-6 flex flex-col gap-3">
                  <h4 data-chapter-id={chapter.id} className="m-0 font-semibold" style={{ fontSize: `${fontSize + 4}px` }}>
                    {chapter.title || '正文'}
                  </h4>
                  {typeof text === 'string' ? (
                    <>
                      <pre
                        className="whitespace-pre-wrap break-words m-0 font-[inherit]"
                        style={{ fontSize: `${fontSize}px`, lineHeight: 1.8 }}
                      >
                        {text}
                      </pre>
                      {showPreview && isPreviewTruncated && (
                        <span className="text-foreground-400 text-xs">
                          已显示前 {MAX_PREVIEW_RENDER_CHARS.toLocaleString()} 字，目录构建完成后可继续阅读。
                        </span>
                      )}
                    </>
                  ) : isLoading ? (
                    <div className="inline-flex items-center gap-2">
                      <Spinner size="sm" />
                      <span className="text-foreground-400 text-xs">正在加载…</span>
                    </div>
                  ) : (
                    <span className="text-foreground-400 text-xs">暂无内容</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

type PagePointer = { chapterIndex: number; pageIndex: number }

type CachedLayout = {
  key: string
  pages: LayoutToken[][]
}

type CanvasProps = Props & {
  onFatal?: (error: Error) => void
}

const CanvasReaderContent = function CanvasReaderContent(
  { ref, preview, chapters, onChapterVisible, onFatal }: CanvasProps & { ref?: React.RefObject<ReaderContentRef | null> }
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafDrawRef = useRef<number | null>(null)
  const rafWheelRef = useRef<number | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const [viewport, setViewport] = useState<{ width: number; height: number; dpr: number }>({
    width: 0,
    height: 0,
    dpr: 1
  })

  const [pointer, setPointer] = useState<PagePointer>({ chapterIndex: 0, pageIndex: 0 })
  const [yOffset, setYOffset] = useState(0)
  const [highlightChapterId, setHighlightChapterId] = useState<string | null>(null)
  const [renderTick, setRenderTick] = useState(0)

  const textCacheRef = useRef(new Map<string, { text: string; at: number }>())
  const inflightTextRef = useRef(new Map<string, Promise<void>>())
  const layoutCacheRef = useRef(new Map<string, CachedLayout>())
  const inflightLayoutRef = useRef(new Map<string, Promise<void>>())

  // 使用字体大小 hook
  const { fontSize: readerFontSize, updateFontSize } = useReaderFontSize()

  const PAD_X = 20
  const PAD_Y = 18

  const layoutConfig = useMemo(() => {
    // 与 DOM 阅读器一致的默认观感
    const fontFamily =
      containerRef.current ? getComputedStyle(containerRef.current).fontFamily : 'system-ui, sans-serif'

    const fontSize = readerFontSize
    const lineHeight = Math.round(fontSize * 1.8)

    const titleFontSize = readerFontSize + 4
    const titleLineHeight = Math.round(titleFontSize * 1.4)

    return {
      fontFamily,
      fontSize,
      lineHeight,
      titleFontSize,
      titleLineHeight,
      titleBottomSpacing: 10,
      paragraphSpacing: 8
    }
  }, [viewport.width, viewport.height, readerFontSize])

  const getLayoutKey = useCallback(() => {
    const w = Math.max(0, Math.floor(viewport.width))
    const h = Math.max(0, Math.floor(viewport.height))
    return `${w}x${h}|${layoutConfig.fontFamily}|${layoutConfig.fontSize}|${layoutConfig.lineHeight}|${layoutConfig.titleFontSize}`
  }, [layoutConfig, viewport.height, viewport.width])

  const touchCache = useCallback((id: string, text: string) => {
    const nextAt = Date.now()
    textCacheRef.current.set(id, { text, at: nextAt })

    const MAX_CACHE = 12
    if (textCacheRef.current.size <= MAX_CACHE) return

    const entries = Array.from(textCacheRef.current.entries())
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, textCacheRef.current.size - MAX_CACHE)

    for (const [key] of entries) textCacheRef.current.delete(key)
  }, [])

  const loadChapterText = useCallback(
    async (chapter: CacheChapter) => {
      const id = chapter.id
      if (textCacheRef.current.has(id)) return
      if (inflightTextRef.current.has(id)) return

      const p = (async () => {
        const text =
          id === 'preview'
            ? preview
            : chapter.cachePath
              ? await window.api.textReader.readChapter(chapter.cachePath as string)
              : ''

        touchCache(id, text)
      })().finally(() => {
        inflightTextRef.current.delete(id)
        setRenderTick((x) => x + 1)
      })

      inflightTextRef.current.set(id, p)
      await p
    },
    [preview, touchCache]
  )

  const ensureLayout = useCallback(
    async (chapterIndex: number) => {
      const chapter = chapters[chapterIndex]
      if (!chapter) return
      if (viewport.width <= 0 || viewport.height <= 0) return

      const key = getLayoutKey()
      const cached = layoutCacheRef.current.get(chapter.id)
      if (cached?.key === key) return
      if (inflightLayoutRef.current.has(chapter.id)) return

      const p = (async () => {
        await loadChapterText(chapter)
        const text = textCacheRef.current.get(chapter.id)?.text ?? ''

        const { pages } = await textLayoutService.layout({
          title: chapter.title || '正文',
          body: text,
          width: viewport.width,
          height: viewport.height,
          paddingLeft: PAD_X,
          paddingTop: PAD_Y,
          paddingRight: PAD_X,
          paddingBottom: PAD_Y,
          fontFamily: layoutConfig.fontFamily,
          fontSize: layoutConfig.fontSize,
          lineHeight: layoutConfig.lineHeight,
          titleFontSize: layoutConfig.titleFontSize,
          titleLineHeight: layoutConfig.titleLineHeight,
          titleBottomSpacing: layoutConfig.titleBottomSpacing,
          paragraphSpacing: layoutConfig.paragraphSpacing
        })

        layoutCacheRef.current.set(chapter.id, { key, pages })
      })()
        .catch((e) => {
          const err = e instanceof Error ? e : new Error(String(e))
          onFatal?.(err)
        })
        .finally(() => {
          inflightLayoutRef.current.delete(chapter.id)
          setRenderTick((x) => x + 1)
        })

      inflightLayoutRef.current.set(chapter.id, p)
      await p
    },
    [PAD_X, PAD_Y, chapters, getLayoutKey, layoutConfig, loadChapterText, onFatal, viewport.height, viewport.width]
  )

  const getPages = useCallback(
    (chapterIndex: number) => {
      const chapter = chapters[chapterIndex]
      if (!chapter) return null
      return layoutCacheRef.current.get(chapter.id)?.pages ?? null
    },
    [chapters]
  )

  const getContentHeight = useCallback(() => {
    return Math.max(1, viewport.height - PAD_Y - PAD_Y)
  }, [PAD_Y, viewport.height])

  const getNextPointer = useCallback(
    (p: PagePointer): PagePointer | null => {
      const pages = getPages(p.chapterIndex)
      if (!pages) return null
      const nextPageIndex = p.pageIndex + 1
      if (nextPageIndex < pages.length) return { chapterIndex: p.chapterIndex, pageIndex: nextPageIndex }
      if (p.chapterIndex + 1 < chapters.length) return { chapterIndex: p.chapterIndex + 1, pageIndex: 0 }
      return null
    },
    [chapters.length, getPages]
  )

  const getPrevPointer = useCallback(
    (p: PagePointer): PagePointer | null => {
      if (p.pageIndex > 0) return { chapterIndex: p.chapterIndex, pageIndex: p.pageIndex - 1 }
      if (p.chapterIndex <= 0) return null
      const prevChapterIndex = p.chapterIndex - 1
      const prevPages = getPages(prevChapterIndex)
      if (!prevPages || prevPages.length === 0) return { chapterIndex: prevChapterIndex, pageIndex: 0 }
      return { chapterIndex: prevChapterIndex, pageIndex: Math.max(0, prevPages.length - 1) }
    },
    [getPages]
  )

  const clampPointer = useCallback(
    (p: PagePointer): PagePointer => {
      const chapterIndex = Math.min(Math.max(0, p.chapterIndex), Math.max(0, chapters.length - 1))
      const pages = getPages(chapterIndex)
      const pageIndex =
        pages && pages.length > 0 ? Math.min(Math.max(0, p.pageIndex), pages.length - 1) : Math.max(0, p.pageIndex)
      return { chapterIndex, pageIndex }
    },
    [chapters.length, getPages]
  )

  const scheduleDraw = useCallback(() => {
    if (rafDrawRef.current) cancelAnimationFrame(rafDrawRef.current)
    rafDrawRef.current = requestAnimationFrame(() => {
      rafDrawRef.current = null

      const container = containerRef.current
      const canvas = canvasRef.current
      if (!container || !canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = viewport.dpr || 1
      const cssW = viewport.width
      const cssH = viewport.height

      if (cssW <= 0 || cssH <= 0) return

      // 背景不透明（避免与下层 UI 叠加）
      const computed = getComputedStyle(container)
      const bg = computed.backgroundColor && computed.backgroundColor !== 'rgba(0, 0, 0, 0)' ? computed.backgroundColor : '#ffffff'
      const fg = computed.color || '#1f1f1f'

      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, cssW, cssH)

      const contentHeight = getContentHeight()
      const baseOffset = yOffset

      const cur = clampPointer(pointer)
      const prev = getPrevPointer(cur)
      const next = getNextPointer(cur)

      const drawPage = (p: PagePointer, offsetY: number) => {
        const chapter = chapters[p.chapterIndex]
        if (!chapter) return
        const pages = getPages(p.chapterIndex)
        const tokens = pages?.[p.pageIndex]
        if (!tokens) return

        let y = 0
        for (const token of tokens) {
          if (token.kind === 'space') {
            y += token.height
            continue
          }

          const isTitle = token.kind === 'title'
          ctx.font = isTitle
            ? `600 ${layoutConfig.titleFontSize}px ${layoutConfig.fontFamily}`
            : `${layoutConfig.fontSize}px ${layoutConfig.fontFamily}`
          ctx.fillStyle = fg
          ctx.textBaseline = 'top'

          const x = PAD_X
          const yy = PAD_Y + offsetY + y

          // 章节高亮：仅在标题行做轻量高亮，避免整页闪烁
          if (isTitle && chapter.id === highlightChapterId) {
            ctx.save()
            ctx.fillStyle = 'rgba(255, 208, 102, 0.25)'
            ctx.fillRect(0, yy - 2, cssW, token.height + 4)
            ctx.restore()
          }

          ctx.fillText(token.text, x, yy)
          y += token.height
        }
      }

      // 三页缓存：prev / cur / next，按 contentHeight 拼接成连续滚动
      if (prev) drawPage(prev, -contentHeight - baseOffset)
      drawPage(cur, -baseOffset)
      if (next) drawPage(next, contentHeight - baseOffset)

      ctx.restore()
    })
  }, [
    PAD_X,
    PAD_Y,
    chapters,
    clampPointer,
    getContentHeight,
    getNextPointer,
    getPages,
    getPrevPointer,
    highlightChapterId,
    layoutConfig,
    pointer,
    viewport.dpr,
    viewport.height,
    viewport.width,
    yOffset
  ])

  const updateViewport = useCallback(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const rect = container.getBoundingClientRect()
    const nextW = Math.max(0, Math.floor(rect.width))
    const nextH = Math.max(0, Math.floor(rect.height))
    const dpr = window.devicePixelRatio || 1

    // 更新 canvas 物理像素
    const pixelW = Math.max(1, Math.floor(nextW * dpr))
    const pixelH = Math.max(1, Math.floor(nextH * dpr))
    if (canvas.width !== pixelW) canvas.width = pixelW
    if (canvas.height !== pixelH) canvas.height = pixelH

    canvas.style.width = `${nextW}px`
    canvas.style.height = `${nextH}px`

    setViewport((prev) => {
      if (prev.width === nextW && prev.height === nextH && prev.dpr === dpr) return prev
      return { width: nextW, height: nextH, dpr }
    })
  }, [])

  useLayoutEffect(() => {
    updateViewport()

    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => updateViewport())
    resizeObserverRef.current = ro
    ro.observe(container)

    return () => {
      ro.disconnect()
      resizeObserverRef.current = null
    }
  }, [updateViewport])

  useEffect(() => {
    // 章节变更时，确保当前位置合法
    setPointer((prev) => clampPointer(prev))
  }, [chapters, clampPointer])

  useEffect(() => {
    // 预取当前章节与相邻章节布局（避免滚动到边界卡顿）
    const curIdx = pointer.chapterIndex
    void ensureLayout(curIdx)
    if (curIdx > 0) void ensureLayout(curIdx - 1)
    if (curIdx + 1 < chapters.length) void ensureLayout(curIdx + 1)
  }, [chapters.length, ensureLayout, pointer.chapterIndex])

  useEffect(() => {
    // 当前可见章节回调：以当前 page pointer 为准
    onChapterVisible(chapters[pointer.chapterIndex] ?? null)
  }, [chapters, onChapterVisible, pointer.chapterIndex])

  useEffect(() => {
    scheduleDraw()
  }, [scheduleDraw, viewport.width, viewport.height])

  useEffect(() => {
    // layout/text 缓存回填只会触发一次轻量 re-render，pointer/yOffset 不一定变化；
    // 因此需要用 renderTick 显式触发一次 redraw，避免"首次进入页面空白，需要滚动一下才出现"。
    scheduleDraw()
  }, [renderTick, scheduleDraw])

  // 监听主题变化，触发重绘
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'theme-mode') {
          scheduleDraw()
          break
        }
      }
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['theme-mode']
    })

    return () => observer.disconnect()
  }, [scheduleDraw])

  const scrollBy = useCallback(
    (deltaY: number) => {
      const contentHeight = getContentHeight()
      const pages = getPages(pointer.chapterIndex)
      if (!pages) return

      const PRESERVE = Math.max(0, Math.round(layoutConfig.lineHeight * 0.85))

      let nextPointer = pointer
      let nextOffset = yOffset + deltaY

      // 向下滚动：跨页/跨章
      while (nextOffset >= contentHeight) {
        const np = getNextPointer(nextPointer)
        if (!np) {
          nextOffset = Math.min(nextOffset, contentHeight - 1)
          break
        }
        nextPointer = np
        nextOffset = nextOffset - contentHeight + PRESERVE
      }

      // 向上滚动：跨页/跨章
      while (nextOffset < 0) {
        const pp = getPrevPointer(nextPointer)
        if (!pp) {
          nextOffset = 0
          break
        }
        nextPointer = pp
        nextOffset = nextOffset + contentHeight - PRESERVE
      }

      nextPointer = clampPointer(nextPointer)

      setPointer(nextPointer)
      setYOffset(Math.max(0, Math.min(contentHeight - 1, nextOffset)))
    },
    [clampPointer, getContentHeight, getNextPointer, getPages, getPrevPointer, layoutConfig.lineHeight, pointer, yOffset]
  )

  const handleWheel = useCallback<WheelEventHandler<HTMLDivElement>>(
    (e) => {
      e.preventDefault()

      // Ctrl+滚轮：缩放字体大小
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaY < 0 ? FONT_SIZE_STEP : -FONT_SIZE_STEP
        updateFontSize(delta)
        // 字体变化后需要清除布局缓存并重新排版
        layoutCacheRef.current.clear()
        setRenderTick((x) => x + 1)
        return
      }

      const deltaY = e.deltaY

      if (rafWheelRef.current) cancelAnimationFrame(rafWheelRef.current)
      rafWheelRef.current = requestAnimationFrame(() => {
        rafWheelRef.current = null
        scrollBy(deltaY)
        scheduleDraw()
      })
    },
    [scheduleDraw, scrollBy, updateFontSize]
  )

  const handleKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        scrollBy(layoutConfig.lineHeight)
        scheduleDraw()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        scrollBy(-layoutConfig.lineHeight)
        scheduleDraw()
      } else if (e.key === 'PageDown') {
        e.preventDefault()
        scrollBy(getContentHeight() * 0.9)
        scheduleDraw()
      } else if (e.key === 'PageUp') {
        e.preventDefault()
        scrollBy(-getContentHeight() * 0.9)
        scheduleDraw()
      } else if (e.key === 'Home') {
        e.preventDefault()
        setPointer({ chapterIndex: 0, pageIndex: 0 })
        setYOffset(0)
        scheduleDraw()
      }
    },
    [getContentHeight, layoutConfig.lineHeight, scheduleDraw, scrollBy]
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToChapterId: (chapterId: string) => {
        const idx = chapters.findIndex((c) => c.id === chapterId)
        if (idx < 0) return

        setHighlightChapterId(chapterId)
        setPointer({ chapterIndex: idx, pageIndex: 0 })
        setYOffset(0)

        window.setTimeout(() => {
          setHighlightChapterId((prev) => (prev === chapterId ? null : prev))
        }, 900)
      },
      scrollToTop: () => {
        setPointer({ chapterIndex: 0, pageIndex: 0 })
        setYOffset(0)
      },
      scrollElement: () => containerRef.current
    }),
    [chapters]
  )

  useEffect(() => {
    return () => {
      if (rafDrawRef.current) cancelAnimationFrame(rafDrawRef.current)
      if (rafWheelRef.current) cancelAnimationFrame(rafWheelRef.current)
    }
  }, [])

  const currentPages = getPages(pointer.chapterIndex)
  const isLoadingLayout = !currentPages

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      className="flex-1 overflow-hidden relative outline-none bg-[var(--color-background)] min-w-0"
    >
      <canvas ref={canvasRef} />
      {isLoadingLayout && (
        <div className="absolute inset-0 flex items-center justify-center gap-[10px] bg-black/[0.02] pointer-events-none">
          <Spinner size="sm" />
          <span className="text-foreground-400 text-xs">正在排版…</span>
        </div>
      )}
    </div>
  )
}

const ReaderContent = function ReaderContent({ ref, ...props }: Props & { ref?: React.RefObject<ReaderContentRef | null> }) {
  const innerCanvasRef = useRef<ReaderContentRef | null>(null)
  const innerDomRef = useRef<ReaderContentRef | null>(null)
  const [mode, setMode] = useState<'canvas' | 'dom'>('canvas')

  useImperativeHandle(
    ref,
    () => ({
      scrollToChapterId: (chapterId: string, options?: ScrollToOptions) => {
        if (mode === 'canvas') innerCanvasRef.current?.scrollToChapterId(chapterId, options)
        else innerDomRef.current?.scrollToChapterId(chapterId, options)
      },
      scrollToTop: (behavior?: ScrollBehavior) => {
        if (mode === 'canvas') innerCanvasRef.current?.scrollToTop(behavior)
        else innerDomRef.current?.scrollToTop(behavior)
      },
      scrollElement: () => {
        return mode === 'canvas' ? innerCanvasRef.current?.scrollElement() ?? null : innerDomRef.current?.scrollElement() ?? null
      }
    }),
    [mode]
  )

  if (mode === 'dom') {
    return <DomReaderContent ref={innerDomRef} {...props} />
  }

  return (
    <CanvasReaderContent
      ref={innerCanvasRef}
      {...props}
      onFatal={() => {
        setMode('dom')
      }}
    />
  )
}

export default ReaderContent
