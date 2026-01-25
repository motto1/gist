import { Button, Card, CardBody, Tooltip } from '@heroui/react'
import {
  getActualProvider,
  providerToAiSdkConfig
} from '@renderer/aiCore/provider/providerConfig'
import { TextReaderMarkdown } from '@renderer/pages/textReader/components/TextReaderMarkdown'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { clearActiveSession, clearCompletedSession, completeSession, setActiveSession, updateSessionProgress } from '@renderer/store/workflow'
import type { Model } from '@shared/types'
import { ArrowLeft, ArrowRight, FolderOpen, Loader2 } from 'lucide-react'
import { FC, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { useSearchParams } from 'react-router-dom'
import remarkGfm from 'remark-gfm'

import DragBar from './components/DragBar'
import FullscreenResultViewer from './components/FullscreenResultViewer'
import ModelSelector from './components/ModelSelector'
import NovelPicker, { SelectedFile } from './components/NovelPicker'
import ProgressDisplay from './components/ProgressDisplay'
import WorkflowStepMotion from './components/WorkflowStepMotion'

type WorkflowStep = 'config' | 'processing' | 'complete'

interface ProcessingState {
  stage: string
  percentage: number
  current?: number
  total?: number
}

// --- Reusable UI Components (match CharacterWorkflow) ---

const WorkflowLayout: FC<{ children: ReactNode; nav?: ReactNode; className?: string }> = ({ children, nav, className }) => (
  <div className={`flex flex-col h-full w-full bg-background relative group ${className || ''}`}>
    <div className="flex-1 flex flex-col items-center overflow-y-auto px-6 md:px-20 lg:px-32 py-12">
      <div className="w-full max-w-4xl space-y-10 my-auto pb-20">
        {children}
      </div>
    </div>
    {nav}
  </div>
)

const StepHeader: FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="text-center space-y-6">
    <h1 className="text-4xl font-serif font-medium text-foreground">
      {title}
    </h1>
    {hint && (
      <p className="text-lg text-foreground/60 font-serif">
        {hint}
      </p>
    )}
  </div>
)

const GlassContainer: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
  <div className={`p-8 bg-content2/30 rounded-3xl border border-white/5 backdrop-blur-sm ${className || ''}`}>
    {children}
  </div>
)

const CircularNavButton: FC<{
  direction: 'left' | 'right'
  onPress: () => void
  isDisabled?: boolean
  isLoading?: boolean
  tooltip: string
  icon?: ReactNode
  color?: 'primary' | 'light'
}> = ({ direction, onPress, isDisabled, isLoading, tooltip, icon, color = 'light' }) => (
  <Tooltip content={tooltip} placement={direction === 'left' ? 'right' : 'left'}>
    <Button
      isIconOnly
      radius="full"
      variant={color === 'light' ? 'light' : 'solid'}
      color={color === 'primary' ? 'primary' : 'default'}
      size="lg"
      className={`absolute ${direction === 'left' ? 'left-10' : 'right-10'} top-1/2 -translate-y-1/2 h-16 w-16 z-50 ${
        color === 'light'
          ? 'text-foreground/50 hover:text-foreground hover:bg-content2/50'
          : 'shadow-xl bg-foreground text-background hover:bg-foreground/90'
      } transition-all hover:scale-105`}
      onPress={onPress}
      isDisabled={isDisabled}
      isLoading={isLoading}
    >
      {!isLoading && (icon || (direction === 'left' ? <ArrowLeft size={28} /> : <ArrowRight size={28} />))}
    </Button>
  </Tooltip>
)

