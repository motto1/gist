/**
 * TXT阅读器页面
 * 提供沉浸式的文本阅读体验
 * 右侧集成小说工具面板（压缩器、人物志、大纲提取器）
 */

import { Button, Spinner, Tooltip } from '@heroui/react'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { isBasicEdition } from '@renderer/config/edition'
import { useTextReader } from '@renderer/hooks/useTextReader'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { ArrowLeft } from 'lucide-react'
import {
  FC,
  type KeyboardEventHandler,
  type PointerEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import ChapterSidebar from './components/ChapterSidebar'
import NovelToolsPanel from './components/NovelToolsPanel'
import ReaderContent, { type ReaderContentRef } from './components/ReaderContent'

const TOOLS_PANEL_WIDTH_STORAGE_KEY = 'textReader.toolsPanelWidth'
const DEFAULT_TOOLS_PANEL_WIDTH = 320
const MIN_TOOLS_PANEL_WIDTH = 260
const COLLAPSED_TOOLS_PANEL_WIDTH = 36
const MIN_READER_WIDTH = 360
const RESIZE_HANDLE_WIDTH = 14
const RESIZE_STEP_PX = 16
const TOOLS_LAYOUT_SAFETY_GAP = 10

const TextReaderPage: FC = () => {
  const { bookId } = useParams<{ bookId: string }>()
  const { t } = useTranslation()
  const { edition } = useRuntime()
  const showToolsPanel = !isBasicEdition(edition)

  const [toolsPanelCollapsed, setToolsPanelCollapsed] = useState(true)

  const {
    book,
    content,
    chapters,
    currentChapter,
    isLoading,
    error,
    isCacheBuilding,
    sidebarMode,
    setSidebarMode,
    setCurrentChapter,
    goBack
  } = useTextReader(bookId || '')

  const readerRef = useRef<ReaderContentRef | null>(null)
  const mainContentRef = useRef<HTMLDivElement | null>(null)
  const resizeStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  const [toolsPanelWidth, setToolsPanelWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(TOOLS_PANEL_WIDTH_STORAGE_KEY)
      const parsed = raw ? Number(raw) : NaN
      return Number.isFinite(parsed) ? parsed : DEFAULT_TOOLS_PANEL_WIDTH
    } catch {
      return DEFAULT_TOOLS_PANEL_WIDTH
    }
  })

  const [mainContentWidth, setMainContentWidth] = useState(0)
  const [chapterSidebarWidth, setChapterSidebarWidth] = useState(260)

  const clamp = useCallback((value: number, min: number, max: number) => {
    return Math.min(max, Math.max(min, value))
  }, [])

  const updateLayoutMetrics = useCallback(() => {
    const mainEl = mainContentRef.current
    if (!mainEl) return

    setMainContentWidth(mainEl.clientWidth)

    const sidebarEl = mainEl.querySelector('[data-reader-chapter-sidebar]') as HTMLElement | null
    if (sidebarEl) {
      setChapterSidebarWidth(sidebarEl.offsetWidth)
    }
  }, [])

  useEffect(() => {
    const mainEl = mainContentRef.current
    if (!mainEl) return

    updateLayoutMetrics()

    const sidebarEl = mainEl.querySelector('[data-reader-chapter-sidebar]') as HTMLElement | null
    const ro = new ResizeObserver(() => updateLayoutMetrics())
    ro.observe(mainEl)
    if (sidebarEl) ro.observe(sidebarEl)

    return () => ro.disconnect()
  }, [sidebarMode, updateLayoutMetrics])

  const toolsConstraints = useMemo(() => {
    const measuredMainWidth = mainContentWidth || mainContentRef.current?.clientWidth || 0

    // 首帧/切换瞬间还未完成测量时，避免把 maxWidth 误算为 0 导致展开后面板“消失”。
    if (measuredMainWidth <= 0) {
      return {
        minWidth: MIN_TOOLS_PANEL_WIDTH,
        maxWidth: DEFAULT_TOOLS_PANEL_WIDTH
      }
    }

    const sidebarReserved = sidebarMode === 'fixed' ? chapterSidebarWidth : 0
    const hardCap = measuredMainWidth - sidebarReserved - RESIZE_HANDLE_WIDTH - TOOLS_LAYOUT_SAFETY_GAP
    const preferred = hardCap - MIN_READER_WIDTH

    const resolvedMax = Math.min(720, Math.max(0, preferred > 0 ? preferred : hardCap))
    const maxWidth = Math.max(1, resolvedMax)
    const minWidth = Math.min(MIN_TOOLS_PANEL_WIDTH, maxWidth)

    return { minWidth, maxWidth }
  }, [chapterSidebarWidth, mainContentWidth, sidebarMode])

  const effectiveToolsPanelWidth = useMemo(
    () => clamp(toolsPanelWidth, toolsConstraints.minWidth, toolsConstraints.maxWidth),
    [clamp, toolsConstraints.maxWidth, toolsConstraints.minWidth, toolsPanelWidth]
  )

  const rightRailWidth = useMemo(
    () => (toolsPanelCollapsed ? COLLAPSED_TOOLS_PANEL_WIDTH : RESIZE_HANDLE_WIDTH + effectiveToolsPanelWidth),
    [effectiveToolsPanelWidth, toolsPanelCollapsed]
  )

  const applyToolsPanelWidth = useCallback(
    (next: number) => {
      setToolsPanelWidth(clamp(next, toolsConstraints.minWidth, toolsConstraints.maxWidth))
    },
    [clamp, toolsConstraints.maxWidth, toolsConstraints.minWidth]
  )

  useEffect(() => {
    if (!showToolsPanel) return
    setToolsPanelWidth((prev) => clamp(prev, toolsConstraints.minWidth, toolsConstraints.maxWidth))
  }, [clamp, showToolsPanel, toolsConstraints.maxWidth, toolsConstraints.minWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(TOOLS_PANEL_WIDTH_STORAGE_KEY, String(Math.round(toolsPanelWidth)))
    } catch {
      // ignore
    }
  }, [toolsPanelWidth])

  const finishResize = useCallback(() => {
    resizeStateRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  useEffect(() => {
    return () => finishResize()
  }, [finishResize])

  const handleResizePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (e) => {
      if (toolsPanelCollapsed) return

      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      resizeStateRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: effectiveToolsPanelWidth
      }

      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [effectiveToolsPanelWidth, toolsPanelCollapsed]
  )

  const handleResizePointerMove = useCallback<PointerEventHandler<HTMLDivElement>>(
    (e) => {
      const state = resizeStateRef.current
      if (!state || state.pointerId !== e.pointerId) return

      const deltaX = e.clientX - state.startX
      applyToolsPanelWidth(state.startWidth - deltaX)
    },
    [applyToolsPanelWidth]
  )

  const handleResizePointerUp = useCallback<PointerEventHandler<HTMLDivElement>>(
    (e) => {
      const state = resizeStateRef.current
      if (!state || state.pointerId !== e.pointerId) return
      finishResize()
    },
    [finishResize]
  )

  const handleResizePointerCancel = useCallback<PointerEventHandler<HTMLDivElement>>(() => {
    if (!resizeStateRef.current) return
    finishResize()
  }, [finishResize])

  const handleResizeDoubleClick = useCallback(() => {
    if (toolsPanelCollapsed) return
    applyToolsPanelWidth(DEFAULT_TOOLS_PANEL_WIDTH)
  }, [applyToolsPanelWidth, toolsPanelCollapsed])

  const handleResizeKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (e) => {
      if (toolsPanelCollapsed) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return

      e.preventDefault()
      e.stopPropagation()

      const step = e.shiftKey ? RESIZE_STEP_PX * 4 : RESIZE_STEP_PX
      if (e.key === 'ArrowLeft') {
        applyToolsPanelWidth(effectiveToolsPanelWidth + step)
      } else if (e.key === 'ArrowRight') {
        applyToolsPanelWidth(effectiveToolsPanelWidth - step)
      } else if (e.key === 'Home') {
        applyToolsPanelWidth(toolsConstraints.minWidth)
      } else if (e.key === 'End') {
        applyToolsPanelWidth(toolsConstraints.maxWidth)
      }
    },
    [
      applyToolsPanelWidth,
      effectiveToolsPanelWidth,
      toolsConstraints.maxWidth,
      toolsConstraints.minWidth,
      toolsPanelCollapsed
    ]
  )

  const handleToolsCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (!collapsed) {
        updateLayoutMetrics()
        setToolsPanelWidth((prev) => (prev < 120 ? DEFAULT_TOOLS_PANEL_WIDTH : prev))
      }
      setToolsPanelCollapsed(collapsed)
    },
    [updateLayoutMetrics]
  )

  const focusChapterById = useCallback(
    (chapterId: string) => {
      if (!chapterId) return
      readerRef.current?.scrollToChapterId(chapterId)
    },
    [readerRef]
  )

  if (isLoading) {
    return (
      <div className="flex h-screen w-full max-w-screen flex-col overflow-hidden bg-[var(--color-background)]">
        <div className="flex h-full items-center justify-center">
          <Spinner size="lg" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-screen w-full max-w-screen flex-col overflow-hidden bg-[var(--color-background)]">
        <div className="flex h-full flex-col items-center justify-center">
          <span className="text-danger">{error}</span>
          <Button color="primary" onPress={goBack} className="mt-4">
            {t('textReader.backToList', '返回列表')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full max-w-screen flex-col overflow-hidden bg-[var(--color-background)]">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none', padding: '0 16px' }}>
          <div className="flex w-full items-center [&_button]:[-webkit-app-region:no-drag]">
            <Button variant="light" isIconOnly onPress={goBack} className="mr-2">
              <ArrowLeft size={18} />
            </Button>
            <Tooltip content={book?.title}>
              <span className="max-w-[400px] overflow-hidden text-ellipsis whitespace-nowrap font-medium text-base">
                {book?.title || t('textReader.untitled', '未命名')}
              </span>
            </Tooltip>
            {isCacheBuilding && <span className="ml-2 text-[var(--color-text-3)] text-xs">正在构建目录…</span>}
            <div className="flex-1" />
          </div>
        </NavbarCenter>
      </Navbar>

      <div ref={mainContentRef} data-main-content className="relative min-w-0 flex-1 overflow-hidden">
        {showToolsPanel ? (
          <div
            className="grid h-full min-w-0"
            style={{ gridTemplateColumns: `minmax(0,1fr) ${rightRailWidth}px` }}
          >
            <div className="flex min-w-0 overflow-hidden">
              <ChapterSidebar
                chapters={chapters}
                currentChapterId={currentChapter?.id || null}
                mode={sidebarMode}
                onChapterClick={(chapter) => focusChapterById(chapter.id)}
                onModeChange={setSidebarMode}
              />

              <ReaderContent
                ref={readerRef}
                preview={content}
                chapters={chapters}
                onChapterVisible={(chapter) => setCurrentChapter(chapter as any)}
              />
            </div>

            <div className="z-20 flex h-full min-w-0 overflow-hidden">
              {!toolsPanelCollapsed && (
                <div
                  className="group pointer-events-auto relative z-10 w-[14px] flex-shrink-0 cursor-col-resize touch-none select-none bg-transparent [-webkit-app-region:no-drag] hover:bg-[color-mix(in_srgb,var(--color-primary)_6%,transparent)] focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--color-primary)_55%,transparent)] focus-visible:outline-offset-[-2px]"
                  title="拖拽调整比例"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整右侧工具栏宽度"
                  tabIndex={0}
                  onPointerDown={handleResizePointerDown}
                  onPointerMove={handleResizePointerMove}
                  onPointerUp={handleResizePointerUp}
                  onPointerCancel={handleResizePointerCancel}
                  onDoubleClick={handleResizeDoubleClick}
                  onKeyDown={handleResizeKeyDown}
                >
                  <div className="-translate-x-1/2 absolute top-0 bottom-0 left-1/2 w-[2px] bg-[var(--color-border)] opacity-60 group-hover:bg-[var(--color-primary)] group-hover:opacity-100" />
                  <div
                    className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute top-1/2 left-1/2 h-[24px] w-[6px] rounded-lg opacity-0 group-hover:opacity-100"
                    style={{
                      background: 'radial-gradient(circle, rgba(0, 0, 0, 0.28) 1.1px, transparent 1.2px) center/6px 6px'
                    }}
                  />
                </div>
              )}

              <NovelToolsPanel
                book={book}
                content={content}
                chapters={chapters}
                onChapterClick={focusChapterById}
                collapsed={toolsPanelCollapsed}
                onCollapsedChange={handleToolsCollapsedChange}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-w-0 overflow-hidden">
            <ChapterSidebar
              chapters={chapters}
              currentChapterId={currentChapter?.id || null}
              mode={sidebarMode}
              onChapterClick={(chapter) => focusChapterById(chapter.id)}
              onModeChange={setSidebarMode}
            />

            <ReaderContent
              ref={readerRef}
              preview={content}
              chapters={chapters}
              onChapterVisible={(chapter) => setCurrentChapter(chapter as any)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default TextReaderPage
