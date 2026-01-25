/**
 * 文案编辑页面
 * 用于导入和管理TXT文件的图书库
 */

import { Button, Input, Select, SelectItem } from '@heroui/react'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import Sortable from '@renderer/components/dnd/Sortable'
import { useDndReorder } from '@renderer/components/dnd/useDndReorder'
import { useTextEditorLibrary } from '@renderer/hooks/useTextEditorLibrary'
import type { TextBook } from '@shared/types'
import { BookOpen, Search, Upload } from 'lucide-react'
import { FC, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import BookCard from './components/BookCard'
import BookCardSkeleton from './components/BookCardSkeleton'

// 布局尺寸配置
type GridSize = 'large' | 'medium' | 'small'

type SortKey = 'updatedDesc' | 'createdDesc' | 'titleAsc' | 'sizeDesc' | 'custom'

interface GridConfig {
  targetColumns: number
  minWidth: number
  gap: number
  cardMaxWidth: number
}

const GRID_CONFIGS: Record<GridSize, GridConfig> = {
  // 调整尺寸配置，让卡片更紧凑
  large: { targetColumns: 3, minWidth: 180, gap: 20, cardMaxWidth: 260 },
  medium: { targetColumns: 4, minWidth: 150, gap: 16, cardMaxWidth: 220 },
  small: { targetColumns: 6, minWidth: 120, gap: 12, cardMaxWidth: 180 }
}

const GRID_SIZE_STORAGE_KEY = 'textEditor:gridSize'

/** 生成Grid CSS样式 - 使用简化的响应式grid配置 */
const getGridStyle = (config: GridConfig): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${config.minWidth}px, 1fr))`,
  gap: `${config.gap}px`,
  width: '100%',
  alignContent: 'start',
  justifyContent: 'start'
})

const TextEditorPage: FC = () => {
  const { t } = useTranslation()
  const { books, isLoading, importBook, updateTitle, deleteBook, openReadView, reorderBooks } =
    useTextEditorLibrary()
  const [gridSize, setGridSize] = useState<GridSize>(() => {
    const raw = localStorage.getItem(GRID_SIZE_STORAGE_KEY)
    return raw === 'large' || raw === 'medium' || raw === 'small' ? raw : 'medium'
  })
  const [sortKey, setSortKey] = useState<SortKey>('updatedDesc')
  const [searchText, setSearchText] = useState('')
  const gridConfig = GRID_CONFIGS[gridSize]
  const gridStyle = useMemo(() => getGridStyle(gridConfig), [gridConfig])

  useEffect(() => {
    localStorage.setItem(GRID_SIZE_STORAGE_KEY, gridSize)
  }, [gridSize])

  const handleImport = async () => {
    await importBook()
  }

  const visibleBooks = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    const filtered = query
      ? books.filter((book) => {
          return (
            book.title.toLowerCase().includes(query) ||
            book.originalFileName.toLowerCase().includes(query)
          )
        })
      : books

    // 自定义排序模式下不再排序，保持原始顺序
    if (sortKey === 'custom') {
      return filtered
    }

    const list = [...filtered]
    switch (sortKey) {
      case 'createdDesc':
        return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      case 'titleAsc':
        return list.sort((a, b) => a.title.localeCompare(b.title))
      case 'sizeDesc':
        return list.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0))
      case 'updatedDesc':
      default:
        return list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    }
  }, [books, searchText, sortKey])

  // 拖拽排序支持
  const { onSortEnd } = useDndReorder<TextBook>({
    originalList: books,
    filteredList: visibleBooks,
    onUpdate: reorderBooks,
    itemKey: 'id'
  })

  const handleSortEnd = useCallback(
    (event: { oldIndex: number; newIndex: number }) => {
      // 拖拽排序后自动切换到自定义排序模式
      if (sortKey !== 'custom') {
        setSortKey('custom')
      }
      onSortEnd(event)
    },
    [onSortEnd, sortKey]
  )

  const renderBookCard = useCallback(
    (book: TextBook, { dragging }: { dragging: boolean }) => (
      <BookCard
        book={book}
        isDragging={dragging}
        onTitleChange={(newTitle) => updateTitle(book.id, newTitle)}
        onDelete={() => deleteBook(book.id)}
        onRead={() => openReadView(book.id)}
      />
    ),
    [updateTitle, deleteBook, openReadView]
  )

  return (
    <div className="flex flex-col h-screen w-full bg-[var(--color-background)]">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none', padding: '0 16px' }}>
          <div className="flex items-baseline gap-2.5 w-full">
            <span className="text-base font-medium">{t('textEditor.title', '文案编辑')}</span>
            <span className="text-[var(--color-text-3)] font-normal">
              {t('textEditor.count', '{{count}} 本', { count: books.length })}
            </span>
          </div>
        </NavbarCenter>
      </Navbar>

      {/* Top Toolbar with Search and Controls */}
      <div className="border-b-[0.5px] border-[var(--color-border)] bg-[var(--color-background)] p-3">
        <div className="flex gap-2.5 items-center justify-between flex-wrap max-w-[1440px] mx-auto">
          {/* Search Bar - Left */}
          <div className="flex-1 min-w-[320px]">
            <Input
              isClearable
              size="sm"
              value={searchText}
              placeholder={t('textEditor.searchPlaceholder', '搜索书名或文件名')}
              startContent={<Search size={14} />}
              onValueChange={setSearchText}
              className="max-w-[560px] [-webkit-app-region:no-drag]"
            />
          </div>

          {/* Controls - Right */}
          <div className="flex gap-2.5 items-center justify-end flex-[0_1_auto]">
            <Select
              size="sm"
              selectedKeys={[sortKey]}
              className="w-32 [-webkit-app-region:no-drag]"
              isDisabled={books.length === 0}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as SortKey
                setSortKey(selected)
              }}
              aria-label="Sort by"
            >
              <SelectItem key="custom">
                {t('textEditor.sort.custom', '自定义排序')}
              </SelectItem>
              <SelectItem key="updatedDesc">
                {t('textEditor.sort.updatedDesc', '最近更新')}
              </SelectItem>
              <SelectItem key="createdDesc">
                {t('textEditor.sort.createdDesc', '最近导入')}
              </SelectItem>
              <SelectItem key="titleAsc">
                {t('textEditor.sort.titleAsc', '书名 A-Z')}
              </SelectItem>
              <SelectItem key="sizeDesc">
                {t('textEditor.sort.sizeDesc', '文件大小')}
              </SelectItem>
            </Select>

            <div className="flex gap-1 [-webkit-app-region:no-drag]">
              <Button
                size="sm"
                variant={gridSize === 'large' ? 'solid' : 'flat'}
                isDisabled={books.length === 0}
                onPress={() => setGridSize('large')}
                className="min-w-12"
              >
                {t('textEditor.size.large', '大')}
              </Button>
              <Button
                size="sm"
                variant={gridSize === 'medium' ? 'solid' : 'flat'}
                isDisabled={books.length === 0}
                onPress={() => setGridSize('medium')}
                className="min-w-12"
              >
                {t('textEditor.size.medium', '中')}
              </Button>
              <Button
                size="sm"
                variant={gridSize === 'small' ? 'solid' : 'flat'}
                isDisabled={books.length === 0}
                onPress={() => setGridSize('small')}
                className="min-w-12"
              >
                {t('textEditor.size.small', '小')}
              </Button>
            </div>

            <Button
              color="primary"
              size="sm"
              startContent={<Upload size={14} />}
              onPress={handleImport}
              className="[-webkit-app-region:no-drag]"
            >
              {t('textEditor.import', '导入TXT')}
            </Button>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-[18px_20px_20px] relative">
        {isLoading ? (
          <div style={gridStyle}>
            {/* Show 6 skeleton cards while loading */}
            {Array.from({ length: 6 }).map((_, i) => (
              <BookCardSkeleton key={i} />
            ))}
          </div>
        ) : books.length === 0 ? (
          <div className="flex justify-center items-center h-full">
            <div className="flex flex-col items-center gap-6 max-w-md text-center">
              <div className="w-24 h-24 rounded-full bg-[var(--color-fill-2)] flex items-center justify-center">
                <BookOpen size={48} className="text-[var(--color-text-3)]" />
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-xl font-semibold text-[var(--color-text-1)] m-0">
                  {t('textEditor.emptyTitle', '还没有图书')}
                </h3>
                <p className="text-[var(--color-text-3)] m-0">
                  {t('textEditor.emptyDescription', '点击下方按钮导入您的第一本TXT文件，开始您的阅读之旅')}
                </p>
              </div>
              <Button
                color="primary"
                size="lg"
                startContent={<Upload size={20} />}
                onPress={handleImport}
                className="shadow-lg"
              >
                {t('textEditor.import', '导入TXT')}
              </Button>
            </div>
          </div>
        ) : visibleBooks.length === 0 ? (
          <div className="flex justify-center items-center h-full">
            <p className="text-[var(--color-text-3)]">{t('common.no_results', '无结果')}</p>
          </div>
        ) : (
          <Sortable<TextBook>
            items={visibleBooks}
            itemKey="id"
            onSortEnd={handleSortEnd}
            renderItem={renderBookCard}
            layout="grid"
            useDragOverlay
            showGhost
            gap={`${gridConfig.gap}px`}
            listStyle={gridStyle}
            restrictions={{ scrollableAncestor: true }}
          />
        )}
      </div>
    </div>
  )
}

export default TextEditorPage
