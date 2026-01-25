import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type { NovelCompressionState } from '@shared/types'
import { BrowserWindow,ipcMain } from 'electron'

const logger = loggerService.withContext('NovelCompressionMemoryService')

// 性能优化：防抖延迟（毫秒）
const BROADCAST_DEBOUNCE_MS = 50

// 日志条目最大数量限制，防止内存泄漏
const MAX_LOG_ENTRIES = 100

class NovelCompressionMemoryService {
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
      
      // Character Analysis Settings (not used in compression, but required by type)
      characterMode: 'traditional',
      characterOutputFormat: 'markdown',
      targetCharacters: [],
      targetCharacterConfig: null,

      // Chapter-Based Chunking Settings
      chunkMode: 'byChapter',
      chaptersPerChunk: 3,
      chapterParseResult: null,

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
            window.webContents.send(IpcChannel.NovelCompress_StateUpdated, this.state)
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
        window.webContents.send(IpcChannel.NovelCompress_StateUpdated, this.state)
      }
    }
  }

  private registerIpcHandlers() {
    ipcMain.handle(IpcChannel.NovelCompress_GetState, () => {
      logger.info('GetState request received', { hasFile: !!this.state.selectedFile })
      return this.state
    })

    ipcMain.on(
      IpcChannel.NovelCompress_SetState,
      (_, partialState: Partial<NovelCompressionState>) => {
        logger.info('SetState request received', Object.keys(partialState))
        this.state = { ...this.state, ...partialState }
        this.broadcastStateChange()
      }
    )

    ipcMain.on(IpcChannel.NovelCompress_ResetState, () => {
      logger.info('ResetState request received')
      this.state = this.getInitialState()
      this.broadcastStateChange()
    })
  }

  public getState(): NovelCompressionState {
    return this.state
  }

  public updateState(partialState: Partial<NovelCompressionState>) {
    this.state = { ...this.state, ...partialState }

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

export const novelCompressionMemoryService = new NovelCompressionMemoryService()
