import {
  getActualProvider,
  providerToAiSdkConfig
} from '@renderer/aiCore/provider/providerConfig'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@renderer/types'
import type { NovelOutlineState } from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

const getFallbackState = (): NovelOutlineState => {
  return {
    // Settings
    selectedModel: null,
    selectedModels: [],
    enableMultiModel: false,
    chunkSize: 80000,
    overlap: 5000,
    temperature: 0.4,
    maxConcurrency: 8,
    category: 'novel',

    // Prompt Settings
    useCustomPrompts: false,
    customExtractionPrompt: '',
    customSynthesisPrompt: '',
    customWorldviewPrompt: '',
    customProtagonistPrompt: '',
    customTechniquesPrompt: '',
    customFactionsPrompt: '',
    customCharactersPrompt: '',

    // File & Content
    selectedFile: null,
    preview: '',
    outputPath: '',

    // Process State
    isProcessing: false,
    progress: null,
    logs: [],
    chunkSummaries: [],
    chunkResults: [],
    mergedOutline: null,
    result: null,
    modelHealthStats: null,

    // Resume Logic
    canResume: false,
    chunkInfo: null,
    continueLatestTask: false,

    // Auto Resume
    enableAutoResume: true,
    autoResumeAttempts: 0
  }
}

export function useNovelOutline() {
  const [state, setState] = useState<NovelOutlineState | null>(null)
  const providers = useAppSelector((s) => s.llm.providers)
  const models = useMemo(() => providers.flatMap((p) => p.models), [providers])

  useEffect(() => {
    let isMounted = true

    window.api.novelOutline
      .getState()
      .then((initialState) => {
        if (isMounted) setState(initialState)
      })
      .catch((error) => {
        console.error('[useNovelOutline] Failed to get initial state:', error)
        if (isMounted) {
          setState({
            ...getFallbackState(),
            error: '大纲提取器初始化失败：主进程 IPC 未就绪'
          })
        }
      })

    const unsubscribe = window.api.novelOutline.onStateUpdated((updatedState) => {
      if (isMounted) setState(updatedState)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const updateSettings = useCallback((settings: Partial<NovelOutlineState>) => {
    window.api.novelOutline.setState(settings)
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
        const defaultOutputPath = await window.api.path.join(dir, `${name}.outline${ext}`)

        window.api.novelOutline.setState({
          selectedFile,
          preview: selectedFile.preview,
          outputPath: defaultOutputPath,
          progress: { current: 0, total: 0, percentage: 0, stage: 'idle' },
          logs: [],
          chunkSummaries: [],
          chunkResults: [],
          mergedOutline: null,
          result: null,
          error: undefined,
          modelHealthStats: null,
          canResume: false,
          chunkInfo: null,
          autoResumeAttempts: 0
        })
      } catch (error) {
        console.error('Failed to process selected file:', error)
      }
    }
  }, [])

  const startCompression = useCallback(
    (customPrompt?: string, startOptions?: { autoRetry?: boolean }) => {
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
        console.error('No models selected for outline extraction.')
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

        window.api.novelOutline.startCompression(providerConfigs, customPrompt, startOptions)
      } catch (error) {
        console.error('Failed to prepare provider configurations:', error)
      }
    },
    [state, models, providers]
  )

  const cancelCompression = useCallback(() => {
    if (state?.isProcessing) {
      window.api.novelOutline.cancel()
    }
  }, [state])

  const resetState = useCallback(() => {
    window.api.novelOutline.resetState()
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
