import {
  getActualProvider,
  providerToAiSdkConfig
} from '@renderer/aiCore/provider/providerConfig'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@renderer/types'
import type { NovelCompressionState } from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

// 状态验证和清理工具函数
const validateStateConsistency = (state: NovelCompressionState): { valid: boolean; warnings: string[] } => {
  const warnings: string[] = []
  
  // 检查指定人物模式和矩阵模式的状态一致性
  if (state.targetCharacterConfig?.enabled && state.characterMode === 'matrix') {
    // 指定人物模式启用时，应该有人物列表
    if (!state.targetCharacterConfig.characters || state.targetCharacterConfig.characters.length === 0) {
      warnings.push('指定人物模式已启用但未设置人物列表')
    }
  }
  
  // 检查结果状态与模式的一致性
  if (state.result?.merged && state.targetCharacterConfig?.enabled) {
    // 指定人物模式的结果应该包含指定的人物
    const configuredCharacters = state.targetCharacterConfig.characters || []
    if (configuredCharacters.length > 0 && !state.result.merged.includes(configuredCharacters[0])) {
      warnings.push('处理结果与指定人物配置不匹配')
    }
  }
  
  // 检查处理状态的一致性
  if (state.isProcessing && !state.selectedFile && !state.inputText) {
    warnings.push('处理状态异常：正在处理但未选择文件或输入文本')
  }
  
  return {
    valid: warnings.length === 0,
    warnings
  }
}

const cleanupModeState = (currentState: NovelCompressionState, newMode: 'matrix' | 'specific'): Partial<NovelCompressionState> => {
  const cleanupState: Partial<NovelCompressionState> = {}
  
  if (newMode === 'matrix') {
    // 切换到矩阵模式时，清理指定人物模式的状态
    cleanupState.targetCharacterConfig = null
    cleanupState.result = null
    cleanupState.chunkSummaries = []
    cleanupState.logs = []
    cleanupState.mergedContent = ''
  } else if (newMode === 'specific') {
    // 切换到指定人物模式时，清理矩阵模式的状态
    cleanupState.result = null
    cleanupState.chunkSummaries = []
    cleanupState.logs = []
    cleanupState.mergedContent = ''
    // 确保指定人物配置存在
    if (!currentState.targetCharacterConfig) {
      cleanupState.targetCharacterConfig = {
        enabled: true,
        characters: []
      }
    }
  }
  
  // 通用清理：重置处理状态
  cleanupState.isProcessing = false
  cleanupState.canResume = false
  cleanupState.progress = { current: 0, total: 0, percentage: 0, stage: 'idle' }
  cleanupState.debugInfo = null
  cleanupState.modelHealthStats = null
  cleanupState.chunkInfo = null
  
  return cleanupState
}

const resetAllModeStates = (): Partial<NovelCompressionState> => {
  return {
    // 清理指定人物模式状态
    targetCharacterConfig: null,
    // 重置为默认矩阵模式
    characterMode: 'matrix',
    // 清理处理结果
    result: null,
    // 清理处理过程状态
    chunkSummaries: [],
    logs: [],
    mergedContent: '',
    // 重置处理状态
    isProcessing: false,
    canResume: false,
    progress: { current: 0, total: 0, percentage: 0, stage: 'idle' },
    debugInfo: null,
    modelHealthStats: null,
    chunkInfo: null
  }
}


