/**
 * 文案编辑页面
 * 用于导入和管理 TXT 文件的图书库
 */

import { Button, Card, CardBody, Input, Select, SelectItem, Tab, Tabs } from '@heroui/react'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import Sortable from '@renderer/components/dnd/Sortable'
import { useDndReorder } from '@renderer/components/dnd/useDndReorder'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { useTextEditorLibrary } from '@renderer/hooks/useTextEditorLibrary'
import type { TextBook } from '@shared/types'
import { BookOpen, PenTool, Search, Upload } from 'lucide-react'
import { type CSSProperties, FC, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { useAdaptiveScale } from '../workflow/components/useAdaptiveScale'
import BookCard from './components/BookCard'
import BookCardSkeleton from './components/BookCardSkeleton'

type GridSize = 'large' | 'medium' | 'small'

type SortKey = 'updatedDesc' | 'createdDesc' | 'titleAsc' | 'sizeDesc' | 'custom'

interface GridConfig {
  targetColumns: number
  minWidth: number
  gap: number
  cardMaxWidth: number
}

const GRID_CONFIGS: Record<GridSize, GridConfig> = {
  large: { targetColumns: 3, minWidth: 180, gap: 20, cardMaxWidth: 260 },
  medium: { targetColumns: 4, minWidth: 150, gap: 16, cardMaxWidth: 220 },
  small: { targetColumns: 6, minWidth: 120, gap: 12, cardMaxWidth: 180 }
}

const GRID_SIZE_STORAGE_KEY = 'textEditor:gridSize'

/** 生成 Grid CSS 样式 - 使用简化的响应式 grid 配置 */
const getGridStyle = (config: GridConfig): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${config.minWidth}px, 1fr))`,
  gap: `${config.gap}px`,
  width: '100%',
  alignContent: 'start',
  justifyContent: 'start'
})

const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

const TextEditorPage: FC = () => {
  const { t } = useTranslation()
  const { isTopNavbar } = useNavbarPosition()
  const { books, isLoading, importBook, updateTitle, deleteBook, openReadView, reorderBooks } = useTextEditorLibrary()

  const [gridSize, setGridSize] = useState<GridSize>(() => {
    const raw = localStorage.getItem(GRID_SIZE_STORAGE_KEY)
    return raw === 'large' || raw === 'medium' || raw === 'small' ? raw : 'medium'
  })
  const [sortKey, setSortKey] = useState<SortKey>('updatedDesc')
  const [searchText, setSearchText] = useState('')

  const gridConfig = GRID_CONFIGS[gridSize]
  const gridStyle = useMemo(() => getGridStyle(gridConfig), [gridConfig])
  const { hostRef: layoutHostRef, scaledStyle } = useAdaptiveScale(1280)

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
          return book.title.toLowerCase().includes(query) || book.originalFileName.toLowerCase().includes(query)
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
        size={gridSize}
        isDragging={dragging}
        onTitleChange={(newTitle) => updateTitle(book.id, newTitle)}
        onDelete={() => deleteBook(book.id)}
        onRead={() => openReadView(book.id)}
      />
    ),
    [gridSize, updateTitle, deleteBook, openReadView]
  )

  const isLibraryEmpty = books.length === 0

  const headerContent = (
    <HeaderBar style={dragStyle}>
      <TitleGroup style={noDragStyle}>
        <TitleIcon>
          <PenTool size={18} className="icon" />
        </TitleIcon>
        <div className="flex items-baseline gap-3">
          <PageTitle>{t('textEditor.title', '文案编辑')}</PageTitle>
          <span className="font-normal text-foreground/60 text-sm">
            {t('textEditor.count', '{{count}} 本', { count: books.length })}
          </span>
        </div>
      </TitleGroup>
    </HeaderBar>
  )

  return (
    <Container id="text-editor-page">
      {isTopNavbar ? (
        <TopNavbarHeader>{headerContent}</TopNavbarHeader>
      ) : (
        <Navbar>
          <NavbarCenter style={{ borderRight: 'none', padding: 0 }}>{headerContent}</NavbarCenter>
        </Navbar>
      )}

      <ContentContainer id="content-container">
        <MainScrollArea ref={layoutHostRef}>
          <MainInner style={scaledStyle}>
            {/* Controls */}
            <div className="border-foreground/10 border-b pb-3" style={noDragStyle}>
              <div className="flex items-center gap-3 overflow-x-auto">
                <Input
                  isClearable
                  size="sm"
                  value={searchText}
                  placeholder={t('textEditor.searchPlaceholder', '搜索书名或文件名')}
                  startContent={<Search size={14} />}
                  onValueChange={setSearchText}
                  aria-label={t('textEditor.searchPlaceholder', '搜索书名或文件名')}
                  className="min-w-[280px] max-w-[560px] flex-1 shrink-0"
                />

                <Button
                  size="sm"
                  color="primary"
                  startContent={<Upload size={14} />}
                  onPress={handleImport}
                  className="shrink-0">
                  {t('textEditor.import', '导入TXT')}
                </Button>

                <Select
                  size="sm"
                  selectedKeys={[sortKey]}
                  className="w-36 shrink-0"
                  isDisabled={isLibraryEmpty}
                  onSelectionChange={(keys) => {
                    const selected = Array.from(keys)[0] as SortKey
                    setSortKey(selected)
                  }}
                  aria-label="Sort by">
                  <SelectItem key="custom">{t('textEditor.sort.custom', '自定义排序')}</SelectItem>
                  <SelectItem key="updatedDesc">{t('textEditor.sort.updatedDesc', '最近更新')}</SelectItem>
                  <SelectItem key="createdDesc">{t('textEditor.sort.createdDesc', '最近导入')}</SelectItem>
                  <SelectItem key="titleAsc">{t('textEditor.sort.titleAsc', '书名 A-Z')}</SelectItem>
                  <SelectItem key="sizeDesc">{t('textEditor.sort.sizeDesc', '文件大小')}</SelectItem>
                </Select>

                <Tabs
                  size="sm"
                  selectedKey={gridSize}
                  onSelectionChange={(key) => setGridSize(key as GridSize)}
                  variant="light"
                  className="shrink-0"
                  classNames={{
                    tabList: 'gap-2',
                    cursor: 'bg-content2 shadow-sm',
                    tab: 'h-8 px-5',
                    tabContent: 'group-data-[selected=true]:text-primary font-medium'
                  }}>
                  <Tab key="large" title={t('textEditor.size.large', '大')} isDisabled={isLibraryEmpty} />
                  <Tab key="medium" title={t('textEditor.size.medium', '中')} isDisabled={isLibraryEmpty} />
                  <Tab key="small" title={t('textEditor.size.small', '小')} isDisabled={isLibraryEmpty} />
                </Tabs>

                {sortKey === 'custom' ? (
                  <span className="shrink-0 text-foreground/40 text-xs">
                    {t('textEditor.sort.customHint', '当前为自定义排序：可拖拽卡片调整顺序')}
                  </span>
                ) : null}
              </div>
            </div>

            {/* Main area */}
            {isLoading ? (
              <div style={gridStyle}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <BookCardSkeleton key={i} size={gridSize} />
                ))}
              </div>
            ) : isLibraryEmpty ? (
              <Card className="border-2 border-divider border-dashed bg-content1">
                <CardBody className="flex flex-col items-center justify-center gap-6 p-10 text-center">
                  <div className="flex h-24 w-24 items-center justify-center rounded-full bg-content2">
                    <BookOpen size={44} className="text-foreground/40" />
                  </div>
                  <div className="space-y-2">
                    <div className="font-semibold text-foreground text-xl">
                      {t('textEditor.emptyTitle', '还没有图书')}
                    </div>
                    <div className="text-foreground/60 text-sm">
                      {t('textEditor.emptyDescription', '点击下方按钮导入您的第一本TXT文件，开始您的阅读之旅')}
                    </div>
                  </div>
                  <Button color="primary" size="lg" startContent={<Upload size={18} />} onPress={handleImport}>
                    {t('textEditor.import', '导入TXT')}
                  </Button>
                </CardBody>
              </Card>
            ) : visibleBooks.length === 0 ? (
              <Card>
                <CardBody className="py-10 text-center text-foreground/50 text-sm">
                  {t('common.no_results', '无结果')}
                </CardBody>
              </Card>
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
          </MainInner>
        </MainScrollArea>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
`

const HeaderBar = styled.div`
  width: 100%;
  height: var(--navbar-height);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  -webkit-app-region: drag;
`

const TitleGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`

const TitleIcon = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-icon);
`

const PageTitle = styled.h1`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-1);
`

const TopNavbarHeader = styled.div`
  width: 100%;
  height: var(--navbar-height);
  border-bottom: 0.5px solid var(--color-border);
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  height: calc(100vh - var(--navbar-height));
  padding: 12px 16px;
  overflow: hidden;

  [navbar-position='top'] & {
    height: calc(100vh - var(--navbar-height) - 6px);
  }
`

const MainScrollArea = styled.div`
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-app-region: no-drag;
`

const MainInner = styled.div`
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
  overflow: visible;
  padding-top: 3px;
  padding-bottom: 32px;
`

export default TextEditorPage
