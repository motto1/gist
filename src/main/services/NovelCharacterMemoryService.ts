import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type { NovelCompressionState } from '@shared/types'
import { BrowserWindow,ipcMain } from 'electron'

const logger = loggerService.withContext('NovelCharacterMemoryService')

// 性能优化：防抖延迟（毫秒）
const BROADCAST_DEBOUNCE_MS = 50

// 日志条目最大数量限制，防止内存泄漏
const MAX_LOG_ENTRIES = 100

// 状态一致性检查函数
const validateStateConsistency = (state: NovelCompressionState): { valid: boolean; errors: string[] } => {
  const errors: string[] = []
  
  // 检查指定人物模式的状态一致性
  if (state.targetCharacterConfig?.enabled) {
    // 指定人物模式启用时必须有人物列表
    if (!state.targetCharacterConfig.characters || state.targetCharacterConfig.characters.length === 0) {
      errors.push('指定人物模式已启用但人物列表为空')
    }
    
    // 指定人物模式启用时，characterMode应该保持一致
    if (state.characterMode !== 'matrix') {
      // 这里不强制要求，但记录警告
      logger.warn('指定人物模式启用时characterMode不是matrix，可能存在状态不一致')
    }
  }
  
  // 检查处理状态的逻辑一致性
  if (state.isProcessing) {
    if (!state.selectedFile && !state.inputText) {
      errors.push('处理状态为true但未选择文件或输入文本')
    }
    
    if (!state.progress || state.progress.stage === 'idle') {
      errors.push('处理状态为true但进度状态为idle')
    }
  }
  
  // 检查结果状态的一致性
  if (state.result?.merged && state.isProcessing) {
    errors.push('已有处理结果但处理状态仍为true')
  }
  
  // 检查恢复状态的一致性
  if (state.canResume && !state.chunkInfo) {
    errors.push('可恢复状态为true但缺少chunk信息')
  }
  
  return {
    valid: errors.length === 0,
    errors
  }
}

// 状态清理函数
const sanitizeState = (state: NovelCompressionState): NovelCompressionState => {
  const sanitized = { ...state }
  
  // 如果指定人物模式被禁用，清理相关状态
  if (!state.targetCharacterConfig?.enabled) {
    sanitized.targetCharacterConfig = null
  }
  
  // 如果没有选择文件，清理文件相关状态
  if (!state.selectedFile && !state.inputText) {
    sanitized.preview = ''
    sanitized.outputPath = ''
    sanitized.isProcessing = false
    sanitized.progress = null
    sanitized.result = null
    sanitized.canResume = false
    sanitized.chunkInfo = null
  }
  
  // 如果不在处理中，清理处理相关状态
  if (!state.isProcessing) {
    sanitized.modelHealthStats = null
    if (sanitized.progress?.stage !== 'completed' && sanitized.progress?.stage !== 'failed') {
      sanitized.progress = null
    }
  }
  
  return sanitized
}

class NovelCharacterMemoryService {
  private state: NovelCompressionState = this.getInitialState()
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null
  private pendingBroadcast = false

  constructor() {
    this.registerIpcHandlers()
    logger.info('NovelCompressionMemoryService initialized')
  }

