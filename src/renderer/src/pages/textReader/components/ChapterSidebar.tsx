import { Button, Input, Tab, Tabs } from '@heroui/react'
import type { ReaderChapter, ReaderSidebarMode } from '@shared/types'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useMemo, useRef, useState } from 'react'

type Props = {
  chapters: ReaderChapter[]
  currentChapterId: string | null
  mode: ReaderSidebarMode
  onChapterClick: (chapter: ReaderChapter) => void
  onModeChange: (mode: ReaderSidebarMode) => void
}

export default function ChapterSidebar({
  chapters,
  currentChapterId,
  mode,
  onChapterClick,
  onModeChange
}: Props) {
  const [query, setQuery] = useState('')

  const filteredChapters = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return chapters
    return chapters.filter((c) => (c.title || '').toLowerCase().includes(q))
  }, [chapters, query])

  const parentRef = useRef<HTMLDivElement | null>(null)
  const getScrollElement = useCallback(() => parentRef.current, [])

  const virtualizer = useVirtualizer({
    count: filteredChapters.length,
    getScrollElement,
    estimateSize: useCallback(() => 32, []),
    overscan: 10
  })

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      className={`
        w-[260px] border-r border-[var(--color-border)]
        overflow-hidden flex flex-col
        ${
          mode === 'hover'
            ? `absolute left-0 top-0 bottom-0 z-[2]
               translate-x-[calc(-100%+18px)] transition-transform duration-[180ms] ease-out
               bg-[var(--color-background,#181818)] shadow-[0_10px_28px_rgba(0,0,0,0.16)]
               hover:translate-x-0`
            : 'bg-[var(--color-background-soft)]'
        }
      `}
    >
      {/* Header */}
      <div className="p-3 flex flex-col gap-2 border-b border-[var(--color-border)] [&_.heroui-tabs]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]">
        {/* Top: Title + Mode Toggle */}
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">目录</span>
          <Tabs
            size="sm"
            selectedKey={mode}
            onSelectionChange={(key) => onModeChange(key as ReaderSidebarMode)}
            classNames={{
              base: 'w-auto',
              tabList: 'gap-0 p-0 bg-transparent',
              tab: 'h-6 px-2 min-w-[3rem] data-[selected=true]:bg-[var(--color-primary)] data-[selected=true]:text-white',
              cursor: 'bg-[var(--color-primary)]'
            }}
          >
            <Tab key="fixed" title="固定" />
            <Tab key="hover" title="悬浮" />
          </Tabs>
        </div>

        {/* Bottom: Search Input */}
        <div className="flex flex-col gap-1.5">
          <Input
            size="sm"
            isClearable
            value={query}
            onValueChange={setQuery}
            placeholder="搜索章节"
            classNames={{
              inputWrapper: '[-webkit-app-region:no-drag]'
            }}
          />
          {query.trim() && (
            <span className="text-xs text-[var(--color-text-3)]">
              {filteredChapters.length}/{chapters.length}
            </span>
          )}
        </div>
      </div>

      {/* Virtual List */}
      <div ref={parentRef} className="flex-1 overflow-auto p-2 [&_button]:[-webkit-app-region:no-drag]">
        <div
          style={{ height: `${virtualizer.getTotalSize()}px` }}
          className="w-full relative"
        >
          {virtualItems.map((virtualItem) => {
            const chapter = filteredChapters[virtualItem.index]
            if (!chapter) return null

            const active = chapter.id === currentChapterId

            return (
              <div
                key={virtualItem.key}
                style={{ transform: `translateY(${virtualItem.start}px)` }}
                className="absolute top-0 left-0 w-full pb-1.5"
              >
                <Button
                  size="sm"
                  variant={active ? 'solid' : 'light'}
                  color={active ? 'primary' : 'default'}
                  onPress={() => onChapterClick(chapter)}
                  className="w-full justify-start text-left"
                >
                  <span className="truncate max-w-full">{chapter.title}</span>
                </Button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
