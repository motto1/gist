/**
 * 小说工具面板
 * 集成小说压缩器、人物志、大纲提取器三个工具
 * 支持直接读取当前阅读的txt文件，并实现章节跳转联动
 * 完整还原原有工具页面的所有设置选项
 * 使用 HeroUI + Tailwind CSS 重构
 */

import {
  Button,
  Checkbox,
  Chip,
  Input,
  Select,
  SelectItem,
  Slider,
  Spinner,
  Switch,
  Tooltip
} from '@heroui/react'
import { getActualProvider, providerToAiSdkConfig } from '@renderer/aiCore/provider/providerConfig'
import ModelSelectButton from '@renderer/components/ModelSelectButton'
import SelectModelPopup from '@renderer/components/Popups/SelectModelPopup'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import type { Model, NovelCompressionState, NovelOutlineState, ReaderChapter, TextBook } from '@shared/types'
import { BookOpen, ChevronLeft, ChevronRight, FileText, Info, Layers, Minus, Plus, Users } from 'lucide-react'
import { FC, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useReaderNovelTools } from '../hooks/useReaderNovelTools'
import { chineseNumberToInt, extractChapterNoFromTitle } from '../utils/chapterUtils'
import NovelToolHistoryView from './NovelToolHistoryView'
import {
  ActionButtons,
  AdvancedSettings,
  ChunkModeSettings,
  EmptyState,
  ProgressSection
} from './NovelToolShared'
import RightPanelResultViewer from './RightPanelResultViewer'
import { TextReaderMarkdown } from './TextReaderMarkdown'

// 工具栏字体大小常量
const TOOLBAR_FONT_SIZE_STORAGE_KEY = 'textReader.toolbarFontSize'
const DEFAULT_TOOLBAR_FONT_SIZE = 13
const MIN_TOOLBAR_FONT_SIZE = 10
const MAX_TOOLBAR_FONT_SIZE = 24
const TOOLBAR_FONT_SIZE_STEP = 1

