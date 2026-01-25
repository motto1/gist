/**
 * 阅读器专用的小说工具 Hook
 * 用于在TXT阅读器中集成小说压缩器、人物志、大纲提取器
 * 直接使用当前阅读的txt内容，无需重新选择文件
 */

import {
  getActualProvider,
  providerToAiSdkConfig
} from '@renderer/aiCore/provider/providerConfig'
import type { ChapterInfo, ChapterParseResult, FileMetadata,Model, ReaderChapter, TextBook } from '@shared/types'
import type { NovelCompressionState, NovelOutlineState } from '@shared/types'
import { FileTypes } from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

type StartOptions = { autoRetry?: boolean }

interface ToolActions {
  start: (customPrompt?: string, startOptions?: StartOptions) => void
  cancel: () => void
  reset: () => void
  updateSettings: (settings: Partial<NovelCompressionState | NovelOutlineState>) => void
}

export function useReaderNovelTools(book: TextBook | null, content: string, chapters: ReaderChapter[]) {
  // 三个工具的状态
  const [compressionState, setCompressionState] = useState<NovelCompressionState | null>(null)
  const [characterState, setCharacterState] = useState<NovelCompressionState | null>(null)
  const [outlineState, setOutlineState] = useState<NovelOutlineState | null>(null)

  // 是否已初始化
  const [isInitialized, setIsInitialized] = useState(false)

  // 初始化工具状态
  useEffect(() => {
    let isMounted = true

    const createThrottledStateUpdater = <T,>(setter: (next: T) => void) => {
      const latestRef = { current: null as T | null }
      const timerRef = { current: null as ReturnType<typeof setTimeout> | null }

      const flush = () => {
        timerRef.current = null
        if (!isMounted) return
        if (latestRef.current === null) return
        setter(latestRef.current)
      }

      return {
        push: (next: T) => {
          latestRef.current = next
          if (timerRef.current) return
          timerRef.current = setTimeout(flush, 80)
        },
        cancel: () => {
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    }

    const throttledCompression = createThrottledStateUpdater<NovelCompressionState>(setCompressionState)
    const throttledCharacter = createThrottledStateUpdater<NovelCompressionState>(setCharacterState)
    const throttledOutline = createThrottledStateUpdater<NovelOutlineState>(setOutlineState)

    const initializeTools = async () => {
      try {
        // 并行获取三个工具的初始状态
        const [compression, character, outline] = await Promise.all([
          window.api.novelCompress.getState(),
          window.api.novelCharacter.getState(),
          window.api.novelOutline.getState()
        ])

        if (isMounted) {
          setCompressionState(compression)
          setCharacterState(character)
          setOutlineState(outline)
          setIsInitialized(true)
        }
      } catch (error) {
        console.error('Failed to initialize novel tools:', error)
      }
    }

    initializeTools()

    // 监听状态更新
    const unsubCompress = window.api.novelCompress.onStateUpdated((state) => {
      if (!isMounted) return
      throttledCompression.push(state)
    })

    const unsubCharacter = window.api.novelCharacter.onStateUpdated((state) => {
      if (!isMounted) return
      throttledCharacter.push(state)
    })

    const unsubOutline = window.api.novelOutline.onStateUpdated((state) => {
      if (!isMounted) return
      throttledOutline.push(state)
    })

    return () => {
      isMounted = false
      throttledCompression.cancel()
      throttledCharacter.cancel()
      throttledOutline.cancel()
      unsubCompress()
      unsubCharacter()
      unsubOutline()
    }
  }, [])

  // 当书籍或内容变化时，更新工具的输入
  useEffect(() => {
    if (!book || !content || !isInitialized) return
    let isCancelled = false

    // 创建虚拟文件对象，用于工具状态
    const virtualFile: FileMetadata = {
      id: book.id,
      path: book.filePath,
      name: book.title,
      origin_name: book.originalFileName,
      ext: '.txt',
      type: FileTypes.TEXT,
      size: book.fileSize,
      charLength: content.length,
      preview: content.slice(0, 500),
      mtime: new Date(book.updatedAt).getTime(),
      created_at: book.createdAt,
      count: 1
    }

    const isPreviewOnly =
      chapters.length === 1 &&
      chapters[0]?.id === 'preview' &&
      // 与阅读器大文件阈值保持一致（避免未完成目录解析时误把预览当成全书章节）
      content.length >= 2_000_000

    const chapterParseResultFromReader: ChapterParseResult | null =
      chapters.length > 0 && !isPreviewOnly
        ? {
            success: true,
            totalChapters: chapters.length,
            usedRule: 'text-reader',
            chapters: chapters.map(
              (c, index): ChapterInfo => ({
                index,
                title: c.title,
                startOffset: c.startIndex,
                endOffset: c.endIndex
              })
            )
          }
        : null

    const sanitizeBaseName = (raw: string) => {
      return (
        raw
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200) || '未命名'
      )
    }

    ;(async () => {
      try {
        const bookDir =
          book.folderPath ||
          (book.filePath ? await window.api.path.dirname(book.filePath) : '')
        if (!bookDir) return

        const parsed = await window.api.path.parse(book.originalFileName || book.folderName || book.title || '未命名')
        const baseName = sanitizeBaseName(parsed?.name || book.folderName || book.title || '未命名')

        // 固定输出到 TextBooks/{book}/ 目录结构
        const compressionOutputPath = await window.api.path.join(bookDir, 'compression', 'compressed.txt')
        const characterOutputPath = await window.api.path.join(bookDir, 'character', `${baseName}.txt`)
        const outlineOutputBasePath = await window.api.path.join(bookDir, 'outline')

        if (isCancelled) return

        // 注意：不要在处理中覆盖主进程状态，否则切换页面/重新挂载会“打断”进程或清空状态
        if (!compressionState?.isProcessing) {
          window.api.novelCompress.setState({
            selectedFile: virtualFile,
            preview: virtualFile.preview,
            outputPath: compressionOutputPath,
            chapterParseResult: chapterParseResultFromReader
          })
        }

        if (!characterState?.isProcessing) {
          window.api.novelCharacter.setState({
            selectedFile: virtualFile,
            preview: virtualFile.preview,
            outputPath: characterOutputPath,
            chapterParseResult: chapterParseResultFromReader
          })
        }

        if (!outlineState?.isProcessing) {
          window.api.novelOutline.setState({
            selectedFile: virtualFile,
            preview: virtualFile.preview,
            outputPath: outlineOutputBasePath
          })
        }

        // 大文件“预览章节”阶段：由主进程基于文件路径解析章节，确保章节分块可立即生效。
        if (isPreviewOnly && book.filePath) {
          try {
            const parsedChapters = await window.api.novelCharacter.parseChapters(book.filePath)
            if (isCancelled) return

            if (!compressionState?.isProcessing) {
              window.api.novelCompress.setState({ chapterParseResult: parsedChapters })
            }
            if (!characterState?.isProcessing) {
              window.api.novelCharacter.setState({ chapterParseResult: parsedChapters })
            }
          } catch (e) {
            console.error('Failed to parse chapters for tools:', e)
          }
        }
      } catch (error) {
        console.error('Failed to update novel tools paths:', error)
      }
    })()

    return () => {
      isCancelled = true
    }
  }, [book, content, chapters, isInitialized, compressionState?.isProcessing, characterState?.isProcessing, outlineState?.isProcessing])

  // 获取模型配置的辅助函数
  const getProviderConfigs = useCallback(
    (state: NovelCompressionState | NovelOutlineState | null) => {
      if (!state) return []

      const targetModels: Model[] = []
      if (state.enableMultiModel && state.selectedModels.length > 0) {
        targetModels.push(...state.selectedModels)
      } else if (state.selectedModel) {
        targetModels.push(state.selectedModel)
      }

      if (targetModels.length === 0) {
        return []
      }

      return targetModels.map((model) => {
        const actualProvider = getActualProvider(model)
        if (!actualProvider) {
          throw new Error(`Could not find a valid provider for model: ${model.name}`)
        }
        const config = providerToAiSdkConfig(actualProvider, model)
        return {
          modelId: model.id,
          providerId: config.providerId,
          options: config.options
        }
      })
    },
    []
  )

  // 压缩工具操作
  const compressionActions: ToolActions = useMemo(
    () => ({
      start: (customPrompt?: string, startOptions?: StartOptions) => {
        if (!content || compressionState?.isProcessing) return
        const configs = getProviderConfigs(compressionState)
        if (configs.length === 0) {
          console.error('No models selected for compression.')
          return
        }
        window.api.novelCompress.startCompression(configs, customPrompt, startOptions)
      },
      cancel: () => {
        if (compressionState?.isProcessing) {
          window.api.novelCompress.cancel()
        }
      },
      reset: () => {
        window.api.novelCompress.resetState()
      },
      updateSettings: (settings) => {
        window.api.novelCompress.setState(settings as Partial<NovelCompressionState>)
      }
    }),
    [content, compressionState, getProviderConfigs]
  )

  // 人物志工具操作
  const characterActions: ToolActions = useMemo(
    () => ({
      start: (customPrompt?: string, startOptions?: StartOptions) => {
        if (!content || characterState?.isProcessing) return
        const configs = getProviderConfigs(characterState)
        if (configs.length === 0) {
          console.error('No models selected for character extraction.')
          return
        }
        window.api.novelCharacter.startCompression(configs, customPrompt, startOptions)
      },
      cancel: () => {
        if (characterState?.isProcessing) {
          window.api.novelCharacter.cancel()
        }
      },
      reset: () => {
        window.api.novelCharacter.resetState()
      },
      updateSettings: (settings) => {
        window.api.novelCharacter.setState(settings as Partial<NovelCompressionState>)
      }
    }),
    [content, characterState, getProviderConfigs]
  )

  // 大纲提取工具操作
  const outlineActions: ToolActions = useMemo(
    () => ({
      start: (customPrompt?: string, startOptions?: StartOptions) => {
        if (!content || outlineState?.isProcessing) return
        const configs = getProviderConfigs(outlineState)
        if (configs.length === 0) {
          console.error('No models selected for outline extraction.')
          return
        }
        window.api.novelOutline.startCompression(configs, customPrompt, startOptions)
      },
      cancel: () => {
        if (outlineState?.isProcessing) {
          window.api.novelOutline.cancel()
        }
      },
      reset: () => {
        window.api.novelOutline.resetState()
      },
      updateSettings: (settings) => {
        window.api.novelOutline.setState(settings as Partial<NovelOutlineState>)
      }
    }),
    [content, outlineState, getProviderConfigs]
  )

  // 监听失败自动重试触发事件 - 压缩器
  useEffect(() => {
    const unsubscribe = window.api.novelCompress.onAutoResumeTriggered((data) => {
      console.log(`[失败自动重试][压缩] 收到第${data.attempt}次重试通知（最大${data.maxAttempts}次）`)

      setTimeout(() => {
        const currentState = compressionState
        if (currentState && currentState.enableAutoResume && !currentState.isProcessing) {
          console.log(`[失败自动重试][压缩] 开始第${data.attempt}次重试...`)
          window.toast.info(`失败自动重试（压缩）：第${data.attempt}次重试`)
          compressionActions.start(undefined, { autoRetry: true })
        }
      }, 3000)
    })

    return () => {
      unsubscribe()
    }
  }, [compressionState, compressionActions])

  // 监听失败自动重试触发事件 - 人物志
  useEffect(() => {
    const unsubscribe = window.api.novelCharacter.onAutoResumeTriggered((data) => {
      console.log(`[失败自动重试][人物志] 收到第${data.attempt}次重试通知（最大${data.maxAttempts}次）`)

      setTimeout(() => {
        const currentState = characterState
        if (currentState && currentState.enableAutoResume && !currentState.isProcessing) {
          console.log(`[失败自动重试][人物志] 开始第${data.attempt}次重试...`)
          window.toast.info(`失败自动重试（人物志）：第${data.attempt}次重试`)
          characterActions.start(undefined, { autoRetry: true })
        }
      }, 3000)
    })

    return () => {
      unsubscribe()
    }
  }, [characterState, characterActions])

  // 监听失败自动重试触发事件
  useEffect(() => {
    const unsubscribe = window.api.novelOutline.onAutoResumeTriggered((data) => {
      console.log(`[失败自动重试][大纲] 收到第${data.attempt}次重试通知（最大${data.maxAttempts}次）`)

      setTimeout(() => {
        const currentState = outlineState
        if (currentState && currentState.enableAutoResume && !currentState.isProcessing) {
          console.log(`[失败自动重试][大纲] 开始第${data.attempt}次重试...`)
          window.toast.info(`失败自动重试（大纲）：第${data.attempt}次重试`)
          outlineActions.start(undefined, { autoRetry: true })
        }
      }, 3000)
    })

    return () => {
      unsubscribe()
    }
  }, [outlineState, outlineActions])

  return {
    compressionState,
    characterState,
    outlineState,
    compressionActions,
    characterActions,
    outlineActions,
    isInitialized
  }
}