  private getInitialState(): NovelCompressionState {
    return {
      // Settings
      selectedModel: null,
      selectedModels: [],
      enableMultiModel: false,
      ratioPercent: 3,
      chunkSize: 80000,
      overlap: 5000,
      temperature: 0.4,
      maxConcurrency: 8,  // 每个模型的最大并发数
      category: 'novel',
      enableAutoClassification: false,
      
      // Character Analysis Settings
      characterMode: 'matrix',
      characterOutputFormat: 'csv',
      targetCharacters: [],
      targetCharacterConfig: null,  // 指定人物配置

      // Chapter-Based Chunking Settings (章节分块设置)
      chunkMode: 'byChapter',         // 分块模式：'bySize' | 'byChapter'
      chaptersPerChunk: 3,            // 每块包含的章节数（默认3）
      chapterParseResult: null,       // 章节识别结果

      // File & Content
      selectedFile: null,
      preview: '',
      outputPath: '',
      mergedContent: '',

      // Process State
      isProcessing: false,
      progress: null,
      result: null,
      logs: [],
      chunkSummaries: [],
      debugInfo: null,
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

  private broadcastStateChange() {
    // 性能优化：使用防抖机制减少广播频率
    this.pendingBroadcast = true

    if (this.broadcastTimer) {
      return // 已有定时器在等待，跳过
    }

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      if (this.pendingBroadcast) {
        this.pendingBroadcast = false
        const windows = BrowserWindow.getAllWindows()
        logger.debug(`Broadcasting state change to ${windows.length} windows.`)
        for (const window of windows) {
          if (!window.isDestroyed() && window.webContents) {
            window.webContents.send(IpcChannel.NovelCharacter_StateUpdated, this.state)
          }
        }
      }
    }, BROADCAST_DEBOUNCE_MS)
  }

  /**
   * 立即广播状态变更，不经过防抖（用于关键状态如 isProcessing 变化）
   */
  private broadcastStateChangeImmediate() {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    this.pendingBroadcast = false
    const windows = BrowserWindow.getAllWindows()
    logger.debug(`Broadcasting state change immediately to ${windows.length} windows.`)
    for (const window of windows) {
      if (!window.isDestroyed() && window.webContents) {
        window.webContents.send(IpcChannel.NovelCharacter_StateUpdated, this.state)
      }
    }
  }

  private registerIpcHandlers() {
    ipcMain.handle(IpcChannel.NovelCharacter_GetState, () => {
      logger.info('GetState request received', { hasFile: !!this.state.selectedFile })
      return this.state
    })

    ipcMain.on(
      IpcChannel.NovelCharacter_SetState,
      (_, partialState: Partial<NovelCompressionState>) => {
        logger.info('SetState request received', Object.keys(partialState))
        
        // 合并状态
        const newState = { ...this.state, ...partialState }
        
        // 进行状态清理和一致性检查
        const sanitizedState = sanitizeState(newState)
        const validation = validateStateConsistency(sanitizedState)
        
        if (!validation.valid) {
          logger.warn('状态一致性检查失败:', validation.errors)
          // 在开发环境下，可以选择抛出错误或记录详细日志
          if (process.env.NODE_ENV === 'development') {
            console.warn('状态一致性问题:', validation.errors)
          }
        }
        
        this.state = sanitizedState
        this.broadcastStateChange()
      }
    )

    ipcMain.on(IpcChannel.NovelCharacter_ResetState, () => {
      logger.info('ResetState request received')
      this.state = this.getInitialState()
      this.broadcastStateChange()
    })
  }

  public getState(): NovelCompressionState {
    return this.state
  }

  public updateState(partialState: Partial<NovelCompressionState>) {
    // 合并状态
    const newState = { ...this.state, ...partialState }

    // 进行状态清理和一致性检查
    const sanitizedState = sanitizeState(newState)
    const validation = validateStateConsistency(sanitizedState)

    if (!validation.valid) {
      logger.warn('状态一致性检查失败:', validation.errors)
    }

    this.state = sanitizedState

    // 自动限制日志条目数量，防止内存泄漏
    if (this.state.logs && this.state.logs.length > MAX_LOG_ENTRIES) {
      this.state.logs = this.state.logs.slice(-MAX_LOG_ENTRIES)
    }

    // 关键状态变化立即广播，其他状态使用防抖
    // result 也需要立即广播，确保任务完成时前端能及时获取结果
    if ('isProcessing' in partialState || 'progress' in partialState || 'result' in partialState) {
      this.broadcastStateChangeImmediate()
    } else {
      this.broadcastStateChange()
    }
  }

  public resetState() {
    this.state = this.getInitialState()
    this.broadcastStateChangeImmediate()
  }
}

export const novelCharacterMemoryService = new NovelCharacterMemoryService()
