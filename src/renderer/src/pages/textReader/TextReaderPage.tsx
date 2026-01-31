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

const TextReaderPage: FC = () => {
  const { bookId } = useParams<{ bookId: string }>()
  const { t } = useTranslation()
  const { edition } = useRuntime()
  const showToolsPanel = !isBasicEdition(edition)

  // 工具面板折叠状态
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

  const TOOLS_PANEL_WIDTH_STORAGE_KEY = 'textReader.toolsPanelWidth'
  const DEFAULT_TOOLS_PANEL_WIDTH = 320
  const MIN_TOOLS_PANEL_WIDTH = 260
  const MIN_READER_WIDTH = 360
  const RESIZE_HANDLE_WIDTH = 14
  const RESIZE_STEP_PX = 16

  const [toolsPanelWidth, setToolsPanelWidth] = useState(DEFAULT_TOOLS_PANEL_WIDTH)
  const mainContentRef = useRef<HTMLDivElement | null>(null)
  const resizeStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const mainResizeObserverRef = useRef<ResizeObserver | null>(null)

  const clamp = useCallback((value: number, min: number, max: number) => {
    return Math.min(max, Math.max(min, value))
  }, [])

  const getMaxToolsPanelWidth = useCallback(() => {
    // 关键：以"窗口可视宽度"作为上限约束，而不是完全信任 layout 宽度。
    // 否则在某些情况下（flex 子项存在最小宽度/内容撑开），页面 layout 宽度可能会被撑大，
    // 从而让工具面板在拖拽时出现"越拖越往右溢出窗口"的不符合直觉表现。
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const layoutWidth = mainContentRef.current?.getBoundingClientRect().width ?? viewportWidth
    const mainWidth = Math.min(layoutWidth, viewportWidth)
    const sidebarReserved = sidebarMode === 'fixed' ? 260 : 0

    // 注意：不要在这里强行下限为 MIN_TOOLS_PANEL_WIDTH。
    // 当窗口本身不足以容纳"目录 + 阅读区最小宽度 + 工具面板最小宽度"时，工具面板必须允许进一步收缩，
    // 否则就会出现"工具面板超出软件窗口边界"的现象。
    const available = mainWidth - sidebarReserved - MIN_READER_WIDTH - RESIZE_HANDLE_WIDTH
    return Math.min(720, Math.max(0, available))
  }, [sidebarMode])

  const maxToolsPanelWidth = useMemo(() => getMaxToolsPanelWidth(), [getMaxToolsPanelWidth])

  const applyToolsPanelWidth = useCallback(
    (next: number) => {
      setToolsPanelWidth(clamp(next, MIN_TOOLS_PANEL_WIDTH, maxToolsPanelWidth))
    },
    [clamp, maxToolsPanelWidth]
  )

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TOOLS_PANEL_WIDTH_STORAGE_KEY)
      const parsed = raw ? Number(raw) : NaN
      if (Number.isFinite(parsed)) {
        setToolsPanelWidth(clamp(parsed, MIN_TOOLS_PANEL_WIDTH, getMaxToolsPanelWidth()))
      }
    } catch {
      // ignore
    }
  }, [clamp, getMaxToolsPanelWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(TOOLS_PANEL_WIDTH_STORAGE_KEY, String(toolsPanelWidth))
    } catch {
      // ignore
    }
  }, [toolsPanelWidth])

  useEffect(() => {
    // 窗口尺寸/侧边栏模式变化时，若工具面板宽度超出可用空间，会出现右侧被裁切（MainContent overflow: hidden）。
    // 这里用 ResizeObserver 持续将 width clamp 到可用范围，保证任何情况下都不会"截断"显示。
    const el = mainContentRef.current
    if (!el) return

    // 先立即 clamp 一次：避免"从折叠状态打开但窗口未 resize，面板宽度仍沿用旧值"的情况。
    if (!toolsPanelCollapsed) {
      const maxWidth = getMaxToolsPanelWidth()
      setToolsPanelWidth((prev) => clamp(prev, MIN_TOOLS_PANEL_WIDTH, maxWidth))
    }

    mainResizeObserverRef.current?.disconnect()
    const ro = new ResizeObserver(() => {
      if (toolsPanelCollapsed) return
      const maxWidth = getMaxToolsPanelWidth()
      setToolsPanelWidth((prev) => clamp(prev, MIN_TOOLS_PANEL_WIDTH, maxWidth))
    })
    mainResizeObserverRef.current = ro
    ro.observe(el)

    return () => {
      ro.disconnect()
      mainResizeObserverRef.current = null
    }
  }, [clamp, getMaxToolsPanelWidth, toolsPanelCollapsed])

  const handleResizePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (e) => {
      if (toolsPanelCollapsed) return

      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      resizeStateRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: toolsPanelWidth
      }

      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [toolsPanelCollapsed, toolsPanelWidth]
  )

  const handleResizePointerMove = useCallback<PointerEventHandler<HTMLDivElement>>(
    (e) => {
      const state = resizeStateRef.current
      if (!state || state.pointerId !== e.pointerId) return

      const deltaX = e.clientX - state.startX
      const maxWidth = getMaxToolsPanelWidth()
      const nextWidth = clamp(state.startWidth - deltaX, MIN_TOOLS_PANEL_WIDTH, maxWidth)
      setToolsPanelWidth(nextWidth)
    },
    [clamp, getMaxToolsPanelWidth]
  )

  const finishResize = useCallback(() => {
    resizeStateRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

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
        applyToolsPanelWidth(toolsPanelWidth + step)
      } else if (e.key === 'ArrowRight') {
        applyToolsPanelWidth(toolsPanelWidth - step)
      } else if (e.key === 'Home') {
        applyToolsPanelWidth(MIN_TOOLS_PANEL_WIDTH)
      } else if (e.key === 'End') {
        applyToolsPanelWidth(maxToolsPanelWidth)
      }
    },
    [applyToolsPanelWidth, maxToolsPanelWidth, toolsPanelCollapsed, toolsPanelWidth]
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

      <div ref={mainContentRef} data-main-content className="relative flex min-w-0 flex-1 overflow-hidden">
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
        {showToolsPanel && !toolsPanelCollapsed && (
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
            onKeyDown={handleResizeKeyDown}>
            <div className="-translate-x-1/2 absolute top-0 bottom-0 left-1/2 w-[2px] bg-[var(--color-border)] opacity-60 group-hover:bg-[var(--color-primary)] group-hover:opacity-100" />
            <div
              className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute top-1/2 left-1/2 h-[24px] w-[6px] rounded-lg opacity-0 group-hover:opacity-100"
              style={{
                background: 'radial-gradient(circle, rgba(0, 0, 0, 0.28) 1.1px, transparent 1.2px) center/6px 6px'
              }}
            />
          </div>
        )}
        {showToolsPanel && (
          <NovelToolsPanel
            book={book}
            content={content}
            chapters={chapters}
            onChapterClick={focusChapterById}
            collapsed={toolsPanelCollapsed}
            onCollapsedChange={setToolsPanelCollapsed}
            width={toolsPanelWidth}
          />
        )}
      </div>
    </div>
  )
}

export default TextReaderPage
