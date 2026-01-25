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
  modelId?: string
  modelName?: string
  outputDir?: string
  resultFilePath?: string  // 精确的结果文件路径，用于历史记录读取
  startedAt: string
  completedAt?: string
  progress?: {
    percentage: number
    stage: string
    current?: number
    total?: number
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
  updateSessionProgress,
  updateSessionOutputDir,
  completeSession,
  clearCompletedSession,
  clearActiveSession,
  removeHistoryEntry,
  clearHistory
} = workflowSlice.actions

export default workflowSlice.reducer
