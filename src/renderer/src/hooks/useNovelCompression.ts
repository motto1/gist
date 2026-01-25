import {
  getActualProvider,
  providerToAiSdkConfig
} from '@renderer/aiCore/provider/providerConfig'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@renderer/types'
import type { NovelCompressionState } from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'


export function useNovelCompression() {
  const [state, setState] = useState<NovelCompressionState | null>(null)
  const providers = useAppSelector((s) => s.llm.providers)
  const models = useMemo(() => providers.flatMap((p) => p.models), [providers])

  useEffect(() => {
    let isMounted = true

    // Get initial state
    window.api.novelCompress.getState().then((initialState) => {
      if (isMounted) {
        setState(initialState)
      }
    })

    // Listen for state updates from main process
    const unsubscribe = window.api.novelCompress.onStateUpdated((updatedState) => {
      if (isMounted) {
        setState(updatedState)
      }
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  // Actions that modify the state in the main process
  const updateSettings = useCallback((settings: Partial<NovelCompressionState>) => {
    window.api.novelCompress.setState(settings)
  }, [])

  const selectFile = useCallback(async () => {
    const files = await window.api.file.select({
      title: '选择小说文件',
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })

    if (files && files.length > 0) {
      const selectedFile = files[0]
      try {
        const { name, ext } = await window.api.path.parse(selectedFile.path)
        const dir = await window.api.path.dirname(selectedFile.path)
        const defaultOutputPath = await window.api.path.join(dir, `${name}.compressed${ext}`)

        // Update the main process state. It will broadcast the change back to us.
        // The selectedFile object from the main process now contains charLength and preview.
        window.api.novelCompress.setState({
          selectedFile: selectedFile,
          preview: selectedFile.preview,
          outputPath: defaultOutputPath,
          // Reset progress when a new file is selected
          progress: { current: 0, total: 0, percentage: 0, stage: 'idle' },
          logs: [],
          chunkSummaries: [],
          result: null,
          debugInfo: null
        })

        // 自动触发章节识别（使用文件路径读取内容）
        try {
          // 使用 readExternal 读取外部文件路径，启用编码检测
          const fileContent = await window.api.file.readExternal(selectedFile.path, true)
          if (fileContent && typeof fileContent === 'string') {
            const chapterParseResult = await window.api.novelCompress.parseChapters(fileContent)
            window.api.novelCompress.setState({ chapterParseResult })
          } else {
            console.error('Failed to read file content or content is not a string')
            window.api.novelCompress.setState({
              chapterParseResult: {
                success: false,
                totalChapters: 0,
                chapters: [],
                usedRule: '',
                error: '无法读取文件内容'
              }
            })
          }
        } catch (parseError) {
          console.error('Failed to parse chapters:', parseError)
          window.api.novelCompress.setState({
            chapterParseResult: {
              success: false,
              totalChapters: 0,
              chapters: [],
              usedRule: '',
              error: '章节识别失败'
            }
          })
        }
      } catch (error) {
        console.error('Failed to process selected file:', error)
        // Optionally, notify the user of the error
      }
    }
  }, [])

  const startCompression = useCallback((customPrompt?: string, startOptions?: { autoRetry?: boolean }) => {
    if ((!state?.selectedFile && !state?.inputText) || state.isProcessing) {
      return
    }

    const targetModels: Model[] = []
    if (state.enableMultiModel && state.selectedModels.length > 0) {
      targetModels.push(...state.selectedModels)
    } else if (state.selectedModel) {
      targetModels.push(state.selectedModel)
    }

    if (targetModels.length === 0) {
      console.error('No models selected for compression.')
      return
    }

    try {
      const providerConfigs = targetModels.map((model) => {
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

      window.api.novelCompress.startCompression(providerConfigs, customPrompt, startOptions)
    } catch (error) {
      console.error('Failed to prepare provider configurations:', error)
      // Optionally, update the state to show an error message to the user
    }
  }, [state, models, providers])

  const cancelCompression = useCallback(() => {
    if (state?.isProcessing) {
      window.api.novelCompress.cancel()
    }
  }, [state])

  const resetState = useCallback(() => {
    window.api.novelCompress.resetState()
  }, [])

  return {
    state,
    actions: {
      updateSettings,
      selectFile,
      startCompression,
      cancelCompression,
      resetState
    }
  }
}