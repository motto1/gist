import { createSlice, PayloadAction } from '@reduxjs/toolkit'

// Workflow types
export type WorkflowType = 'speed-read' | 'character' | 'outline'
export type WorkflowStatus = 'idle' | 'config' | 'processing' | 'complete' | 'error'

export interface WorkflowSession {
  id: string
  type: WorkflowType
  status: WorkflowStatus
  bookId: string
  bookTitle: string
  bookPath: string
  /** 原始输入文本字数（以 JS string.length 计）。用于前端估算“首次总结”耗时与进度。 */
  inputCharCount?: number
  modelId?: string
  modelName?: string
  outputDir?: string
  resultFilePath?: string  // 精确的结果文件路径，用于历史记录读取
  /**
   * 人物志语音相关：用于历史记录显示“生成音频的人物”（单人：姓名；多人：xxx等）。
   * 该字段由磁盘 audio 文件名推导，避免引入额外耦合/存储。
   */
  ttsCharacterLabel?: string
  startedAt: string
  completedAt?: string
  progress?: {
    percentage: number
    stage: string
    current?: number
    total?: number
    /** 阶段开始时间戳（ms），用于恢复时计算已过去的时间以续接进度条 */
    stageStartedAt?: number
  }
}

export interface WorkflowState {
  // Current active sessions for each workflow type
  activeSessions: Record<WorkflowType, WorkflowSession | null>
  // History of completed sessions
  history: WorkflowSession[]
  // Maximum history entries to keep
  maxHistoryEntries: number
}

const initialState: WorkflowState = {
  activeSessions: {
    'speed-read': null,
    'character': null,
    'outline': null
  },
  history: [],
  maxHistoryEntries: 50
}

const workflowSlice = createSlice({
  name: 'workflow',
  initialState,
  reducers: {
    // Start or update a workflow session
    setActiveSession: (state, action: PayloadAction<{ type: WorkflowType; session: WorkflowSession }>) => {
      state.activeSessions[action.payload.type] = action.payload.session
    },

    // Patch meta fields on active session (keep id/type stable)
    updateSessionMeta: (state, action: PayloadAction<{ type: WorkflowType; patch: Partial<WorkflowSession> }>) => {
      const session = state.activeSessions[action.payload.type]
      if (!session) return

      const sessionId = session.id
      Object.assign(session, action.payload.patch)
      session.id = sessionId
      session.type = action.payload.type
    },

    // Update session progress
    updateSessionProgress: (
      state,
      action: PayloadAction<{
        type: WorkflowType
        progress: WorkflowSession['progress']
        status?: WorkflowStatus
      }>
    ) => {
      const session = state.activeSessions[action.payload.type]
      if (session) {
        session.progress = action.payload.progress
        if (action.payload.status) {
          session.status = action.payload.status
        }
      }
    },

    // Update output directory (source of truth for file-based workflows)
    updateSessionOutputDir: (state, action: PayloadAction<{ type: WorkflowType; outputDir: string }>) => {
      const session = state.activeSessions[action.payload.type]
      if (session) {
        session.outputDir = action.payload.outputDir
      }
    },

    // Complete a workflow session and move to history
    // Task is immediately archived to history and cleared from active sessions
    completeSession: (state, action: PayloadAction<{ type: WorkflowType; outputDir?: string; resultFilePath?: string }>) => {
      const session = state.activeSessions[action.payload.type]
      if (session) {
        session.status = 'complete'
        session.completedAt = new Date().toISOString()
        if (action.payload.outputDir) {
          session.outputDir = action.payload.outputDir
        }
        if (action.payload.resultFilePath) {
          session.resultFilePath = action.payload.resultFilePath
        }

        // Add to history (prepend) - create a copy to avoid mutation issues
        state.history.unshift({ ...session })

        // Trim history if needed
        if (state.history.length > state.maxHistoryEntries) {
          state.history = state.history.slice(0, state.maxHistoryEntries)
        }

        // Clear active session - task is now in history
        // Users can access completed results via history with sessionId parameter
        state.activeSessions[action.payload.type] = null
      }
    },

    // Explicitly clear a completed session (called when user starts a new task)
    clearCompletedSession: (state, action: PayloadAction<WorkflowType>) => {
      const session = state.activeSessions[action.payload]
      if (session?.status === 'complete') {
        state.activeSessions[action.payload] = null
      }
    },

    // Clear active session without saving to history
    clearActiveSession: (state, action: PayloadAction<WorkflowType>) => {
      state.activeSessions[action.payload] = null
    },

    // Remove a history entry
    removeHistoryEntry: (state, action: PayloadAction<string>) => {
      state.history = state.history.filter((s) => s.id !== action.payload)
    },

    // Clear all history
    clearHistory: (state) => {
      state.history = []
    }
  }
})

export const {
  setActiveSession,
  updateSessionMeta,
  updateSessionProgress,
  updateSessionOutputDir,
  completeSession,
  clearCompletedSession,
  clearActiveSession,
  removeHistoryEntry,
  clearHistory
} = workflowSlice.actions

export default workflowSlice.reducer