const OutlineWorkflow: FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [searchParams] = useSearchParams()

  // Redux state
  const activeSession = useAppSelector((state) => state.workflow.activeSessions['outline'])
  const history = useAppSelector((state) => state.workflow.history)

  // Get session id from URL params (for viewing history results)
  const historySessionId = searchParams.get('sessionId')
  const historyOutputDir = searchParams.get('outputDir')

  // Local state
  const [step, setStep] = useState<WorkflowStep>('config')
  const [selectedModel, setSelectedModel] = useState<Model | null>(null)
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
  const [progress, setProgress] = useState<ProcessingState>({ stage: 'initializing', percentage: 0 })
  const [result, setResult] = useState<string | null>(null)
  const [outputDir, setOutputDir] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(true)
  const [historyBookTitle, setHistoryBookTitle] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)  // 防重复提交

  const [stepDirection, setStepDirection] = useState<-1 | 0 | 1>(0)
  const prevStepRef = useRef<WorkflowStep>('config')

  // Check if can start
  const canStart = selectedModel !== null && selectedFile !== null

  // 追踪是否已完成首次恢复
  const hasRestoredRef = useRef(false)
  // 追踪上一次的 historySessionId
  const prevHistorySessionIdRef = useRef(historySessionId)

  // Restore state from main process on mount or from history
  // 注意：只在组件首次挂载或 historySessionId 变化时执行
  useEffect(() => {
    // 检查是否需要执行恢复
    const historySessionIdChanged = prevHistorySessionIdRef.current !== historySessionId
    prevHistorySessionIdRef.current = historySessionId

    // 如果不是首次挂载，也不是 historySessionId 变化，跳过
    if (hasRestoredRef.current && !historySessionIdChanged) {
      console.log('[OutlineWorkflow] Skipping restore - already restored and no historySessionId change')
      return
    }

    console.log('[OutlineWorkflow] Running restore logic, historySessionIdChanged:', historySessionIdChanged)

    // Reset state when historySessionId changes to prevent showing stale data
    setStep('config')
    setResult(null)
    setOutputDir(null)
    setHistoryBookTitle(null)
    setProgress({ stage: 'initializing', percentage: 0 })
    setIsRestoring(true)

    const findResultFile = async (dir: string): Promise<string | null> => {
      try {
        console.log('[OutlineWorkflow] findResultFile searching in:', dir)
        const entries = await window.api.fs.readdir(dir)
        console.log('[OutlineWorkflow] readdir entries:', entries?.map(e => ({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory })))
        if (!entries || entries.length === 0) return null

        // Filter to only files (exclude directories)
        const files = entries.filter((f) => f.isFile === true)
        console.log('[OutlineWorkflow] filtered files:', files?.map(f => f.name))

        // Priority order for outline result files
        // 1. merged_outline.md - primary output
        const mergedOutline = files.find((f) => f.name?.toLowerCase() === 'merged_outline.md')
        if (mergedOutline) {
          return mergedOutline.path
        }
        // 2. final.md
        const finalFile = files.find((f) => f.name?.toLowerCase() === 'final.md')
        if (finalFile) {
          return finalFile.path
        }
        // 3. Any file containing 'outline'
        const outlineFile = files.find((f) => f.name?.toLowerCase().includes('outline'))
        if (outlineFile) {
          return outlineFile.path
        }
        // 4. Any .md file
        const mdFile = files.find((f) => f.name?.toLowerCase().endsWith('.md'))
        if (mdFile) {
          return mdFile.path
        }
        // 5. Any .txt file
        const txtFile = files.find((f) => f.name?.toLowerCase().endsWith('.txt'))
        if (txtFile) {
          return txtFile.path
        }

        // If no files in root, check subdirectories
        if (files.length === 0) {
          for (const entry of entries) {
            if (entry.isDirectory) {
              const subEntries = await window.api.fs.readdir(entry.path)
              const subFiles = subEntries?.filter((f) => f.isFile === true) || []
              // Look for merged_outline.md or final.md in subdirectories
              const subMerged = subFiles.find((f) => f.name?.toLowerCase() === 'merged_outline.md')
              if (subMerged) return subMerged.path
              const subFinal = subFiles.find((f) => f.name?.toLowerCase() === 'final.md')
              if (subFinal) return subFinal.path
            }
          }
        }

        return null
      } catch (err) {
        console.error('[OutlineWorkflow] findResultFile error:', err)
        return null
      }
    }

    const restoreState = async () => {
      try {
        console.log('[OutlineWorkflow] Restoring state, historySessionId:', historySessionId, 'history length:', history.length)

        // Prefer file-based history navigation (outputDir is the source of truth)
        if (historyOutputDir) {
          const resultFilePath = await findResultFile(historyOutputDir)
          console.log('[OutlineWorkflow] Result file path (outputDir):', resultFilePath)
          if (resultFilePath) {
            const content = await window.api.fs.readText(resultFilePath)
            if (content) {
              setResult(content)
            }
          }
          const parts = historyOutputDir.split(/[/\\]/).filter(Boolean)
          const markerIndex = parts.lastIndexOf('outline')
          const guessedBookTitle = markerIndex > 0 ? parts[markerIndex - 1] : null
          setStep('complete')
          setOutputDir(historyOutputDir)
          setHistoryBookTitle(guessedBookTitle)
          setIsRestoring(false)
          return
        }

        // Check if viewing history result
        if (historySessionId) {
          // Find session in history with matching id AND type
          const historySession = history.find((s) => s.id === historySessionId && s.type === 'outline')
          console.log('[OutlineWorkflow] Found history session:', historySession)

          if (historySession && historySession.outputDir) {
            // Try to read result from file
            const resultFilePath = await findResultFile(historySession.outputDir)
            console.log('[OutlineWorkflow] Result file path:', resultFilePath)

            if (resultFilePath) {
              const content = await window.api.fs.readText(resultFilePath)
              if (content) {
                console.log('[OutlineWorkflow] Loaded result content, length:', content.length)
                setResult(content)
                setStep('complete')
                setOutputDir(historySession.outputDir)
                setHistoryBookTitle(historySession.bookTitle)
                setIsRestoring(false)
                return
              }
            }
            // Even if file not found, still show complete state with no result
            console.log('[OutlineWorkflow] File not found, showing complete state anyway')
            setStep('complete')
            setOutputDir(historySession.outputDir)
            setHistoryBookTitle(historySession.bookTitle)
            setIsRestoring(false)
            return
          }
        }

        const state = await window.api.novelOutline.getState()
        console.log('[OutlineWorkflow] Restore state from main process:', {
          isProcessing: state?.isProcessing,
          progress: state?.progress,
          hasResult: !!state?.result?.final
        })

        if (state?.isProcessing) {
          // Task is running - restore to processing step
          setStep('processing')
          if (state.outputPath) {
            setOutputDir(state.outputPath)
          }
          if (state.progress) {
            setProgress({
              stage: state.progress.stage,
              percentage: state.progress.percentage,
              current: state.progress.current,
              total: state.progress.total
            })
          }
          if (state.selectedFile) {
            setSelectedFile(state.selectedFile as SelectedFile)
          }
          if (state.selectedModel) {
            setSelectedModel(state.selectedModel)
          }
        } else if (activeSession) {
          // 注意：不再从主进程恢复已完成的结果（state?.result?.final）
          // 从主页进入时用户期望开始新任务，不应显示旧结果
          // 旧结果可通过历史记录（带 sessionId 参数）访问
          // Restore from Redux session if main process doesn't have active state
          if (activeSession.status === 'processing') {
            setStep('processing')
            setOutputDir(activeSession.outputDir || null)
            if (activeSession.progress) {
              setProgress(activeSession.progress)
            }
          } else if (activeSession.status === 'complete') {
            // Task completed but main process doesn't have result - try to load from file
            console.log('[OutlineWorkflow] Restoring completed task from Redux session')
            setStep('complete')
            setOutputDir(activeSession.outputDir || null)

            // 修复：主动归档到历史记录，防止任务卡在"进行中"状态
            // 检测到 Redux 中任务已完成但仍在 activeSessions 中，需要立即归档
            dispatch(completeSession({
              type: 'outline',
              outputDir: activeSession.outputDir || undefined
            }))

            if (activeSession.outputDir) {
              const resultFilePath = await findResultFile(activeSession.outputDir)
              if (resultFilePath) {
                const content = await window.api.fs.readText(resultFilePath)
                if (content) {
                  setResult(content)
                }
              }
            }
          }
        }
        // Note: Don't restore completed state from main process when entering from launcher
        // User wants to start a new task, not view old results
        // Old results can be accessed via history with sessionId parameter
      } catch (error) {
        console.error('Failed to restore state:', error)
      } finally {
        hasRestoredRef.current = true  // 标记已完成恢复
        setIsRestoring(false)
      }
    }

    restoreState()
  }, [historySessionId, historyOutputDir]) // 仅在路由参数变化时恢复

  // Open task directory
  const handleOpenTaskDir = useCallback(() => {
    if (outputDir) {
      window.api.file.openPath(outputDir)
    }
  }, [outputDir])

  // Handle start processing
  const handleStart = useCallback(async () => {
    if (!canStart || !selectedModel || !selectedFile || isStarting) return

    setIsStarting(true)  // 防重复提交
    try {
      // 重置本地状态，防止显示旧任务的结果
      setResult(null)
      setProgress({ stage: 'initializing', percentage: 0 })
      setMainProcessState(null)
      taskStartTimeRef.current = Date.now()

      // Clear any previously completed session before starting new task
      dispatch(clearCompletedSession('outline'))
      // Convert model to provider config
      const actualProvider = getActualProvider(selectedModel)
      if (!actualProvider) {
        console.error('Could not find provider for model:', selectedModel.name)
        return
      }
      const config = providerToAiSdkConfig(actualProvider, selectedModel)
      const providerConfigs = [{
        modelId: selectedModel.id,
        providerId: config.providerId,
        options: config.options
      }]

      // Determine output path - all files are now library books
      // Library book structure: {bookFolder}/content.txt
      if (!selectedFile.path) {
        console.error('No file path available')
        return
      }

      // Get book folder (parent of content.txt)
      const bookDir = await window.api.path.dirname(selectedFile.path)

      // Ensure outline directory exists
      const outlineDir = await window.api.path.join(bookDir, 'outline')
      await window.api.file.mkdir(outlineDir)

      // Save output directory for later use
      setOutputDir(outlineDir)

      // Save session to Redux
      const sessionId = crypto.randomUUID()
      dispatch(setActiveSession({
        type: 'outline',
        session: {
          id: sessionId,
          type: 'outline',
          status: 'processing',
          bookId: selectedFile.id,
          bookTitle: selectedFile.origin_name || selectedFile.name || '未命名',
          bookPath: selectedFile.path,
          modelId: selectedModel.id,
          modelName: selectedModel.name,
          outputDir: outlineDir,
          startedAt: new Date().toISOString(),
          progress: { percentage: 0, stage: 'initializing' }
        }
      }))

      // Reset state first to clear any previous completed state, then set new task config
      // This ensures we start fresh and don't carry over old progress/result
      await window.api.novelOutline.resetState()

      // Set file, model and fixed settings for outline workflow
      // Force word-count based chunking (ignore chapters)
      await window.api.novelOutline.setState({
        selectedFile: selectedFile,
        selectedModel: selectedModel,
        outputPath: outlineDir,
        // Fixed settings for outline workflow
        chunkSize: 150000, // Fixed 150,000 chars per chunk
        overlap: 0,
        maxConcurrency: 3,
        continueLatestTask: false,
        enableAutoResume: true
      })

      // Now transition to processing step after state is properly set
      setStep('processing')

      // Start outline extraction
      await window.api.novelOutline.startCompression(providerConfigs, undefined, { autoRetry: true })
    } catch (error) {
      console.error('Failed to start outline extraction:', error)
      setStep('config') // Revert to config on error
    } finally {
      setIsStarting(false)  // 重置防重复提交状态
    }
  }, [canStart, selectedModel, selectedFile, dispatch, isStarting])

  // 追踪当前任务的开始时间，用于过滤旧状态
  const taskStartTimeRef = useRef<number>(0)

  // 主进程状态 - 用于可靠接收所有更新
  const [mainProcessState, setMainProcessState] = useState<{
    isProcessing?: boolean
    progress?: ProcessingState & { stage: string }
    result?: { final?: string }
    outputPath?: string  // 实际的任务目录路径（带时间戳/哈希）
  } | null>(null)

  // 订阅主进程状态更新 - 空依赖，永不重建订阅
  useEffect(() => {
    let isMounted = true
    console.log('[OutlineWorkflow] Setting up state subscription')

    // 注意：不再在这里获取初始状态，避免读取到旧任务的完成状态
    // 初始状态由 restoreState useEffect 处理

    // 订阅状态更新
    const unsubscribeState = window.api.novelOutline.onStateUpdated((state) => {
      if (!isMounted) return
      console.log('[OutlineWorkflow] Received state update:', {
        isProcessing: state.isProcessing,
        progress: state.progress,
        hasResult: !!state.result?.final,
        outputPath: state.outputPath
      })
      setMainProcessState({
        isProcessing: state.isProcessing,
        progress: state.progress ?? undefined,
        result: state.result ?? undefined,
        outputPath: state.outputPath ?? undefined
      })
    })

    return () => {
      console.log('[OutlineWorkflow] Cleaning up state subscription')
      isMounted = false
      unsubscribeState()
    }
  }, []) // 空依赖 - 订阅只创建一次

  // 使用 ref 追踪最新值，避免 useEffect 闭包陷阱
  const stepRef = useRef(step)
  const resultRef = useRef(result)
  const progressRef = useRef(progress)
  const outputDirRef = useRef(outputDir)

  // 同步 ref 值
  useEffect(() => { stepRef.current = step }, [step])
  useEffect(() => { resultRef.current = result }, [result])
  useEffect(() => { progressRef.current = progress }, [progress])
  useEffect(() => { outputDirRef.current = outputDir }, [outputDir])

  // 响应主进程状态变化 - 处理业务逻辑
  useEffect(() => {
    if (!mainProcessState) return

    const currentStep = stepRef.current
    const currentResult = resultRef.current
    const currentProgress = progressRef.current
    const currentOutputDir = outputDirRef.current

    // 同步处理状态
    if (mainProcessState.isProcessing && currentStep !== 'processing') {
      console.log('[OutlineWorkflow] Transitioning to processing step')
      setStep('processing')
    }

    // 同步进度 - 只在值变化时更新
    if (mainProcessState.progress) {
      const newProgress = mainProcessState.progress

      // 检查是否需要更新进度（避免无限循环）
      const needsProgressUpdate =
        currentProgress.stage !== newProgress.stage ||
        currentProgress.percentage !== newProgress.percentage ||
        currentProgress.current !== newProgress.current ||
        currentProgress.total !== newProgress.total

      if (needsProgressUpdate) {
        console.log('[OutlineWorkflow] Updating progress:', newProgress)
        setProgress({
          stage: newProgress.stage,
          percentage: newProgress.percentage,
          current: newProgress.current,
          total: newProgress.total
        })

        // 更新 Redux session
        dispatch(updateSessionProgress({
          type: 'outline',
          progress: {
            stage: newProgress.stage,
            percentage: newProgress.percentage,
            current: newProgress.current,
            total: newProgress.total
          },
          status: newProgress.stage === 'completed' ? 'complete' : 'processing'
        }))
      }

      // 处理失败状态 - 保持在 processing 步骤，等待自动重试
      if (newProgress.stage === 'failed') {
        console.log('[OutlineWorkflow] Task failed, staying in processing step for auto-retry')
        // 失败时不跳转到 complete，保持在 processing 等待自动重试
        return
      }

      // 检查完成状态 - 支持 completed 和 finalizing (100% 且有结果)
      const isCompleted = newProgress.stage === 'completed' ||
        (newProgress.stage === 'finalizing' && newProgress.percentage >= 100 && mainProcessState.result?.final)

      if (isCompleted) {
        // 更新结果
        if (mainProcessState.result?.final && !currentResult) {
          console.log('[OutlineWorkflow] Setting result from main process')
          setResult(mainProcessState.result.final)
        }

        // 更新 outputDir 为主进程返回的实际任务目录（带时间戳/哈希）
        if (mainProcessState.outputPath && mainProcessState.outputPath !== currentOutputDir) {
          console.log('[OutlineWorkflow] Updating outputDir to actual task directory:', mainProcessState.outputPath)
          setOutputDir(mainProcessState.outputPath)
        }

        // 转换步骤 - 使用主进程返回的实际 outputPath
        if (currentStep === 'processing') {
          console.log('[OutlineWorkflow] Transitioning to complete step')
          setStep('complete')
          // 优先使用主进程返回的实际任务目录路径（带时间戳/哈希）
          const actualOutputDir = mainProcessState.outputPath || currentOutputDir
          dispatch(completeSession({ type: 'outline', outputDir: actualOutputDir || undefined }))
        }
      }
    }

    // 如果已完成但没有结果，尝试获取
    if (currentStep === 'complete' && !currentResult && mainProcessState.result?.final) {
      console.log('[OutlineWorkflow] Late result update for complete step')
      setResult(mainProcessState.result.final)
    }
  }, [mainProcessState, dispatch])

  // 监听失败自动重试触发事件
  useEffect(() => {
    const unsubscribe = window.api.novelOutline.onAutoResumeTriggered((data) => {
      console.log(`[OutlineWorkflow] 收到第${data.attempt}次重试通知（最大${data.maxAttempts}次）`)

      setTimeout(() => {
        // 使用 ref 获取最新状态，避免闭包陷阱
        const currentStep = stepRef.current
        const currentProgress = progressRef.current

        // 检查当前是否处于失败状态且未在处理中
        if (currentStep === 'processing' && currentProgress?.stage === 'failed') {
          console.log(`[OutlineWorkflow] 开始第${data.attempt}次重试...`)
          window.toast?.info?.(`失败自动重试：第${data.attempt}次重试`)
          handleStart()
        }
      }, 3000)
    })

    return () => {
      unsubscribe()
    }
  }, [handleStart])

  // Handle save result
  const handleSaveResult = useCallback(async () => {
    if (!result) return

    try {
      const baseName = selectedFile?.origin_name?.replace(/\.[^.]+$/, '') || historyBookTitle?.replace(/\.[^.]+$/, '') || 'novel'
      const suggested = `${baseName}.outline.md`
      await window.api.file.save(suggested, result)
    } catch (error) {
      console.error('Failed to save result:', error)
    }
  }, [result, selectedFile, historyBookTitle])

  // Handle cancel processing
  const handleCancel = useCallback(() => {
    window.api.novelOutline.cancel()
    dispatch(clearActiveSession('outline'))
    setStep('config')
    setProgress({ stage: 'initializing', percentage: 0 })
  }, [dispatch])

  useEffect(() => {
    const order: Record<WorkflowStep, number> = { config: 0, processing: 1, complete: 2 }
    const prev = prevStepRef.current
    if (prev === step) return
    setStepDirection(order[step] > order[prev] ? 1 : -1)
    prevStepRef.current = step
  }, [step])

  // Show loading while restoring
  if (isRestoring) {
    return (
      <>
        <DragBar />
        <div className="flex flex-col items-center justify-center h-full w-full bg-background">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      </>
    )
  }

  let stepContent: ReactNode

  const handleStartNewTask = () => {
    dispatch(clearActiveSession('outline'))
    setStep('config')
    setResult(null)
    setOutputDir(null)
    setProgress({ stage: 'initializing', percentage: 0 })
  }

  // Render based on step
  if (step === 'processing') {
    const navButtons = (
      <CircularNavButton
        direction="left"
        tooltip={t('workflow.processing.cancel', '取消任务')}
        onPress={handleCancel}
      />
    )

    stepContent = (
      <WorkflowLayout nav={navButtons}>
        <StepHeader
          title={t('workflow.outline.processing', '正在生成大纲')}
          hint={t('workflow.outline.processingHint', '请耐心等待，处理完成后将自动显示结果')}
        />

        {/* 失败状态提示 */}
        {progress.stage === 'failed' && (
          <Card className="w-full border-warning-200 bg-warning-50">
            <CardBody>
              <div className="text-warning-600 font-semibold mb-2">
                ⚠️ 任务失败：部分分块未能生成
              </div>
              <div className="text-sm text-foreground/60">
                已成功处理 {progress.current}/{progress.total} 个分块。
                系统将在3秒后自动重试，或取消任务后手动重新开始。
              </div>
            </CardBody>
          </Card>
        )}

        <div className="w-full max-w-2xl mx-auto bg-content1/50 rounded-3xl p-8 border border-white/5 backdrop-blur-sm">
          <ProgressDisplay
            percentage={progress.percentage}
            stage={progress.stage}
            current={progress.current}
            total={progress.total}
          />

          {progress.stage !== 'failed' && (
            <div className="mt-8 flex items-center justify-center gap-4">
              <Loader2 size={32} className="animate-spin text-primary" />
            </div>
          )}
        </div>
      </WorkflowLayout>
    )
  } else if (step === 'complete') {
    const navButtons = (
      <CircularNavButton
        direction="right"
        tooltip={t('workflow.complete.newTask', '开始新任务')}
        onPress={handleStartNewTask}
      />
    )

    stepContent = (
      <WorkflowLayout nav={navButtons}>
        <StepHeader
          title={t('workflow.outline.complete', '生成完成')}
          hint={t('workflow.outline.completeHint', '大纲已生成完成')}
        />

        <Card className="w-full max-w-3xl relative group">
          <CardBody className="max-h-96 overflow-y-auto">
            {result ? (
              <TextReaderMarkdown className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
              </TextReaderMarkdown>
            ) : (
              <div className="text-center py-8 text-foreground/40">
                {t('workflow.outline.noResult', '暂无内容')}
              </div>
            )}
          </CardBody>
          {result && (
            <FullscreenResultViewer
              content={result}
              kind="markdown"
              title={historyBookTitle || selectedFile?.origin_name || '大纲'}
            />
          )}
        </Card>

        <div className="flex items-center justify-center gap-4">
          <Button
            variant="bordered"
            startContent={<FolderOpen size={16} />}
            onPress={handleOpenTaskDir}
            isDisabled={!outputDir}
            className="h-12 px-6"
          >
            {t('workflow.complete.openTaskDir', '打开任务目录')}
          </Button>
          <Button color="primary" onPress={handleSaveResult} className="h-12 px-6">
            {t('workflow.complete.saveResult', '保存结果')}
          </Button>
        </div>
      </WorkflowLayout>
    )
  } else {
    // Config step (default)
    const navButtons = (
      <CircularNavButton
        direction="right"
        tooltip={t('workflow.config.start', '确认开始')}
        onPress={handleStart}
        isDisabled={!canStart || isStarting}
        isLoading={isStarting}
      />
    )

    stepContent = (
      <WorkflowLayout nav={navButtons}>
        <StepHeader
          title={t('workflow.outline.title', '生成大纲')}
          hint={t('workflow.outline.configHint', '选择模型和小说文件，开始生成故事大纲')}
        />

        <p className="text-xs text-foreground/30 font-mono tracking-wide uppercase text-center -mt-4 mb-8">
          {t('workflow.outline.settings', '分块方式: 按字数强制分块 | 分块大小: 15万字')}
        </p>

        <GlassContainer className="space-y-8">
          <ModelSelector selectedModel={selectedModel} onModelSelect={setSelectedModel} />
          <NovelPicker selectedFile={selectedFile} onFileSelect={setSelectedFile} />
        </GlassContainer>
      </WorkflowLayout>
    )
  }

  return (
    <>
      <DragBar />
      <WorkflowStepMotion motionKey={step} direction={stepDirection}>
        {stepContent}
      </WorkflowStepMotion>
    </>
  )
}

export default OutlineWorkflow