// 自定义 hook：管理工具栏字体大小
function useToolbarFontSize() {
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = window.localStorage.getItem(TOOLBAR_FONT_SIZE_STORAGE_KEY)
      const parsed = saved ? Number(saved) : NaN
      if (Number.isFinite(parsed) && parsed >= MIN_TOOLBAR_FONT_SIZE && parsed <= MAX_TOOLBAR_FONT_SIZE) {
        return parsed
      }
    } catch {
      // ignore
    }
    return DEFAULT_TOOLBAR_FONT_SIZE
  })

  const updateFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(MIN_TOOLBAR_FONT_SIZE, Math.min(MAX_TOOLBAR_FONT_SIZE, prev + delta))
      try {
        window.localStorage.setItem(TOOLBAR_FONT_SIZE_STORAGE_KEY, String(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  return { fontSize, updateFontSize }
}

type ToolType = 'compression' | 'character' | 'outline'
type ToolView = 'run' | 'result' | 'history'

const MIN_RATIO = 1
const MAX_RATIO = 60

const TOOL_VIEW_OPTIONS: Array<{ key: ToolView; label: string }> = [
  { key: 'run', label: '运行与设置' },
  { key: 'result', label: '结果' },
  { key: 'history', label: '历史' }
]

const ToolViewSelector: FC<{
  value: ToolView
  onChange: (view: ToolView) => void
}> = ({ value, onChange }) => (
  <div className="px-3 py-2 border-b border-white/10 [&_button]:[-webkit-app-region:no-drag]">
    <div className="rounded-xl border border-white/10 bg-content2/40 p-1 backdrop-blur-sm">
      <div className="flex gap-1">
        {TOOL_VIEW_OPTIONS.map((opt) => {
          const selected = value === opt.key
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              className={`flex-1 flex h-8 items-center justify-center rounded-md text-sm transition-all ${
                selected ? 'bg-content1 shadow-sm' : 'text-default-500 hover:bg-content1/50'
              }`}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  </div>
)

type ChapterMatch = {
  start: number
  end: number
  text: string
  chapterId: string
}

type Props = {
  book: TextBook | null
  content: string
  chapters: ReaderChapter[]
  onChapterClick: (chapterId: string) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

const NovelToolsPanel: FC<Props> = ({
  book,
  content,
  chapters,
  onChapterClick,
  collapsed,
  onCollapsedChange
}) => {
  const { t } = useTranslation()
  const [activeTool, setActiveTool] = useState<ToolType>('compression')
  const [newCharacterName, setNewCharacterName] = useState('')

  // 使用工具栏字体大小 hook
  const { fontSize: toolbarFontSize, updateFontSize: updateToolbarFontSize } = useToolbarFontSize()

  const [toolViewByTool, setToolViewByTool] = useState<Record<ToolType, ToolView>>({
    compression: 'run',
    character: 'run',
    outline: 'run'
  })

  const historyBaseName = useMemo(() => {
    const raw = book?.originalFileName || book?.folderName || book?.title || '未命名'
    const onlyName = raw.replace(/^.*[\\/]/, '')
    const dot = onlyName.lastIndexOf('.')
    const withoutExt = dot > 0 ? onlyName.slice(0, dot) : onlyName
    const cleaned =
      withoutExt
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || '未命名'
    return cleaned
  }, [book?.originalFileName, book?.folderName, book?.title])

  const setToolView = useCallback((tool: ToolType, view: ToolView) => {
    setToolViewByTool((prev) => ({ ...prev, [tool]: view }))
  }, [])

  type ViewerState = {
    title: string
    kind: 'text' | 'markdown'
    content: string
    rendered?: React.ReactNode
    openDirPath?: string
  }

  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const closeViewer = useCallback(() => setViewer(null), [])

  const modelFilter = useCallback((model: Model) => {
    return !isEmbeddingModel(model) && !isRerankModel(model) && !isTextToImageModel(model)
  }, [])

  const {
    compressionState,
    characterState,
    outlineState,
    compressionActions,
    characterActions,
    outlineActions,
    isInitialized
  } = useReaderNovelTools(book, content, chapters)

  useEffect(() => {
    if (compressionState?.result && !compressionState.isProcessing && toolViewByTool.compression === 'run') {
      setToolView('compression', 'result')
    }
  }, [compressionState?.result, compressionState?.isProcessing, toolViewByTool.compression, setToolView])

  useEffect(() => {
    if (characterState?.result && !characterState.isProcessing && toolViewByTool.character === 'run') {
      setToolView('character', 'result')
    }
  }, [characterState?.result, characterState?.isProcessing, toolViewByTool.character, setToolView])

  useEffect(() => {
    if (outlineState?.result && !outlineState.isProcessing && toolViewByTool.outline === 'run') {
      setToolView('outline', 'result')
    }
  }, [outlineState?.result, outlineState?.isProcessing, toolViewByTool.outline, setToolView])

  // 工具选项
  const toolOptions = useMemo(
    () => [
      { key: 'compression', icon: <Layers size={16} />, tooltip: '小说压缩器' },
      { key: 'character', icon: <Users size={16} />, tooltip: '人物志' },
      { key: 'outline', icon: <FileText size={16} />, tooltip: '大纲提取' }
    ],
    []
  )

  const startTool = useCallback(
    async (
      tool: 'compression' | 'character' | 'outline',
      state: NovelCompressionState | NovelOutlineState,
      actions: { start: (customPrompt?: string) => void; updateSettings: (settings: any) => void }
    ) => {
      if (!content) {
        window.toast?.error?.('正文内容为空')
        return
      }
      if (state.isProcessing) return

      const getModels = () => {
        if (state.enableMultiModel && state.selectedModels.length > 0) return state.selectedModels
        if (!state.enableMultiModel && state.selectedModel) return [state.selectedModel]
        return []
      }

      let models = getModels()
      if (models.length === 0) {
        const selected = await SelectModelPopup.show({
          model: state.selectedModel ?? undefined,
          filter: modelFilter
        })
        if (!selected) return

        if (state.enableMultiModel) {
          actions.updateSettings({ selectedModels: [...state.selectedModels, selected] })
          models = [selected]
        } else {
          actions.updateSettings({ selectedModel: selected })
          models = [selected]
        }
      }

      try {
        const providerConfigs = models.map((model) => {
          const actualProvider = getActualProvider(model)
          if (!actualProvider) {
            throw new Error(`找不到可用的 Provider: ${model.name}`)
          }
          const config = providerToAiSdkConfig(actualProvider, model)
          return {
            modelId: model.id,
            providerId: config.providerId,
            options: config.options
          }
        })

        if (tool === 'compression') {
          await window.api.novelCompress.startCompression(providerConfigs)
        } else if (tool === 'character') {
          await window.api.novelCharacter.startCompression(providerConfigs)
        } else {
          await window.api.novelOutline.startCompression(providerConfigs)
        }
      } catch (err) {
        console.error('Failed to start tool:', err)
        window.toast?.error?.('启动失败，请检查模型与提供方配置')
      }
    },
    [content, modelFilter]
  )

  const chapterNoToId = useMemo(() => {
    const map = new Map<number, string>()
    for (const chapter of chapters) {
      const no = extractChapterNoFromTitle(chapter.title)
      if (no !== null && !map.has(no)) map.set(no, chapter.id)
    }
    return map
  }, [chapters])

  const getReferencedChapters = useCallback(
    (text: string) => {
      const referenced = new Set<string>()
      if (!text) return []

      for (const chapter of chapters) {
        if (!chapter.title || chapter.title.length > 80) continue
        if (text.includes(chapter.title)) {
          referenced.add(chapter.id)
        }
      }

      const tokenRe = /第\s*([0-9〇零一二两三四五六七八九十百千万]+)\s*(章|节|回|卷|部|篇)/g
      for (const m of text.matchAll(tokenRe)) {
        const no = chineseNumberToInt(m[1] ?? '')
        if (no === null) continue
        const chapterId = chapterNoToId.get(no)
        if (chapterId) referenced.add(chapterId)
      }

      return chapters.filter((c) => referenced.has(c.id))
    },
    [chapters, chapterNoToId]
  )

  const renderChapterNavigator = useCallback(
    (text: string) => {
      const refs = getReferencedChapters(text)
      if (refs.length === 0) return null

      const MAX_ITEMS = 24
      const shown = refs.slice(0, MAX_ITEMS)

      return (
        <div className="flex flex-col gap-1.5 pb-2 mb-3 border-b border-dashed border-divider">
          <span className="text-xs text-default-500">章节跳转</span>
          <div className="flex flex-wrap gap-1">
            {shown.map((c) => (
              <Button
                key={c.id}
                variant="light"
                size="sm"
                className="h-auto min-h-0 px-2 py-1 text-xs"
                onPress={() => onChapterClick(c.id)}
              >
                {c.title}
              </Button>
            ))}
            {refs.length > MAX_ITEMS && <span className="text-xs text-default-500">……</span>}
          </div>
        </div>
      )
    },
    [getReferencedChapters, onChapterClick]
  )

  const renderResultWithChapterLinks = useCallback(
    (resultText: string) => {
      if (!resultText || !chapters.length) {
        return <pre className="whitespace-pre-wrap break-words m-0 font-[inherit] leading-relaxed" style={{ fontSize: `${toolbarFontSize}px` }}>{resultText}</pre>
      }

      const MAX_INLINE_LINKS = 200
      const matches: ChapterMatch[] = []

      const tokenRe = /第\s*([0-9〇零一二两三四五六七八九十百千万]+)\s*(章|节|回|卷|部|篇)/g
      for (const m of resultText.matchAll(tokenRe)) {
        if (matches.length >= MAX_INLINE_LINKS) break
        if (typeof m.index !== 'number') continue
        const no = chineseNumberToInt(m[1] ?? '')
        if (no === null) continue
        const chapterId = chapterNoToId.get(no)
        if (!chapterId) continue
        const token = m[0]
        matches.push({ start: m.index, end: m.index + token.length, text: token, chapterId })
      }

      const referenced = getReferencedChapters(resultText)
      for (const chapter of referenced) {
        if (matches.length >= MAX_INLINE_LINKS * 2) break
        const title = chapter.title
        if (!title || title.length > 120) continue
        let from = 0
        while (from < resultText.length) {
          const idx = resultText.indexOf(title, from)
          if (idx === -1) break
          matches.push({ start: idx, end: idx + title.length, text: title, chapterId: chapter.id })
          from = idx + title.length
          if (matches.length >= MAX_INLINE_LINKS * 2) break
        }
      }

      if (matches.length === 0) {
        return <pre className="whitespace-pre-wrap break-words m-0 font-[inherit] leading-relaxed" style={{ fontSize: `${toolbarFontSize}px` }}>{resultText}</pre>
      }

      matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))

      const nonOverlapping: ChapterMatch[] = []
      let lastEnd = -1
      for (const m of matches) {
        if (m.start < lastEnd) continue
        nonOverlapping.push(m)
        lastEnd = m.end
        if (nonOverlapping.length >= MAX_INLINE_LINKS) break
      }

      const elements: React.ReactNode[] = []
      let cursor = 0
      for (const m of nonOverlapping) {
        if (m.start > cursor) {
          elements.push(<span key={`t-${cursor}`}>{resultText.slice(cursor, m.start)}</span>)
        }
        elements.push(
          <span
            key={`c-${m.chapterId}-${m.start}`}
            onClick={() => onChapterClick(m.chapterId)}
            className="text-primary cursor-pointer underline decoration-dashed hover:decoration-solid"
          >
            {m.text}
          </span>
        )
        cursor = m.end
      }
      if (cursor < resultText.length) {
        elements.push(<span key="t-end">{resultText.slice(cursor)}</span>)
      }

      return <pre className="whitespace-pre-wrap break-words m-0 font-[inherit] leading-relaxed" style={{ fontSize: `${toolbarFontSize}px` }}>{elements}</pre>
    },
    [chapters, chapterNoToId, getReferencedChapters, onChapterClick, toolbarFontSize]
  )

  const handleOpenViewer = useCallback(
    (payload: ViewerState) => {
      if (payload.kind !== 'text') {
        setViewer(payload)
        return
      }
      const text = payload.content || ''
      setViewer({
        ...payload,
        rendered: (
          <>
            {renderChapterNavigator(text)}
            {renderResultWithChapterLinks(text)}
          </>
        )
      })
    },
    [renderChapterNavigator, renderResultWithChapterLinks]
  )

  const compressionResultRendered = useMemo(() => {
    const merged = compressionState?.result?.merged || ''
    if (!merged) return null
    return (
      <>
        {renderChapterNavigator(merged)}
        {renderResultWithChapterLinks(merged)}
      </>
    )
  }, [compressionState?.result?.merged, renderChapterNavigator, renderResultWithChapterLinks, toolbarFontSize])

  const outlineResultRendered = useMemo(() => {
    const md = outlineState?.result?.final || ''
    if (!md) return null
    return (
      <TextReaderMarkdown className="markdown" style={{ fontSize: `${toolbarFontSize}px` }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </TextReaderMarkdown>
    )
  }, [outlineState?.result?.final, toolbarFontSize])

  // 当字体大小变化时，更新查看器中的渲染内容
  // 对所有 text 类型且有 rendered 的查看器，根据其 content 重新生成渲染内容
  useEffect(() => {
    if (!viewer) return
    if (viewer.kind !== 'text' || !viewer.rendered) return

    // 使用存储的 content 重新生成带有新字体大小的渲染内容
    const text = viewer.content || ''
    const newRendered = (
      <>
        {renderChapterNavigator(text)}
        {renderResultWithChapterLinks(text)}
      </>
    )
    setViewer((prev) => prev ? { ...prev, rendered: newRendered } : null)
  }, [toolbarFontSize, renderChapterNavigator, renderResultWithChapterLinks])

  // ==================== 模型选择组件 ====================
  const renderModelSelector = (
    state: NovelCompressionState | NovelOutlineState,
    updateSettings: (settings: Partial<NovelCompressionState | NovelOutlineState>) => void
  ) => {
    const { selectedModel, selectedModels, enableMultiModel } = state

    const handleModelSelect = async () => {
      const model = await SelectModelPopup.show({
        model: selectedModel ?? undefined,
        filter: modelFilter
      })
      if (model) updateSettings({ selectedModel: model })
    }

    const handleAddModel = async () => {
      const model = await SelectModelPopup.show({ filter: modelFilter })
      if (model && !selectedModels.find((m) => m.id === model.id && m.provider === model.provider)) {
        updateSettings({ selectedModels: [...selectedModels, model] })
      }
    }

    const handleRemoveModel = (modelId: string) => {
      updateSettings({ selectedModels: selectedModels.filter((m) => m.id !== modelId) })
    }

    const handleToggleMultiModel = (enabled: boolean) => {
      updateSettings({
        enableMultiModel: enabled,
        selectedModels: enabled ? selectedModels : []
      })
    }

    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">{t('novel.settings.model')}</span>
          <Checkbox isSelected={enableMultiModel} onValueChange={handleToggleMultiModel} size="sm">
            多模型
          </Checkbox>
        </div>
        {!enableMultiModel ? (
          selectedModel ? (
            <ModelSelectButton
              model={selectedModel}
              onSelectModel={(model) => updateSettings({ selectedModel: model })}
              modelFilter={modelFilter}
            />
          ) : (
            <Button variant="bordered" onPress={handleModelSelect} fullWidth size="sm">
              {t('novel.settings.model_placeholder')}
            </Button>
          )
        ) : (
          <div className="flex flex-col gap-1 w-full">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-default-500">已选 {selectedModels.length} 个模型</span>
              <Button
                variant="bordered"
                size="sm"
                startContent={<Plus size={12} />}
                onPress={handleAddModel}
                className="h-7"
              >
                添加
              </Button>
            </div>
            {selectedModels.map((model, index) => (
              <div
                key={`${model.id}-${model.provider}`}
                className="flex items-center justify-between px-2 py-1 bg-content1 rounded border border-divider"
              >
                <span className="text-xs">#{index + 1} {model.name}</span>
                <Button
                  variant="light"
                  size="sm"
                  color="danger"
                  startContent={<Minus size={12} />}
                  onPress={() => handleRemoveModel(model.id)}
                  className="h-6 min-w-6 px-1"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ==================== 压缩器工具 ====================
  const renderCompressionTool = () => {
    const state = compressionState
    const actions = compressionActions

    if (!state) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 h-[200px]">
          <Spinner />
        </div>
      )
    }

    const isProcessing = state.isProcessing
    const hasResult = !!state.result?.merged
    const canStart = !!content

    return (
      <div className="flex flex-col h-full overflow-hidden">
        <ToolViewSelector value={toolViewByTool.compression} onChange={(view) => setToolView('compression', view)} />

        <div className="flex-1 min-h-0 overflow-hidden">
          {toolViewByTool.compression === 'run' ? (
            <div className="h-full flex flex-col overflow-hidden">
              <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3 [-webkit-app-region:no-drag] novel-tools-scrollbar">
                {renderModelSelector(state, actions.updateSettings)}

                {/* 压缩比例 */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm">压缩比例: {state.ratioPercent}%</span>
                  <Slider
                    size="sm"
                    minValue={MIN_RATIO}
                    maxValue={MAX_RATIO}
                    value={state.ratioPercent}
                    onChange={(value) => actions.updateSettings({ ratioPercent: value as number })}
                    className="max-w-full"
                  />
                </div>

                <ChunkModeSettings
                  chunkMode={state.chunkMode || 'bySize'}
                  chunkSize={state.chunkSize}
                  overlap={state.overlap}
                  chaptersPerChunk={state.chaptersPerChunk || 3}
                  chapters={chapters}
                  onChunkModeChange={(value) => actions.updateSettings({ chunkMode: value })}
                  onChunkSizeChange={(value) => actions.updateSettings({ chunkSize: value })}
                  onOverlapChange={(value) => actions.updateSettings({ overlap: value })}
                  onChaptersPerChunkChange={(value) => actions.updateSettings({ chaptersPerChunk: value })}
                />

                <AdvancedSettings
                  maxConcurrency={state.maxConcurrency}
                  continueLatestTask={state.continueLatestTask}
                  enableAutoResume={state.enableAutoResume}
                  showTemperature
                  temperature={state.temperature}
                  onMaxConcurrencyChange={(value) => actions.updateSettings({ maxConcurrency: value })}
                  onContinueLatestTaskChange={(value) => actions.updateSettings({ continueLatestTask: value })}
                  onEnableAutoResumeChange={(value) => actions.updateSettings({ enableAutoResume: value })}
                  onTemperatureChange={(value) => actions.updateSettings({ temperature: value })}
                />
              </div>

              {isProcessing && <ProgressSection progress={state.progress} />}

              <ActionButtons
                isProcessing={isProcessing}
                canStart={canStart}
                startLabel="开始压缩"
                processingLabel="处理中..."
                onStart={() => startTool('compression', state, actions)}
                onCancel={actions.cancel}
              />
            </div>
          ) : toolViewByTool.compression === 'result' ? (
            hasResult ? (
              <div className="h-full flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-3 py-3 border-b border-divider shrink-0">
                  <Chip color="success" size="sm">压缩完成</Chip>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onPress={() => {
                        const merged = state.result?.merged || ''
                        setViewer({
                          title: '压缩结果',
                          kind: 'text',
                          content: merged,
                          rendered: compressionResultRendered ?? undefined,
                          openDirPath: book?.folderPath ? `${book.folderPath}/compression` : undefined
                        })
                      }}
                    >
                      全屏显示
                    </Button>
                    <Button
                      size="sm"
                      onPress={() => {
                        actions.reset()
                        setToolView('compression', 'run')
                      }}
                    >
                      重新压缩
                    </Button>
                  </div>
                </div>
                <div
                  className="flex-1 overflow-auto px-3 py-3 [-webkit-app-region:no-drag] novel-tools-scrollbar"
                  onWheel={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault()
                      const delta = e.deltaY < 0 ? TOOLBAR_FONT_SIZE_STEP : -TOOLBAR_FONT_SIZE_STEP
                      updateToolbarFontSize(delta)
                    }
                  }}
                >
                  {compressionResultRendered}
                </div>
              </div>
            ) : (
              <EmptyState message="暂无结果" />
            )
          ) : book ? (
            <div className="h-full overflow-hidden flex flex-col min-h-0">
              <NovelToolHistoryView
                tool="compression"
                book={book}
                baseName={historyBaseName}
                onOpenViewer={handleOpenViewer}
              />
            </div>
          ) : (
            <EmptyState message="请先打开一本书籍" />
          )}
        </div>
      </div>
    )
  }

  // ==================== 人物志工具 ====================
  const renderCharacterTool = () => {
    const state = characterState
    const actions = characterActions

    if (!state) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 h-[200px]">
          <Spinner />
        </div>
      )
    }

    const isProcessing = state.isProcessing
    const canStart = !!content
    const targetCharacters = state.targetCharacterConfig?.characters || []

    const handleAddCharacter = () => {
      if (newCharacterName.trim()) {
        const newCharacters = [...targetCharacters, newCharacterName.trim()]
        actions.updateSettings({
          targetCharacterConfig: {
            enabled: state.targetCharacterConfig?.enabled || false,
            characters: newCharacters
          }
        })
        setNewCharacterName('')
      }
    }

    const handleRemoveCharacter = (index: number) => {
      const newCharacters = targetCharacters.filter((_, i) => i !== index)
      actions.updateSettings({
        targetCharacterConfig: {
          enabled: state.targetCharacterConfig?.enabled || false,
          characters: newCharacters
        }
      })
    }

    return (
      <div className="flex flex-col h-full overflow-hidden">
        <ToolViewSelector value={toolViewByTool.character} onChange={(view) => setToolView('character', view)} />

        <div className="flex-1 min-h-0 overflow-hidden">
          {toolViewByTool.character === 'run' ? (
            <div className="h-full flex flex-col overflow-hidden">
              <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3 [-webkit-app-region:no-drag] novel-tools-scrollbar">
                {renderModelSelector(state, actions.updateSettings)}

                {/* 输出格式 */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm">输出格式</span>
                  <Select
                    size="sm"
                    selectedKeys={[state.characterOutputFormat || 'csv']}
                    onSelectionChange={(keys) => {
                      const value = Array.from(keys)[0] as 'csv' | 'markdown' | 'html'
                      actions.updateSettings({ characterOutputFormat: value })
                    }}
                    classNames={{ trigger: 'h-8' }}
                  >
                    <SelectItem key="csv">CSV (.csv)</SelectItem>
                    <SelectItem key="markdown">Markdown (.md)</SelectItem>
                    <SelectItem key="html">HTML (.html)</SelectItem>
                  </Select>
                </div>

                {/* 指定人物模式 */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <span className="text-sm">指定人物</span>
                      <Tooltip content="只分析指定人物的剧情">
                        <Info size={12} className="cursor-help" />
                      </Tooltip>
                    </div>
                    <Switch
                      size="sm"
                      isSelected={state.targetCharacterConfig?.enabled || false}
                      onValueChange={(checked) =>
                        actions.updateSettings({
                          targetCharacterConfig: {
                            enabled: checked,
                            characters: targetCharacters
                          }
                        })
                      }
                    />
                  </div>
                  {state.targetCharacterConfig?.enabled && (
                    <div className="flex flex-col gap-2 w-full mt-2">
                      <div className="flex gap-2">
                        <Input
                          size="sm"
                          placeholder="输入人物名称"
                          value={newCharacterName}
                          onValueChange={setNewCharacterName}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddCharacter()
                          }}
                          classNames={{ inputWrapper: 'h-8' }}
                          className="flex-1"
                        />
                        <Button
                          size="sm"
                          startContent={<Plus size={14} />}
                          onPress={handleAddCharacter}
                          className="h-8"
                        >
                          添加
                        </Button>
                      </div>
                      {targetCharacters.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {targetCharacters.map((char, index) => (
                            <Chip key={index} onClose={() => handleRemoveCharacter(index)} size="sm" variant="flat">
                              {char}
                            </Chip>
                          ))}
                        </div>
                      )}
                      {targetCharacters.length === 0 && (
                        <span className="text-[11px] text-default-500">请添加要分析的人物</span>
                      )}
                    </div>
                  )}
                </div>

                <ChunkModeSettings
                  chunkMode={state.chunkMode || 'bySize'}
                  chunkSize={state.chunkSize}
                  overlap={state.overlap}
                  chaptersPerChunk={state.chaptersPerChunk || 3}
                  chapters={chapters}
                  onChunkModeChange={(value) => actions.updateSettings({ chunkMode: value })}
                  onChunkSizeChange={(value) => actions.updateSettings({ chunkSize: value })}
                  onOverlapChange={(value) => actions.updateSettings({ overlap: value })}
                  onChaptersPerChunkChange={(value) => actions.updateSettings({ chaptersPerChunk: value })}
                />

                <AdvancedSettings
                  maxConcurrency={state.maxConcurrency}
                  continueLatestTask={state.continueLatestTask}
                  enableAutoResume={state.enableAutoResume}
                  onMaxConcurrencyChange={(value) => actions.updateSettings({ maxConcurrency: value })}
                  onContinueLatestTaskChange={(value) => actions.updateSettings({ continueLatestTask: value })}
                  onEnableAutoResumeChange={(value) => actions.updateSettings({ enableAutoResume: value })}
                />
              </div>

              {isProcessing && <ProgressSection progress={state.progress} />}

              <ActionButtons
                isProcessing={isProcessing}
                canStart={canStart}
                startLabel="开始提取"
                processingLabel="处理中..."
                onStart={() => startTool('character', state, actions)}
                onCancel={actions.cancel}
              />
            </div>
          ) : toolViewByTool.character === 'result' ? (
            book ? (
              <div className="h-full flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-3 py-3 border-b border-divider shrink-0">
                  <Chip color="success" size="sm">提取完成</Chip>
                  <Button
                    size="sm"
                    onPress={() => {
                      actions.reset()
                      setToolView('character', 'run')
                    }}
                  >
                    重新提取
                  </Button>
                </div>
                <div className="flex-1 overflow-hidden min-h-0">
                  <NovelToolHistoryView
                    tool="character"
                    book={book}
                    baseName={historyBaseName}
                    showRuns={false}
                    onOpenViewer={handleOpenViewer}
                  />
                </div>
              </div>
            ) : (
              <EmptyState message="请先打开一本书籍" />
            )
          ) : book ? (
            <div className="h-full overflow-hidden flex flex-col min-h-0">
              <NovelToolHistoryView
                tool="character"
                book={book}
                baseName={historyBaseName}
                showRuns={toolViewByTool.character === 'history'}
                onOpenViewer={handleOpenViewer}
              />
            </div>
          ) : (
            <EmptyState message="请先打开一本书籍" />
          )}
        </div>
      </div>
    )
  }

  // ==================== 大纲提取工具 ====================
  const renderOutlineTool = () => {
    const state = outlineState
    const actions = outlineActions

    if (!state) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 h-[200px]">
          <Spinner />
        </div>
      )
    }

    const isProcessing = state.isProcessing
    const hasResult = !!state.result?.final
    const canStart = !!content

    return (
      <div className="flex flex-col h-full overflow-hidden">
        <ToolViewSelector value={toolViewByTool.outline} onChange={(view) => setToolView('outline', view)} />

        <div className="flex-1 min-h-0 overflow-hidden">
          {toolViewByTool.outline === 'run' ? (
            <div className="h-full flex flex-col overflow-hidden">
              <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3 [-webkit-app-region:no-drag] novel-tools-scrollbar">
                {renderModelSelector(state, actions.updateSettings)}

                {/* 分块设置 - 大纲只支持按字数分块 */}
                <ChunkModeSettings
                  chunkMode="bySize"
                  chunkSize={state.chunkSize}
                  overlap={state.overlap}
                  chaptersPerChunk={3}
                  chapters={chapters}
                  onChunkModeChange={() => {}}
                  onChunkSizeChange={(value) => actions.updateSettings({ chunkSize: value })}
                  onOverlapChange={(value) => actions.updateSettings({ overlap: value })}
                  onChaptersPerChunkChange={() => {}}
                  showModeSelect={false}
                />

                <AdvancedSettings
                  maxConcurrency={state.maxConcurrency}
                  continueLatestTask={state.continueLatestTask}
                  enableAutoResume={state.enableAutoResume}
                  onMaxConcurrencyChange={(value) => actions.updateSettings({ maxConcurrency: value })}
                  onContinueLatestTaskChange={(value) => actions.updateSettings({ continueLatestTask: value })}
                  onEnableAutoResumeChange={(value) => actions.updateSettings({ enableAutoResume: value })}
                />
              </div>

              {isProcessing && <ProgressSection progress={state.progress} />}

              <ActionButtons
                isProcessing={isProcessing}
                canStart={canStart}
                startLabel="开始提取"
                processingLabel="处理中..."
                onStart={() => startTool('outline', state, actions)}
                onCancel={actions.cancel}
              />
            </div>
          ) : toolViewByTool.outline === 'result' ? (
            hasResult ? (
              <div className="h-full flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-3 py-3 border-b border-divider shrink-0">
                  <Chip color="success" size="sm">提取完成</Chip>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onPress={() => {
                        const md = state.result?.final || ''
                        setViewer({
                          title: '大纲结果',
                          kind: 'markdown',
                          content: md,
                          openDirPath: book?.folderPath ? `${book.folderPath}/outline` : undefined
                        })
                      }}
                    >
                      全屏显示
                    </Button>
                    <Button
                      size="sm"
                      onPress={() => {
                        actions.reset()
                        setToolView('outline', 'run')
                      }}
                    >
                      重新提取
                    </Button>
                  </div>
                </div>
                <div
                  className="flex-1 overflow-auto px-3 py-3 [-webkit-app-region:no-drag] novel-tools-scrollbar"
                  onWheel={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault()
                      const delta = e.deltaY < 0 ? TOOLBAR_FONT_SIZE_STEP : -TOOLBAR_FONT_SIZE_STEP
                      updateToolbarFontSize(delta)
                    }
                  }}
                >
                  {outlineResultRendered}
                </div>
              </div>
            ) : (
              <EmptyState message="暂无结果" />
            )
          ) : book ? (
            <div className="h-full overflow-hidden flex flex-col min-h-0">
              <NovelToolHistoryView
                tool="outline"
                book={book}
                baseName={historyBaseName}
                onOpenViewer={handleOpenViewer}
              />
            </div>
          ) : (
            <EmptyState message="请先打开一本书籍" />
          )}
        </div>
      </div>
    )
  }

  // 渲染当前工具
  const renderCurrentTool = () => {
    switch (activeTool) {
      case 'compression':
        return renderCompressionTool()
      case 'character':
        return renderCharacterTool()
      case 'outline':
        return renderOutlineTool()
      default:
        return null
    }
  }

  if (collapsed) {
    return (
      <div
        onClick={() => onCollapsedChange(false)}
        className="flex w-9 cursor-pointer flex-col items-center border-l border-white/10 bg-content1/85 pt-3 pb-3 shadow-[-6px_0_18px_rgba(0,0,0,0.12)] transition-colors hover:bg-content1"
      >
        <ChevronLeft size={16} />
        <span className="mt-2 text-default-500 text-xs [writing-mode:vertical-rl]">工具</span>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-w-0 max-w-full flex-1 flex-col overflow-hidden border-l border-white/10 bg-content1/92 shadow-[-10px_0_26px_rgba(0,0,0,0.16)] backdrop-blur-sm [-webkit-app-region:no-drag]">
      <div className="flex items-center justify-between border-white/10 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <BookOpen size={16} />
          <span className="font-semibold text-sm">小说工具</span>
        </div>
        <Button variant="light" size="sm" isIconOnly onPress={() => onCollapsedChange(true)}>
          <ChevronRight size={14} />
        </Button>
      </div>

      {/* 工具选择器 */}
      <div className="border-white/10 border-b px-3 py-2">
        <div className="rounded-xl border border-white/10 bg-content2/40 p-1 backdrop-blur-sm">
          <div className="flex gap-1">
            {toolOptions.map((option) => (
              <Tooltip key={option.key} content={option.tooltip}>
                <button
                  onClick={() => setActiveTool(option.key as ToolType)}
                  className={`flex h-8 flex-1 items-center justify-center rounded-md transition-all ${
                    activeTool === option.key ? 'bg-content1 shadow-sm' : 'hover:bg-content1/50'
                  }`}
                >
                  {option.icon}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {!book ? (
          <EmptyState message="请先打开一本书籍" />
        ) : !isInitialized ? (
          <div className="flex flex-col items-center justify-center gap-3 h-[200px]">
            <Spinner />
            <span className="text-sm text-default-500">初始化中...</span>
          </div>
        ) : (
          renderCurrentTool()
        )}
      </div>

      {viewer && (
        <RightPanelResultViewer
          title={viewer.title}
          kind={viewer.kind}
          content={viewer.content}
          rendered={viewer.rendered}
          openDirPath={viewer.openDirPath}
          onBack={closeViewer}
          fontSize={toolbarFontSize}
          onFontSizeChange={updateToolbarFontSize}
        />
      )}
    </div>
  )
}

export default NovelToolsPanel
