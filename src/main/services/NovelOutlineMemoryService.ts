import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type { NovelOutlineState } from '@shared/types'
import { BrowserWindow, ipcMain } from 'electron'

import {
  DEFAULT_CHARACTERS_PROMPT,
  DEFAULT_EXTRACTION_PROMPT,
  DEFAULT_FACTIONS_PROMPT,
  DEFAULT_PROTAGONIST_PROMPT,
  DEFAULT_SYNTHESIS_PROMPT,
  DEFAULT_TECHNIQUES_PROMPT,
  DEFAULT_WORLDVIEW_PROMPT} from './NovelOutlineService'

const logger = loggerService.withContext('NovelOutlineMemoryService')

// 性能优化：防抖延迟（毫秒）
const BROADCAST_DEBOUNCE_MS = 50

// 日志条目最大数量限制，防止内存泄漏
const MAX_LOG_ENTRIES = 100

class NovelOutlineMemoryService {
  private state: NovelOutlineState = this.getInitialState()
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null
  private pendingBroadcast = false

  constructor() {
    this.registerIpcHandlers()
    logger.info('NovelOutlineMemoryService initialized')
  }

  private getInitialState(): NovelOutlineState {
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

      // Prompt Settings - 使用从 NovelOutlineService 导出的默认 prompt
      useCustomPrompts: false,
      customExtractionPrompt: DEFAULT_EXTRACTION_PROMPT,
      customSynthesisPrompt: DEFAULT_SYNTHESIS_PROMPT,
      customWorldviewPrompt: DEFAULT_WORLDVIEW_PROMPT,
      customProtagonistPrompt: DEFAULT_PROTAGONIST_PROMPT,
      customTechniquesPrompt: DEFAULT_TECHNIQUES_PROMPT,
      customFactionsPrompt: DEFAULT_FACTIONS_PROMPT,
      customCharactersPrompt: DEFAULT_CHARACTERS_PROMPT,

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
            window.webContents.send(IpcChannel.NovelOutline_StateUpdated, this.state)
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
        window.webContents.send(IpcChannel.NovelOutline_StateUpdated, this.state)
      }
    }
  }

  private registerIpcHandlers() {
    ipcMain.handle(IpcChannel.NovelOutline_GetState, () => {
      logger.info('GetState request received', { hasFile: !!this.state.selectedFile })
      return this.state
    })

    ipcMain.on(IpcChannel.NovelOutline_SetState, (_, partialState: Partial<NovelOutlineState>) => {
      logger.info('SetState request received', Object.keys(partialState))
      const { resetPrompts, ...rest } = partialState as Partial<NovelOutlineState> & {
        resetPrompts?: boolean
      }

      if (resetPrompts) {
        this.state = {
          ...this.state,
          useCustomPrompts: false,
          customExtractionPrompt: DEFAULT_EXTRACTION_PROMPT,
          customSynthesisPrompt: DEFAULT_SYNTHESIS_PROMPT,
          customWorldviewPrompt: DEFAULT_WORLDVIEW_PROMPT,
          customProtagonistPrompt: DEFAULT_PROTAGONIST_PROMPT,
          customTechniquesPrompt: DEFAULT_TECHNIQUES_PROMPT,
          customFactionsPrompt: DEFAULT_FACTIONS_PROMPT,
          customCharactersPrompt: DEFAULT_CHARACTERS_PROMPT
        }
        this.broadcastStateChange()
        return
      }

      this.state = { ...this.state, ...rest }
      this.broadcastStateChange()
    })

    ipcMain.on(IpcChannel.NovelOutline_ResetState, () => {
      logger.info('ResetState request received')
      this.state = this.getInitialState()
      this.broadcastStateChange()
    })
  }

  public getState(): NovelOutlineState {
    return this.state
  }

  public updateState(partialState: Partial<NovelOutlineState>) {
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

export const novelOutlineMemoryService = new NovelOutlineMemoryService()