export function useNovelCharacter() {
  const [state, setState] = useState<NovelCompressionState | null>(null)
  const providers = useAppSelector((s) => s.llm.providers)
  const models = useMemo(() => providers.flatMap((p) => p.models), [providers])

  useEffect(() => {
    let isMounted = true

    // Get initial state
    window.api.novelCharacter.getState().then((initialState) => {
      if (isMounted) {
        setState(initialState)
      }
    })

    // Listen for state updates from main process
    const unsubscribe = window.api.novelCharacter.onStateUpdated((updatedState) => {
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
    // 在更新设置前进行状态验证和清理
    if (state) {
      let cleanedSettings = { ...settings }
      
      // 如果正在切换模式，进行状态清理
      if (settings.targetCharacterConfig !== undefined) {
        const isEnablingSpecificMode = settings.targetCharacterConfig?.enabled === true
        const isDisablingSpecificMode = settings.targetCharacterConfig === null || settings.targetCharacterConfig?.enabled === false
        
        if (isEnablingSpecificMode && !state.targetCharacterConfig?.enabled) {
          // 切换到指定人物模式
          const cleanupState = cleanupModeState(state, 'specific')
          cleanedSettings = { ...cleanedSettings, ...cleanupState }
        } else if (isDisablingSpecificMode && state.targetCharacterConfig?.enabled) {
          // 切换到矩阵模式
          const cleanupState = cleanupModeState(state, 'matrix')
          cleanedSettings = { ...cleanedSettings, ...cleanupState }
        }
      }
      
      window.api.novelCharacter.setState(cleanedSettings)
      
      // 在开发环境下验证状态一致性
      if (process.env.NODE_ENV === 'development') {
        setTimeout(() => {
          window.api.novelCharacter.getState().then((newState) => {
            const validation = validateStateConsistency(newState)
            if (!validation.valid) {
              console.warn('状态一致性警告:', validation.warnings)
            }
          })
        }, 100)
      }
    } else {
      window.api.novelCharacter.setState(settings)
    }
  }, [state])

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

        // 使用状态重置工具函数，确保完整清理所有模式状态
        const resetState = resetAllModeStates()
        
        // Update the main process state. It will broadcast the change back to us.
        // The selectedFile object from the main process now contains charLength and preview.
        window.api.novelCharacter.setState({
          selectedFile: selectedFile,
          preview: selectedFile.preview,
          outputPath: defaultOutputPath,
          ...resetState
        })

        // 若当前为章节分块模式，选择文件后自动识别章节（避免 chapterParseResult 使用上一次文件的结果）
        try {
          const currentState = await window.api.novelCharacter.getState()
          if ((currentState.chunkMode || 'bySize') === 'byChapter') {
            const chapterParseResult = await window.api.novelCharacter.parseChapters(selectedFile.path)
            window.api.novelCharacter.setState({ chapterParseResult })
          } else {
            window.api.novelCharacter.setState({ chapterParseResult: null })
          }
        } catch (parseError) {
          console.error('Failed to parse chapters:', parseError)
          window.api.novelCharacter.setState({
            chapterParseResult: {
              success: false,
              totalChapters: 0,
              chapters: [],
              usedRule: '',
              error: '章节识别失败'
            }
          })
        }
        
        // 在开发环境下验证状态一致性
        if (process.env.NODE_ENV === 'development') {
          setTimeout(() => {
            window.api.novelCharacter.getState().then((newState) => {
              const validation = validateStateConsistency(newState)
              if (!validation.valid) {
                console.warn('状态一致性警告:', validation.warnings)
              }
            })
          }, 100)
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

      window.api.novelCharacter.startCompression(providerConfigs, customPrompt, startOptions)
    } catch (error) {
      console.error('Failed to prepare provider configurations:', error)
      // Optionally, update the state to show an error message to the user
    }
  }, [state, models, providers])

  const cancelCompression = useCallback(() => {
    if (state?.isProcessing) {
      window.api.novelCharacter.cancel()
    }
  }, [state])

  const resetState = useCallback(() => {
    window.api.novelCharacter.resetState()
  }, [])

  // 解析章节 - 任务 10.1
  const parseChapters = useCallback(async () => {
    if (!state?.selectedFile?.path) {
      console.error('No file selected for chapter parsing')
      return null
    }

    try {
      const result = await window.api.novelCharacter.parseChapters(state.selectedFile.path)
      
      // 更新状态中的章节解析结果
      window.api.novelCharacter.setState({
        chapterParseResult: result
      })
      
      return result
    } catch (error) {
      console.error('Failed to parse chapters:', error)
      return null
    }
  }, [state?.selectedFile?.path])

  // 切换分块模式
  const setChunkMode = useCallback((mode: 'bySize' | 'byChapter') => {
    window.api.novelCharacter.setState({
      chunkMode: mode,
      // 切换模式时清理相关状态
      chapterParseResult: mode === 'bySize' ? null : state?.chapterParseResult
    })
    
    // 如果切换到章节模式且有文件，自动解析章节
    if (mode === 'byChapter' && state?.selectedFile?.path) {
      window.api.novelCharacter.parseChapters(state.selectedFile.path).then((result) => {
        window.api.novelCharacter.setState({
          chapterParseResult: result
        })
      })
    }
  }, [state?.selectedFile?.path, state?.chapterParseResult])

  // 设置每块章节数
  const setChaptersPerChunk = useCallback((count: number) => {
    window.api.novelCharacter.setState({
      chaptersPerChunk: Math.max(1, Math.floor(count))
    })
  }, [])

  return {
    state,
    actions: {
      updateSettings,
      selectFile,
      startCompression,
      cancelCompression,
      resetState,
      parseChapters,
      setChunkMode,
      setChaptersPerChunk
    }
  }
}