import { Button, Card, CardBody, Chip, Input, Select, SelectItem, Switch, Tab, Tabs, Textarea, Tooltip } from '@heroui/react'
import {
  getActualProvider,
  providerToAiSdkConfig
} from '@renderer/aiCore/provider/providerConfig'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { clearActiveSession, clearCompletedSession, completeSession, setActiveSession, updateSessionOutputDir, updateSessionProgress } from '@renderer/store/workflow'
import type { Model } from '@shared/types'
import { ArrowLeft, ArrowRight, Download, Info, Loader2, Mic, Play, Plus, RefreshCw, Sparkles, X } from 'lucide-react'
import { FC, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import DragBar from './components/DragBar'
import FullscreenResultViewer from './components/FullscreenResultViewer'
import ModelSelector from './components/ModelSelector'
import NovelPicker, { SelectedFile } from './components/NovelPicker'
import ProgressDisplay from './components/ProgressDisplay'
import WorkflowStepMotion from './components/WorkflowStepMotion'

type WorkflowStep = 'config' | 'extracting' | 'secondary' | 'tts' | 'done'

interface ProcessingState {
  stage: string
  percentage: number
  current?: number
  total?: number
}

interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  mtimeMs: number
  size: number
}

// --- Reusable UI Components ---

const WorkflowLayout: FC<{ children: ReactNode; nav?: ReactNode; className?: string }> = ({ children, nav, className }) => (
  <div className={`flex flex-col h-full w-full bg-background relative group ${className || ''}`}>
    {nav}
    <div className="flex-1 flex flex-col items-center overflow-y-auto px-6 md:px-20 lg:px-32 py-12">
      <div className="w-full max-w-4xl space-y-10 my-auto pb-20">
        {children}
      </div>
    </div>
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
  color?: "primary" | "light"
}> = ({ direction, onPress, isDisabled, isLoading, tooltip, icon, color = "light" }) => (
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

const CharacterWorkflow: FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const [searchParams] = useSearchParams()

  // Redux state
  const activeSession = useAppSelector((state) => state.workflow.activeSessions['character'])
  const history = useAppSelector((state) => state.workflow.history)
  const providers = useAppSelector((state) => state.llm.providers)

  const allModels = useMemo(() => providers.flatMap((p) => p.models), [providers])

  // Get session id from URL params (for viewing history results)
  const historySessionId = searchParams.get('sessionId')
  const historyOutputDir = searchParams.get('outputDir')

  const historySession = useMemo(() => {
    if (!historySessionId) return null
    return history.find((s) => s.id === historySessionId && s.type === 'character') ?? null
  }, [history, historySessionId])

  // Local state
  const [step, setStep] = useState<WorkflowStep>('config')
  const [stepDirection, setStepDirection] = useState<-1 | 0 | 1>(0)
  const prevStepRef = useRef<WorkflowStep>('config')
  const [selectedModel, setSelectedModel] = useState<Model | null>(null)
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
  const [isTargetCharacterModeEnabled, setIsTargetCharacterModeEnabled] = useState(false)
  const [targetCharacters, setTargetCharacters] = useState<string[]>([])
  const [newCharacterName, setNewCharacterName] = useState('')
  const [progress, setProgress] = useState<ProcessingState>({ stage: 'initializing', percentage: 0 })
  const [result, setResult] = useState<string | null>(null)
  const [outputDir, setOutputDir] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(true)
  const [historyBookTitle, setHistoryBookTitle] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)  // 防重复提交

  // 人物 TXT 合集（用于“非指定人物模式”的结果展示）
  const [characterTxtFiles, setCharacterTxtFiles] = useState<FsEntry[]>([])
  const [selectedCharacterPath, setSelectedCharacterPath] = useState<string | null>(null)
  const [isCharacterListLoading, setIsCharacterListLoading] = useState(false)

  // 二次总结（人物志/心理独白）- 结果文件为真相，仅用于渲染的短暂状态
  type SecondaryKind = 'bio' | 'monologue'
  const [secondaryKind, setSecondaryKind] = useState<SecondaryKind>('bio')
  const [secondaryBioText, setSecondaryBioText] = useState<string | null>(null)
  const [secondaryMonologueText, setSecondaryMonologueText] = useState<string | null>(null)
  const [isSecondaryBioLoading, setIsSecondaryBioLoading] = useState(false)
  const [isSecondaryMonologueLoading, setIsSecondaryMonologueLoading] = useState(false)
  const [isSecondaryBioGenerating, setIsSecondaryBioGenerating] = useState(false)
  const [isSecondaryMonologueGenerating, setIsSecondaryMonologueGenerating] = useState(false)

  // 阶段内进度条（用于二次总结/语音生成，提取阶段仍使用 progress）
  const [stageProgress, setStageProgress] = useState<ProcessingState | null>(null)

  // 二次总结可编辑草稿（来自落盘文件；保存时写回文件）
  const [secondaryBioDraft, setSecondaryBioDraft] = useState<string>('')
  const [secondaryMonologueDraft, setSecondaryMonologueDraft] = useState<string>('')

  // 语音生成（第三阶段）
  const [ttsSourceKind, setTtsSourceKind] = useState<'bio' | 'monologue'>('bio')
  const [ttsVoice, setTtsVoice] = useState('zh-CN-XiaoxiaoNeural')
  const [ttsRate, setTtsRate] = useState('+0%')
  const [ttsPitch, setTtsPitch] = useState('+0Hz')
  const [ttsVolume, setTtsVolume] = useState('+0%')
  const [isTtsGenerating, setIsTtsGenerating] = useState(false)
  const [ttsAudioPath, setTtsAudioPath] = useState<string | null>(null)
  const [ttsAudioUrl, setTtsAudioUrl] = useState<string | null>(null)
  const ttsGenerationTokenRef = useRef(0)

  const ttsVoices = useMemo(() => {
    return [
      { value: 'zh-CN-XiaoxiaoNeural', label: '中文 - 晓晓（女）' },
      { value: 'zh-CN-YunxiNeural', label: '中文 - 云希（男）' },
      { value: 'zh-CN-YunjianNeural', label: '中文 - 云健（男）' },
      { value: 'zh-CN-XiaoyiNeural', label: '中文 - 晓伊（女）' },
      { value: 'en-US-AriaNeural', label: 'English (US) - Aria (Female)' },
      { value: 'en-US-GuyNeural', label: 'English (US) - Guy (Male)' },
      { value: 'en-US-JennyNeural', label: 'English (US) - Jenny (Female)' },
      { value: 'ja-JP-NanamiNeural', label: 'Japanese - Nanami (Female)' },
      { value: 'ja-JP-KeitaNeural', label: 'Japanese - Keita (Male)' }
    ]
  }, [])

  const popoverPortalContainer = useMemo(() => {
    return typeof document !== 'undefined' ? document.body : undefined
  }, [])

  // Check if can start
  const canStart =
    selectedModel !== null &&
    selectedFile !== null &&
    (!isTargetCharacterModeEnabled || targetCharacters.length > 0)

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
      console.log('[CharacterWorkflow] Skipping restore - already restored and no historySessionId change')
      return
    }

    console.log('[CharacterWorkflow] Running restore logic, historySessionIdChanged:', historySessionIdChanged)

    // Reset state when historySessionId changes to prevent showing stale data
    ttsGenerationTokenRef.current += 1
    setIsTtsGenerating(false)
    setStep('config')
    setResult(null)
    setOutputDir(null)
    setHistoryBookTitle(null)
    setCharacterTxtFiles([])
    setSelectedCharacterPath(null)
    setIsCharacterListLoading(false)
    setSecondaryKind('bio')
    setSecondaryBioText(null)
    setSecondaryMonologueText(null)
    setIsSecondaryBioLoading(false)
    setIsSecondaryMonologueLoading(false)
    setIsSecondaryBioGenerating(false)
    setIsSecondaryMonologueGenerating(false)
    setProgress({ stage: 'initializing', percentage: 0 })
    setIsRestoring(true)

    const findResultFile = async (dir: string): Promise<string | null> => {
      try {
        const pickFromDir = async (dirPath: string): Promise<string | null> => {
          try {
            const entries = await window.api.fs.readdir(dirPath)
            if (!entries || entries.length === 0) return null

            const files = entries.filter((f) => f.isFile)
            if (files.length === 0) return null

            // Prefer markdown, then txt, then latest.json, then any json
            const md = files.find((f) => f.name?.toLowerCase().endsWith('.md'))
            if (md) return md.path

            const txt = files.find((f) => f.name?.toLowerCase().endsWith('.txt'))
            if (txt) return txt.path

            const latestJson = files.find((f) => f.name?.toLowerCase() === 'latest.json')
            if (latestJson) return latestJson.path

            const anyJson = files.find((f) => f.name?.toLowerCase().endsWith('.json'))
            if (anyJson) return anyJson.path

            return files[0]?.path ?? null
          } catch {
            return null
          }
        }

        // New format: results under {taskDir}/最终结果/
        const finalResultsDir = await window.api.path.join(dir, '最终结果')
        const fromFinal = await pickFromDir(finalResultsDir)
        if (fromFinal) return fromFinal

        // Legacy fallback: result directly under task dir
        return await pickFromDir(dir)
      } catch {
        return null
      }
    }

    const restoreState = async () => {
      try {
        const detectStepByOutputDir = async (dir: string): Promise<WorkflowStep> => {
          try {
            const audioDir = await window.api.path.join(dir, 'audio')
            const entries = (await window.api.fs.readdir(audioDir)) as FsEntry[]
            const hasMp3 = entries.some((e) => e.isFile && e.name?.toLowerCase().endsWith('.mp3'))
            if (hasMp3) return 'done'
          } catch {
            // ignore - audio folder may not exist yet
          }
          return 'secondary'
        }

        // Prefer file-based history navigation (outputDir is the source of truth)
        if (historyOutputDir) {
          const resultFilePath = await findResultFile(historyOutputDir)
          if (resultFilePath) {
            const content = await window.api.fs.readText(resultFilePath)
            if (content) {
              setResult(content)
            }
          }
          const parts = historyOutputDir.split(/[/\\]/).filter(Boolean)
          const markerIndex = parts.lastIndexOf('character')
          const guessedBookTitle = markerIndex > 0 ? parts[markerIndex - 1] : null
          setOutputDir(historyOutputDir)
          setStep(await detectStepByOutputDir(historyOutputDir))
          setHistoryBookTitle(guessedBookTitle)
          setIsRestoring(false)
          return
        }

        // Check if viewing history result
        if (historySessionId) {
          // Find session in history with matching id AND type
          const historySession = history.find((s) => s.id === historySessionId && s.type === 'character')
          if (historySession && historySession.outputDir) {
            // Try to read result from file
            const resultFilePath = await findResultFile(historySession.outputDir)
            if (resultFilePath) {
              const content = await window.api.fs.readText(resultFilePath)
              if (content) {
                setResult(content)
                setOutputDir(historySession.outputDir)
                setStep(await detectStepByOutputDir(historySession.outputDir))
                setHistoryBookTitle(historySession.bookTitle)
                setIsRestoring(false)
                return
              }
            }
            // Even if file not found, still show complete state with no result
            setOutputDir(historySession.outputDir)
            setStep(await detectStepByOutputDir(historySession.outputDir))
            setHistoryBookTitle(historySession.bookTitle)
            setIsRestoring(false)
            return
          }
        }

        const state = await window.api.novelCharacter.getState()
        console.log('[CharacterWorkflow] Restore state from main process:', {
          isProcessing: state?.isProcessing,
          progress: state?.progress,
          hasResult: !!state?.result?.merged
        })

        // 若存在 Redux active session（从主页“进行中”进入），优先使用主进程 state.outputPath
        // 避免 Redux 中 outputDir 仍是旧的 bookDir/character，导致二次总结/音频落盘目录对不上。
        if (activeSession && state?.outputPath) {
          const looksLikeFile = /\.[a-z0-9]+$/i.test(state.outputPath)
          const dir = looksLikeFile ? await window.api.path.dirname(state.outputPath) : state.outputPath

          setOutputDir(dir)
          setStep(await detectStepByOutputDir(dir))

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

          if (activeSession.outputDir !== dir) {
            dispatch(updateSessionOutputDir({ type: 'character', outputDir: dir }))
          }

          return
        }

        if (state?.isProcessing) {
          // Task is running - restore to extracting step
          setStep('extracting')
          if (state.outputPath) {
            // outputPath 可能是“任务目录”或“文件路径”，做一次启发式兼容
            const looksLikeFile = /\.[a-z0-9]+$/i.test(state.outputPath)
            const dir = looksLikeFile ? await window.api.path.dirname(state.outputPath) : state.outputPath
            setOutputDir(dir)
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
          // 注意：不再从主进程恢复已完成的结果（state?.result?.merged）
          // 从主页进入时用户期望开始新任务，不应显示旧结果
          // 旧结果可通过历史记录（带 sessionId 参数）访问
          // Restore from Redux session if main process doesn't have active state
          if (activeSession.status === 'processing') {
            const dir = activeSession.outputDir || null
            setOutputDir(dir)
            setStep(dir ? await detectStepByOutputDir(dir) : 'config')
            if (activeSession.progress) {
              setProgress(activeSession.progress)
            }
          } else if (activeSession.status === 'complete') {
            const dir = activeSession.outputDir || null
            setOutputDir(dir)
            setStep(dir ? await detectStepByOutputDir(dir) : 'secondary')

            // 修复：主动归档到历史记录，防止任务卡在"进行中"状态
            // 检测到 Redux 中任务已完成但仍在 activeSessions 中，需要立即归档
            // Legacy: 旧版本可能把人物志任务标记为 complete；新流程以 mp3 落盘为完成标志，不在此处归档。
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

  const selectedCharacterFile = characterTxtFiles.find((f) => f.path === selectedCharacterPath) ?? null
  const selectedCharacterName = selectedCharacterFile?.name?.replace(/\.txt$/i, '') ?? null

  // 二次总结/语音阶段：从“人物TXT合集”读取人物列表（文件系统即真相）
  const shouldUseCharacterTxtFolder =
    (step === 'secondary' || step === 'tts' || step === 'done') && !!outputDir
  const hasSecondaryOutput = !!secondaryBioText || !!secondaryMonologueText

  const secondaryModel = useMemo(() => {
    if (selectedModel) return selectedModel
    const candidateId = activeSession?.modelId ?? historySession?.modelId ?? null
    if (!candidateId) return null
    return allModels.find((m) => m.id === candidateId) ?? null
  }, [activeSession?.modelId, allModels, historySession?.modelId, selectedModel])

  const sanitizeSecondaryFileStem = useCallback((raw: string) => {
    const trimmed = raw.trim()
    return trimmed.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || '未命名人物'
  }, [])

  const getSecondaryFilePath = useCallback(async (kind: SecondaryKind): Promise<string | null> => {
    if (!outputDir || !selectedCharacterName) return null
    const kindDirName = kind === 'bio' ? '人物志' : '心理独白'
    const safeStem = sanitizeSecondaryFileStem(selectedCharacterName)
    return await window.api.path.join(outputDir, '二次总结', kindDirName, `${safeStem}.txt`)
  }, [outputDir, sanitizeSecondaryFileStem, selectedCharacterName])

  const findAnyAudioFile = useCallback(async (): Promise<string | null> => {
    if (!outputDir) return null
    try {
      const audioDir = await window.api.path.join(outputDir, 'audio')
      const entries = (await window.api.fs.readdir(audioDir)) as FsEntry[]
      const mp3s = entries
        .filter((e) => e.isFile && e.name?.toLowerCase().endsWith('.mp3'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      return mp3s[0]?.path ?? null
    } catch {
      return null
    }
  }, [outputDir])

  const loadAudioByPath = useCallback(async (audioPath: string) => {
    try {
      const base64 = await window.api.fs.read(audioPath, 'base64')
      const url = `data:audio/mp3;base64,${base64}`
      setTtsAudioPath(audioPath)
      setTtsAudioUrl(url)
      return audioPath
    } catch {
      setTtsAudioPath(audioPath)
      setTtsAudioUrl(null)
      return audioPath
    }
  }, [])

  const loadSecondaryFromDisk = useCallback(async (kind: SecondaryKind) => {
    const filePath = await getSecondaryFilePath(kind)
    if (!filePath) {
      if (kind === 'bio') setSecondaryBioText(null)
      else setSecondaryMonologueText(null)
      if (kind === 'bio') setSecondaryBioDraft('')
      else setSecondaryMonologueDraft('')
      return
    }

    const setLoading = kind === 'bio' ? setIsSecondaryBioLoading : setIsSecondaryMonologueLoading
    const setText = kind === 'bio' ? setSecondaryBioText : setSecondaryMonologueText
    const setDraft = kind === 'bio' ? setSecondaryBioDraft : setSecondaryMonologueDraft

    setLoading(true)
    try {
      const content = await window.api.fs.readText(filePath)
      const normalized = content?.trim() ? content : null
      setText(normalized)
      setDraft(normalized ?? '')
    } catch {
      setText(null)
      setDraft('')
    } finally {
      setLoading(false)
    }
  }, [getSecondaryFilePath])

  const secondaryAutoLoadKeyRef = useRef<string | null>(null)

  // 二次总结/语音阶段：人物切换时，自动读取二次总结结果（不存在则保持为空）
  useEffect(() => {
    if (!(step === 'secondary' || step === 'tts' || step === 'done')) return
    if (!selectedCharacterName || !selectedCharacterPath || !outputDir) {
      setSecondaryBioText(null)
      setSecondaryMonologueText(null)
      setIsSecondaryBioLoading(false)
      setIsSecondaryMonologueLoading(false)
      secondaryAutoLoadKeyRef.current = null
      return
    }

    const key = `${outputDir}::${selectedCharacterPath}`
    const isCharacterChanged = secondaryAutoLoadKeyRef.current !== key
    secondaryAutoLoadKeyRef.current = key

    // 仅在“人物/任务目录”变化时清空，避免从第三阶段返回时闪白
    if (isCharacterChanged) {
      setSecondaryBioText(null)
      setSecondaryMonologueText(null)
    }

    // 按需读取：二次总结阶段仅加载当前 Tab；语音阶段需要来源可选，加载两份。
    if (step === 'tts') {
      loadSecondaryFromDisk('bio')
      loadSecondaryFromDisk('monologue')
    } else {
      loadSecondaryFromDisk(secondaryKind)
    }
  }, [loadSecondaryFromDisk, outputDir, secondaryKind, selectedCharacterName, selectedCharacterPath, step])

  // 若 mp3 已生成：直接跳到最终结果阶段（并将 Redux active session 归档到历史）
  useEffect(() => {
    // 避免在二次总结阶段频繁探测 audio 目录（ENOENT 会在 main 侧刷红）；仅在语音阶段兜底探测。
    if (step !== 'tts') return
    if (!outputDir) return
    if (isTtsGenerating) return

    let cancelled = false
    ;(async () => {
      const audioPath = await findAnyAudioFile()
      if (!audioPath || cancelled) return
      await loadAudioByPath(audioPath)
      if (cancelled) return
      setStep('done')
      // 只有在 activeSession 仍为 processing 时才归档
      if (activeSession?.status === 'processing') {
        dispatch(completeSession({ type: 'character', outputDir }))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeSession?.status, dispatch, findAnyAudioFile, isTtsGenerating, loadAudioByPath, outputDir, step])

  // done 阶段：确保能从磁盘加载音频预览（history/重启后也能直接播放）
  useEffect(() => {
    if (step !== 'done') return
    if (!outputDir || ttsAudioUrl) return

    let cancelled = false
    ;(async () => {
      const audioPath = await findAnyAudioFile()
      if (!audioPath || cancelled) return
      await loadAudioByPath(audioPath)
    })()

    return () => {
      cancelled = true
    }
  }, [findAnyAudioFile, loadAudioByPath, outputDir, step, ttsAudioUrl])

  // 完成页：自动读取 人物TXT合集 作为“人物列表 + 单人展示”的数据源（无缓存，文件系统即真相）
  useEffect(() => {
    if (!shouldUseCharacterTxtFolder || !outputDir) return

    let cancelled = false
    const load = async () => {
      setIsCharacterListLoading(true)
      try {
        const charactersDir = await window.api.path.join(outputDir, '人物TXT合集')
        const entries = (await window.api.fs.readdir(charactersDir)) as FsEntry[]

        const txtFiles = entries
          .filter((e) => e.isFile && e.name?.toLowerCase().endsWith('.txt'))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

        if (cancelled) return

        // 优先自动选中“已经生成过二次总结”的人物（文件系统即真相；避免用户误以为需要重新生成）
        let preferredPath: string | null = null
        try {
          const bioDir = await window.api.path.join(outputDir, '二次总结', '人物志')
          const monoDir = await window.api.path.join(outputDir, '二次总结', '心理独白')
          const [bioEntries, monoEntries] = await Promise.all([
            window.api.fs.readdir(bioDir).catch(() => []),
            window.api.fs.readdir(monoDir).catch(() => [])
          ])

          const stemSet = new Set<string>()
          ;(bioEntries as FsEntry[])
            .filter((e) => e.isFile && e.name?.toLowerCase().endsWith('.txt'))
            .forEach((e) => stemSet.add(e.name.replace(/\.txt$/i, '')))
          ;(monoEntries as FsEntry[])
            .filter((e) => e.isFile && e.name?.toLowerCase().endsWith('.txt'))
            .forEach((e) => stemSet.add(e.name.replace(/\.txt$/i, '')))

          preferredPath =
            txtFiles.find((f) => {
              const characterName = f.name.replace(/\.txt$/i, '')
              const safeStem = sanitizeSecondaryFileStem(characterName)
              return stemSet.has(safeStem)
            })?.path ?? null
        } catch {
          preferredPath = null
        }

        setCharacterTxtFiles(txtFiles)
        setSelectedCharacterPath((prev) => {
          if (prev && txtFiles.some((f) => f.path === prev)) return prev
          return preferredPath ?? txtFiles[0]?.path ?? null
        })
      } catch (error) {
        console.warn('[CharacterWorkflow] Failed to load 人物TXT合集:', error)
        if (cancelled) return
        setCharacterTxtFiles([])
        setSelectedCharacterPath(null)
      } finally {
        if (!cancelled) setIsCharacterListLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [outputDir, sanitizeSecondaryFileStem, shouldUseCharacterTxtFolder])

  const handleAddCharacter = useCallback(() => {
    const name = newCharacterName.trim()
    if (!name) return
    setTargetCharacters((prev) => {
      if (prev.includes(name)) return prev
      return [...prev, name]
    })
    setNewCharacterName('')
  }, [newCharacterName])

  const handleRemoveCharacter = useCallback((index: number) => {
    setTargetCharacters((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const stageProgressTimerRef = useRef<number | null>(null)

  const startStageProgress = useCallback((stage: string) => {
    if (stageProgressTimerRef.current) {
      window.clearInterval(stageProgressTimerRef.current)
      stageProgressTimerRef.current = null
    }
    let pct = 8
    setStageProgress({ stage, percentage: pct })
    stageProgressTimerRef.current = window.setInterval(() => {
      pct = Math.min(92, pct + Math.max(1, Math.round(Math.random() * 7)))
      setStageProgress((prev) => (prev ? { ...prev, stage, percentage: pct } : { stage, percentage: pct }))
    }, 450)
  }, [])

  const stopStageProgress = useCallback((opts?: { finalPercentage?: number; keepMs?: number }) => {
    if (stageProgressTimerRef.current) {
      window.clearInterval(stageProgressTimerRef.current)
      stageProgressTimerRef.current = null
    }
    const finalPercentage = opts?.finalPercentage
    const keepMs = opts?.keepMs ?? 250
    if (finalPercentage !== undefined) {
      setStageProgress((prev) => (prev ? { ...prev, percentage: finalPercentage } : { stage: 'completed', percentage: finalPercentage }))
      window.setTimeout(() => setStageProgress(null), keepMs)
    } else {
      setStageProgress(null)
    }
  }, [])

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
      dispatch(clearCompletedSession('character'))
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
      const sanitizeBaseName = (raw: string) => {
        return (
          raw
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200) || '未命名'
        )
      }

      if (!selectedFile.path) {
        console.error('No file path available')
        return
      }

      // Read file content for chapter parsing
      const fileContent = await window.api.fs.readText(selectedFile.path)
      if (!fileContent) {
        console.error('Failed to read file content')
        return
      }

      // Parse chapters first - this is required for chapter-aware analysis
      const chapterParseResult = await window.api.novelCharacter.parseChapters(selectedFile.path)
      console.log('[CharacterWorkflow] Chapter parse result:', chapterParseResult)

      // Calculate chaptersPerChunk based on target chunk size (~150,000 chars)
      const TARGET_CHUNK_SIZE = 150000
      let chaptersPerChunk = 50 // fallback default
      if (chapterParseResult?.success && chapterParseResult.chapters.length > 0) {
        const totalChars = fileContent.length
        const totalChapters = chapterParseResult.chapters.length
        const avgCharsPerChapter = totalChars / totalChapters
        // Calculate how many chapters needed to reach target chunk size
        chaptersPerChunk = Math.max(1, Math.round(TARGET_CHUNK_SIZE / avgCharsPerChapter))
        console.log('[CharacterWorkflow] Auto-calculated chaptersPerChunk:', {
          totalChars,
          totalChapters,
          avgCharsPerChapter: Math.round(avgCharsPerChapter),
          chaptersPerChunk
        })
      }

      // Get book folder (parent of content.txt)
      const bookDir = await window.api.path.dirname(selectedFile.path)

      // Generate output path
      const parsed = await window.api.path.parse(selectedFile.origin_name || selectedFile.name || '未命名')
      const baseName = sanitizeBaseName(parsed?.name || selectedFile.name || '未命名')

      // Ensure character directory exists
      const characterDir = await window.api.path.join(bookDir, 'character')
      await window.api.file.mkdir(characterDir)

      // Save output directory for later use
      setOutputDir(characterDir)

      const characterOutputPath = await window.api.path.join(characterDir, `${baseName}.txt`)

      // Save session to Redux
      const sessionId = crypto.randomUUID()
      dispatch(setActiveSession({
        type: 'character',
        session: {
          id: sessionId,
          type: 'character',
          status: 'processing',
          bookId: selectedFile.id,
          bookTitle: selectedFile.origin_name || selectedFile.name || '未命名',
          bookPath: selectedFile.path,
          modelId: selectedModel.id,
          modelName: selectedModel.name,
          outputDir: characterDir,
          startedAt: new Date().toISOString(),
          progress: { percentage: 0, stage: 'initializing' }
        }
      }))

      // Reset state first to clear any previous completed state, then set new task config
      // This ensures we start fresh and don't carry over old progress/result
      await window.api.novelCharacter.resetState()

      // Set file, model and fixed settings for character workflow
      // Use byChapter mode with auto-calculated chaptersPerChunk targeting ~150k chars per chunk
      await window.api.novelCharacter.setState({
        selectedFile: selectedFile,
        selectedModel: selectedModel,
        outputPath: characterOutputPath,
        targetCharacters: isTargetCharacterModeEnabled ? targetCharacters : [],
        targetCharacterConfig: {
          enabled: isTargetCharacterModeEnabled,
          characters: targetCharacters
        },
        chunkSize: 150000, // Fallback for bySize mode
        overlap: 0,
        maxConcurrency: 3,
        chunkMode: 'byChapter', // Chapter-based chunking (required for character extraction)
        chaptersPerChunk: chaptersPerChunk, // Auto-calculated based on ~150k chars target
        continueLatestTask: false,
        enableAutoResume: true,
        // Pass chapter parse result to enable chapter-aware prompts
        chapterParseResult: chapterParseResult
      })

      // Now transition to extracting step after state is properly set
      setStepDirection(1)
      setStep('extracting')

      // Start character extraction
      await window.api.novelCharacter.startCompression(providerConfigs, undefined, { autoRetry: true })
    } catch (error) {
      console.error('Failed to start character extraction:', error)
      setStepDirection(-1)
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
    result?: { merged?: string }
    outputPath?: string  // 实际的任务目录路径（带时间戳）
  } | null>(null)

  // 订阅主进程状态更新 - 空依赖，永不重建订阅
  useEffect(() => {
    let isMounted = true
    console.log('[CharacterWorkflow] Setting up state subscription')

    // 注意：不再在这里获取初始状态，避免读取到旧任务的完成状态
    // 初始状态由 restoreState useEffect 处理

    // 订阅状态更新
    const unsubscribeState = window.api.novelCharacter.onStateUpdated((state) => {
      if (!isMounted) return
      console.log('[CharacterWorkflow] Received state update:', {
        isProcessing: state.isProcessing,
        progress: state.progress,
        hasResult: !!state.result?.merged,
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
      console.log('[CharacterWorkflow] Cleaning up state subscription')
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
    if (mainProcessState.isProcessing && currentStep !== 'extracting') {
      console.log('[CharacterWorkflow] Transitioning to extracting step')
      setStepDirection(1)
      setStep('extracting')
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
        console.log('[CharacterWorkflow] Updating progress:', newProgress)
        setProgress({
          stage: newProgress.stage,
          percentage: newProgress.percentage,
          current: newProgress.current,
          total: newProgress.total
        })

        // 更新 Redux session
        dispatch(updateSessionProgress({
          type: 'character',
          progress: {
            stage: newProgress.stage,
            percentage: newProgress.percentage,
            current: newProgress.current,
            total: newProgress.total
          },
          // 工作流整体以 mp3 落盘为完成标志；人物提取完成不应归档历史
          status: 'processing'
        }))
      }

      // 处理失败状态 - 保持在 processing 步骤，等待自动重试
      if (newProgress.stage === 'failed') {
        console.log('[CharacterWorkflow] Task failed, staying in processing step for auto-retry')
        // 失败时不跳转到 complete，保持在 processing 等待自动重试
        return
      }

      // 检查完成状态 - 支持 completed 和 finalizing (100% 且有结果)
      const isCompleted = newProgress.stage === 'completed' ||
        (newProgress.stage === 'finalizing' && newProgress.percentage >= 100 && mainProcessState.result?.merged)

      if (isCompleted) {
        // 更新结果
        if (mainProcessState.result?.merged && !currentResult) {
          console.log('[CharacterWorkflow] Setting result from main process')
          setResult(mainProcessState.result.merged)
        }

        // 更新 outputDir 为主进程返回的实际任务目录（带时间戳）
        if (mainProcessState.outputPath && mainProcessState.outputPath !== currentOutputDir) {
          console.log('[CharacterWorkflow] Updating outputDir to actual task directory:', mainProcessState.outputPath)
          setOutputDir(mainProcessState.outputPath)
          dispatch(updateSessionOutputDir({ type: 'character', outputDir: mainProcessState.outputPath }))
        }

        // 转换步骤：人物提取完成后直接进入二次总结阶段（不显示“提取完成”）
        if (currentStep === 'extracting') {
          console.log('[CharacterWorkflow] Transitioning to secondary step')
          setStepDirection(1)
          setStep('secondary')
          dispatch(updateSessionProgress({
            type: 'character',
            progress: { percentage: 60, stage: '等待二次总结' },
            status: 'processing'
          }))
        }
      }
    }

    // 如果已完成但没有结果，尝试获取
    if (currentStep === 'secondary' && !currentResult && mainProcessState.result?.merged) {
      console.log('[CharacterWorkflow] Late result update for secondary step')
      setResult(mainProcessState.result.merged)
    }
  }, [mainProcessState, dispatch])

  // 监听失败自动重试触发事件
  useEffect(() => {
    const unsubscribe = window.api.novelCharacter.onAutoResumeTriggered((data) => {
      console.log(`[CharacterWorkflow] 收到第${data.attempt}次重试通知（最大${data.maxAttempts}次）`)

      setTimeout(() => {
        // 使用 ref 获取最新状态，避免闭包陷阱
        const currentStep = stepRef.current
        const currentProgress = progressRef.current

        // 检查当前是否处于失败状态且未在处理中
        if (currentStep === 'extracting' && currentProgress?.stage === 'failed') {
          console.log(`[CharacterWorkflow] 开始第${data.attempt}次重试...`)
          window.toast?.info?.(`失败自动重试：第${data.attempt}次重试`)
          handleStart()
        }
      }, 3000)
    })

    return () => {
      unsubscribe()
    }
  }, [handleStart])

  const handleGenerateSecondary = useCallback(async (kind: SecondaryKind) => {
    if (!outputDir || !selectedCharacterPath || !selectedCharacterName) return
    if (!secondaryModel) {
      window.toast?.error?.(t('workflow.character.secondary.noModel', '未找到可用模型，请先配置模型'))
      return
    }

    const setGenerating = kind === 'bio' ? setIsSecondaryBioGenerating : setIsSecondaryMonologueGenerating
    const isGenerating = kind === 'bio' ? isSecondaryBioGenerating : isSecondaryMonologueGenerating
    if (isGenerating) return

    setGenerating(true)
    const stageLabel = kind === 'bio' ? '生成人物志' : '生成心理独白'
    startStageProgress(stageLabel)
    dispatch(updateSessionProgress({
      type: 'character',
      progress: { percentage: 70, stage: stageLabel },
      status: 'processing'
    }))
    try {
      const actualProvider = getActualProvider(secondaryModel)
      if (!actualProvider) {
        throw new Error(`Could not find provider for model: ${secondaryModel.name}`)
      }
      const config = providerToAiSdkConfig(actualProvider, secondaryModel)
      const providerConfigs = [{
        modelId: secondaryModel.id,
        providerId: config.providerId,
        options: config.options
      }]

      await window.api.novelCharacter.generateSecondary({
        providerConfigs,
        outputDir,
        plotFilePath: selectedCharacterPath,
        characterName: selectedCharacterName,
        kind
      })

      await loadSecondaryFromDisk(kind)
      stopStageProgress({ finalPercentage: 100 })
      // 生成完成后留在二次总结阶段；文本展示与编辑由 UI 决定
      setStep('secondary')
      window.toast?.success?.(
        kind === 'bio'
          ? t('workflow.character.secondary.bioDone', '人物志已生成')
          : t('workflow.character.secondary.monologueDone', '心理独白已生成')
      )
    } catch (error: any) {
      console.error('[CharacterWorkflow] Secondary generation failed:', error)
      window.toast?.error?.(error?.message || t('workflow.character.secondary.failed', '生成失败'))
    } finally {
      stopStageProgress()
      setGenerating(false)
    }
  }, [
    isSecondaryBioGenerating,
    isSecondaryMonologueGenerating,
    loadSecondaryFromDisk,
    dispatch,
    outputDir,
    secondaryModel,
    selectedCharacterName,
    selectedCharacterPath,
    startStageProgress,
    stopStageProgress,
    t
  ])

  const handleGoToTtsStep = useCallback((opts?: { updateProgress?: boolean }) => {
    // 第三阶段不展示内容，只展示参数与来源选择
    ttsGenerationTokenRef.current += 1
    stopStageProgress()
    setIsTtsGenerating(false)

    // 从二次总结页进入第三阶段时，确保 UI 能立即按来源可用性更新
    loadSecondaryFromDisk('bio')
    loadSecondaryFromDisk('monologue')

    setStepDirection(1)
    setStep('tts')

    if (opts?.updateProgress === false) return

    dispatch(updateSessionProgress({
      type: 'character',
      progress: { percentage: 85, stage: '等待生成语音' },
      status: 'processing'
    }))
  }, [dispatch, loadSecondaryFromDisk, stopStageProgress])

  const handleBackToSecondaryStep = useCallback(() => {
    ttsGenerationTokenRef.current += 1
    stopStageProgress()
    setIsTtsGenerating(false)
    setStepDirection(-1)
    setStep('secondary')
  }, [stopStageProgress])

  const handleGenerateTts = useCallback(async () => {
    if (!outputDir || !selectedCharacterName) return
    if (isTtsGenerating) return

    const kind = ttsSourceKind
    const sourcePath = await getSecondaryFilePath(kind)
    if (!sourcePath) {
      window.toast?.error?.(t('workflow.character.tts.missingSource', '未找到对应文本，请先生成二次总结'))
      return
    }

    setIsTtsGenerating(true)
    startStageProgress('生成语音')
    dispatch(updateSessionProgress({
      type: 'character',
      progress: { percentage: 92, stage: '生成语音' },
      status: 'processing'
    }))

    const generationToken = ++ttsGenerationTokenRef.current

    try {
      const text = await window.api.fs.readText(sourcePath)
      if (generationToken !== ttsGenerationTokenRef.current) return

      if (!text?.trim()) {
        throw new Error('文本为空，无法生成语音')
      }

      const audioDir = await window.api.path.join(outputDir, 'audio')
      if (generationToken !== ttsGenerationTokenRef.current) return

      const safeStem = sanitizeSecondaryFileStem(selectedCharacterName)
      const filename = `${safeStem}_${kind}.mp3`

      const result = await window.api.edgeTTS.generate({
        text,
        voice: ttsVoice,
        rate: ttsRate,
        pitch: ttsPitch,
        volume: ttsVolume,
        outputDir: audioDir,
        filename
      })
      if (generationToken !== ttsGenerationTokenRef.current) return

      const audioPath = result?.filePath as string | undefined
      if (!audioPath) {
        throw new Error('生成成功但未返回音频路径')
      }

      const base64 = await window.api.fs.read(audioPath, 'base64')
      if (generationToken !== ttsGenerationTokenRef.current) return

      setTtsAudioPath(audioPath)
      setTtsAudioUrl(`data:audio/mp3;base64,${base64}`)
      stopStageProgress({ finalPercentage: 100 })

      // 最终结果：渲染音频播放器，并将任务归档为完成
      setStepDirection(1)
      setStep('done')
      dispatch(completeSession({ type: 'character', outputDir }))
      window.toast?.success?.(t('workflow.tts.success', '生成成功'))
    } catch (error: any) {
      if (generationToken !== ttsGenerationTokenRef.current) return
      console.error('[CharacterWorkflow] TTS generation failed:', error)
      window.toast?.error?.(error?.message || t('workflow.tts.failed', '生成失败'))
    } finally {
      if (generationToken !== ttsGenerationTokenRef.current) return
      stopStageProgress()
      setIsTtsGenerating(false)
    }
  }, [
    completeSession,
    dispatch,
    getSecondaryFilePath,
    isTtsGenerating,
    outputDir,
    sanitizeSecondaryFileStem,
    selectedCharacterName,
    startStageProgress,
    stopStageProgress,
    t,
    ttsPitch,
    ttsRate,
    ttsSourceKind,
    ttsVoice,
    ttsVolume
  ])

  const handleOpenAudioFile = useCallback(() => {
    if (ttsAudioPath) {
      window.api.file.openPath(ttsAudioPath)
    }
  }, [ttsAudioPath])

  // Handle cancel processing
  const handleCancel = useCallback(() => {
    ttsGenerationTokenRef.current += 1
    stopStageProgress()
    setIsTtsGenerating(false)
    window.api.novelCharacter.cancel()
    dispatch(clearActiveSession('character'))
    setStep('config')
    setProgress({ stage: 'initializing', percentage: 0 })
  }, [dispatch, loadSecondaryFromDisk, stopStageProgress])

  useEffect(() => {
    const order: Record<WorkflowStep, number> = {
      config: 0,
      extracting: 1,
      secondary: 2,
      tts: 3,
      done: 4
    }
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

  // Render based on step
  if (step === 'extracting') {
    stepContent = (
      <div className="flex flex-col items-center justify-center h-full w-full overflow-auto bg-background px-6 py-12">
      <div className="text-center mb-12 flex-shrink-0">
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {t('workflow.character.processing', '正在提取人物')}
        </h1>
        <p className="text-foreground/60">
          {t('workflow.character.processingHint', '请耐心等待，处理完成后将自动显示结果')}
        </p>
      </div>

      {/* 失败状态提示 */}
      {progress.stage === 'failed' && (
        <Card className="w-full max-w-lg mb-6 border-warning-200 bg-warning-50">
          <CardBody>
            <div className="text-warning-600 font-semibold mb-2">
              ⚠️ 任务失败：部分分块未能生成
            </div>
            <div className="text-sm text-foreground/60">
              已成功处理 {progress.current}/{progress.total} 个分块。
              系统将在3秒后自动重试，或点击"取消任务"后手动重新开始。
            </div>
          </CardBody>
        </Card>
      )}

      <ProgressDisplay
        percentage={progress.percentage}
        stage={progress.stage}
        current={progress.current}
        total={progress.total}
      />

      {progress.stage !== 'failed' && (
        <div className="mt-8 flex items-center gap-4">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      )}

      <Button
        variant="bordered"
        color="danger"
        className="mt-8"
        startContent={<X size={16} />}
        onPress={handleCancel}
      >
        {t('workflow.processing.cancel', '取消任务')}
      </Button>
    </div>
    )
  } else if (step === 'secondary' || step === 'tts' || step === 'done') {
    const showCharacterPicker = shouldUseCharacterTxtFolder
    const fullscreenBaseTitle = historyBookTitle ?? selectedFile?.origin_name ?? selectedFile?.name ?? '人物志'

    const isSecondaryInitial = step === 'secondary' && !stageProgress && !hasSecondaryOutput

    if (step === 'secondary') {
      stepContent = (
        <WorkflowLayout
          nav={
            !isSecondaryInitial && (
              <CircularNavButton
                direction="right"
                tooltip={t('workflow.character.stage2.next', '下一步：生成语音')}
                onPress={() => handleGoToTtsStep({ updateProgress: false })}
                isDisabled={!secondaryBioText && !secondaryMonologueText}
                color="primary"
              />
            )
          }
        >
          <StepHeader
            title={t('workflow.character.stage2.title', '第二阶段：二次总结')}
            hint={t('workflow.character.stage2.hint', '不展示提取完成页，直接进入二次生成')}
          />

          {showCharacterPicker ? (
            isSecondaryInitial ? (
              // Initial State: Big Selection Buttons
              <GlassContainer className="flex flex-col items-center gap-8 py-12">
                <div className="w-full max-w-xs">
                  <Select
                    aria-label={t('workflow.character.result.selectCharacter', '选择人物')}
                    placeholder={
                      isCharacterListLoading
                        ? t('workflow.character.result.loadingCharacters', '正在读取人物列表...')
                        : t('workflow.character.result.selectCharacter', '选择人物')
                    }
                    selectedKeys={selectedCharacterPath ? [selectedCharacterPath] : []}
                    onChange={(e) => setSelectedCharacterPath(e.target.value || null)}
                    variant="faded"
                    radius="full"
                    size="lg"
                    classNames={{
                      trigger: "h-14 bg-content2/50 hover:bg-content2 transition-colors",
                      value: "text-center font-medium text-lg",
                    }}
                    isDisabled={isCharacterListLoading || characterTxtFiles.length === 0}
                    popoverProps={{
                      portalContainer: popoverPortalContainer,
                      classNames: { content: 'z-[200]' }
                    }}
                    renderValue={(items) => {
                      return items.map((item) => (
                        <div key={item.key} className="flex-1 text-center">
                          {item.textValue}
                        </div>
                      ))
                    }}
                  >
                    {characterTxtFiles.map((f) => {
                      const name = f.name.replace(/\.txt$/i, '')
                      return (
                        <SelectItem key={f.path} textValue={name}>
                          <div className="text-center w-full">{name}</div>
                        </SelectItem>
                      )
                    })}
                  </Select>
                </div>

                {!isCharacterListLoading && characterTxtFiles.length === 0 && (
                  <div className="text-sm text-foreground/40 text-center">
                    {t('workflow.character.result.noCharacters', '未找到人物 TXT')}
                  </div>
                )}

                <div className="flex items-center gap-6">
                  <Button
                    color="primary"
                    size="lg"
                    className="min-w-[160px] h-14 text-medium rounded-2xl shadow-lg shadow-primary/20"
                    startContent={<Sparkles size={20} />}
                    isDisabled={!selectedCharacterName || !selectedCharacterPath || !outputDir}
                    isLoading={isSecondaryBioGenerating}
                    onPress={() => handleGenerateSecondary('bio')}
                  >
                    {t('workflow.character.secondary.bio', '人物志')}
                  </Button>
                  <Button
                    variant="flat"
                    color="secondary"
                    size="lg"
                    className="min-w-[160px] h-14 text-medium rounded-2xl"
                    startContent={<Sparkles size={20} />}
                    isDisabled={!selectedCharacterName || !selectedCharacterPath || !outputDir}
                    isLoading={isSecondaryMonologueGenerating}
                    onPress={() => handleGenerateSecondary('monologue')}
                  >
                    {t('workflow.character.secondary.monologue', '心理独白')}
                  </Button>
                </div>
              </GlassContainer>
            ) : (
              // Result State: Tabs + Editor
              <div className="w-full space-y-6">
                {/* Top Bar: Character Picker + Tabs + Actions */}
                <div className="flex flex-col items-center gap-6">
                  <div className="p-1.5 bg-content2/30 rounded-2xl border border-white/5 backdrop-blur-sm">
                    <Tabs
                      size="lg"
                      selectedKey={secondaryKind}
                      onSelectionChange={(key) => setSecondaryKind(key as SecondaryKind)}
                      variant="light"
                      classNames={{
                        tabList: "gap-2",
                        cursor: "bg-background shadow-sm",
                        tab: "h-9 px-6",
                        tabContent: "group-data-[selected=true]:text-primary font-medium"
                      }}
                    >
                      <Tab key="bio" title={t('workflow.character.secondary.bio', '人物志')} />
                      <Tab key="monologue" title={t('workflow.character.secondary.monologue', '心理独白')} />
                    </Tabs>
                  </div>

                  <div className="flex items-center gap-3 bg-content2/30 rounded-2xl border border-white/5 backdrop-blur-sm p-2">
                    <Select
                      aria-label={t('workflow.character.result.selectCharacter', '选择人物')}
                      placeholder={t('workflow.character.result.selectCharacter', '选择人物')}
                      selectedKeys={selectedCharacterPath ? [selectedCharacterPath] : []}
                      onChange={(e) => setSelectedCharacterPath(e.target.value || null)}
                      variant="flat"
                      size="sm"
                      className="w-[180px]"
                      isDisabled={isCharacterListLoading || characterTxtFiles.length === 0}
                      popoverProps={{ classNames: { content: 'z-[200]' } }}
                      classNames={{
                        trigger: "bg-transparent shadow-none hover:bg-content2/50 h-9",
                        value: "text-center font-medium"
                      }}
                    >
                      {characterTxtFiles.map((f) => {
                        const name = f.name.replace(/\.txt$/i, '')
                        return (
                          <SelectItem key={f.path} textValue={name}>
                            <div className="text-center w-full">{name}</div>
                          </SelectItem>
                        )
                      })}
                    </Select>

                    <div className="w-px h-5 bg-foreground/10" />

                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      startContent={<Sparkles size={14} />}
                      isLoading={secondaryKind === 'bio' ? isSecondaryBioGenerating : isSecondaryMonologueGenerating}
                      isDisabled={!selectedCharacterPath || !outputDir}
                      onPress={() => handleGenerateSecondary(secondaryKind)}
                      className="h-9 px-4 rounded-xl"
                    >
                      {secondaryKind === 'bio'
                        ? (secondaryBioText ? t('workflow.character.secondary.regenerate', '重新生成') : t('workflow.character.secondary.generate', '生成'))
                        : (secondaryMonologueText ? t('workflow.character.secondary.regenerate', '重新生成') : t('workflow.character.secondary.generate', '生成'))}
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      isIconOnly
                      startContent={<RefreshCw size={14} />}
                      isLoading={secondaryKind === 'bio' ? isSecondaryBioLoading : isSecondaryMonologueLoading}
                      isDisabled={!selectedCharacterPath || !outputDir}
                      onPress={() => loadSecondaryFromDisk(secondaryKind)}
                      className="h-9 w-9 rounded-xl text-foreground/50"
                    />
                  </div>
                </div>

                {stageProgress && (
                  <GlassContainer className="py-6">
                    <ProgressDisplay
                      percentage={stageProgress.percentage}
                      stage={stageProgress.stage}
                      current={stageProgress.current}
                      total={stageProgress.total}
                    />
                  </GlassContainer>
                )}

                {/* Result Area */}
                <Card className="w-full relative shadow-sm bg-content1/50 border border-default-200/50 min-h-[500px]">
                  <CardBody className="p-0">
                    <Textarea
                      minRows={15}
                      maxRows={30}
                      value={secondaryKind === 'bio' ? secondaryBioDraft : secondaryMonologueDraft}
                      onValueChange={secondaryKind === 'bio' ? setSecondaryBioDraft : setSecondaryMonologueDraft}
                      placeholder={t('workflow.character.secondary.empty', '尚未生成，点击“生成”即可')}
                      classNames={{
                        base: "w-full h-full",
                        inputWrapper: "h-full !bg-transparent !shadow-none hover:!bg-transparent focus-within:!bg-transparent data-[hover=true]:!bg-transparent group-data-[focus=true]:!bg-transparent !ring-0 !ring-offset-0 !outline-none !border-none p-8 !rounded-none",
                        input: "h-full !text-base !leading-[1.8] text-foreground/80 font-serif !pr-4 !outline-none !ring-0 focus:!ring-0 placeholder:text-foreground/30 caret-primary"
                      }}
                    />
                  </CardBody>
                  {/* Fullscreen Button */}
                  {((secondaryKind === 'bio' ? secondaryBioDraft : secondaryMonologueDraft).trim()) && (
                    <div className="absolute top-4 right-4 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                      <FullscreenResultViewer
                        content={secondaryKind === 'bio' ? secondaryBioDraft : secondaryMonologueDraft}
                        kind="text"
                        title={[
                          fullscreenBaseTitle,
                          selectedCharacterName,
                          secondaryKind === 'bio'
                            ? t('workflow.character.secondary.bio', '人物志')
                            : t('workflow.character.secondary.monologue', '心理独白')
                        ].filter(Boolean).join(' · ')}
                        onSave={(newContent) => {
                          if (secondaryKind === 'bio') {
                            setSecondaryBioDraft(newContent)
                          } else {
                            setSecondaryMonologueDraft(newContent)
                          }
                        }}
                      />
                    </div>
                  )}
                </Card>
              </div>
            )
          ) : (
            <GlassContainer className="py-12 text-center text-foreground/60">
              {isCharacterListLoading
                ? t('workflow.character.result.loadingCharacters', '正在读取人物列表...')
                : t('workflow.character.result.noCharacters', '未找到人物 TXT')}
            </GlassContainer>
          )}
        </WorkflowLayout>
      )
    } else if (step === 'tts') {
      stepContent = (
        <WorkflowLayout
          nav={
            <>
              <CircularNavButton
                direction="left"
                tooltip={t('workflow.character.stage3.prev', '上一步')}
                onPress={handleBackToSecondaryStep}
              />
              <CircularNavButton
                direction="right"
                tooltip={t('workflow.tts.generate', '开始生成')}
                icon={<Mic size={28} />}
                onPress={handleGenerateTts}
                isDisabled={isTtsGenerating || (ttsSourceKind === 'bio' ? !secondaryBioText : !secondaryMonologueText)}
                isLoading={isTtsGenerating}
                color="primary"
              />
            </>
          }
        >
          <StepHeader
            title={t('workflow.character.stage3.actions', '生成语音 (mp3)')}
            hint={t('workflow.character.stage3.actionsHint', '仅展示音频参数与来源选择，不展示具体内容')}
          />

          <GlassContainer className="space-y-8">
            <div className="space-y-6">
              <Select
                label={t('workflow.tts.selectSource', '选择来源')}
                selectedKeys={[ttsSourceKind]}
                onChange={(e) => e.target.value && setTtsSourceKind(e.target.value as 'bio' | 'monologue')}
                variant="bordered"
                disallowEmptySelection
                classNames={{
                  trigger: "bg-content1/50 border-default-200/50 hover:bg-content1/80 transition-colors h-14",
                  value: "text-base"
                }}
                popoverProps={{
                  portalContainer: popoverPortalContainer,
                  classNames: { content: 'z-[200]' }
                }}
              >
                <SelectItem key="bio" isDisabled={!secondaryBioText}>
                  {t('workflow.character.secondary.bio', '人物志')}
                </SelectItem>
                <SelectItem key="monologue" isDisabled={!secondaryMonologueText}>
                  {t('workflow.character.secondary.monologue', '心理独白')}
                </SelectItem>
              </Select>

              <Select
                label={t('workflow.tts.voice', '选择语音')}
                selectedKeys={[ttsVoice]}
                onChange={(e) => setTtsVoice(e.target.value)}
                variant="bordered"
                classNames={{
                  trigger: "bg-content1/50 border-default-200/50 hover:bg-content1/80 transition-colors h-14",
                  value: "text-base"
                }}
                popoverProps={{
                  portalContainer: popoverPortalContainer,
                  classNames: { content: 'z-[200]' }
                }}
              >
                {ttsVoices.map((v) => (
                  <SelectItem key={v.value}>
                    {v.label}
                  </SelectItem>
                ))}
              </Select>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t('workflow.tts.rate', '语速 (Rate)')}
                  value={ttsRate}
                  onValueChange={setTtsRate}
                  placeholder="+0%"
                  variant="bordered"
                  classNames={{
                    inputWrapper: "bg-content1/50 border-default-200/50 hover:bg-content1/80 transition-colors h-14"
                  }}
                />
                <Input
                  label={t('workflow.tts.pitch', '音调 (Pitch)')}
                  value={ttsPitch}
                  onValueChange={setTtsPitch}
                  placeholder="+0Hz"
                  variant="bordered"
                  classNames={{
                    inputWrapper: "bg-content1/50 border-default-200/50 hover:bg-content1/80 transition-colors h-14"
                  }}
                />
              </div>

              <Input
                label={t('workflow.tts.volume', '音量 (Volume)')}
                value={ttsVolume}
                onValueChange={setTtsVolume}
                placeholder="+0%"
                variant="bordered"
                classNames={{
                  inputWrapper: "bg-content1/50 border-default-200/50 hover:bg-content1/80 transition-colors h-14"
                }}
              />
            </div>
          </GlassContainer>
        </WorkflowLayout>
      )
    } else {
      // Done Step
      stepContent = (
        <WorkflowLayout>
          <StepHeader
            title={t('workflow.character.stage4.title', '最终结果：语音')}
            hint={t('workflow.character.stage4.hint', '已生成 mp3，可直接播放')}
          />

          <GlassContainer className="bg-success-50/50 border-success-200/50">
             <div className="flex items-center justify-center gap-2 text-success-700 font-medium mb-6">
               <Play size={20} />
               {t('workflow.tts.result', '生成结果')}
             </div>

             {ttsAudioUrl ? (
               <audio controls src={ttsAudioUrl} className="w-full mb-8" />
             ) : (
               <div className="text-sm text-foreground/50 text-center mb-8">
                 {t('workflow.tts.noAudioPreview', '音频已生成，但预览加载失败；可打开文件位置播放')}
               </div>
             )}

             <div className="flex items-center justify-center gap-4">
               <Button
                 variant="shadow"
                 color="success"
                 startContent={<Download size={18} />}
                 isDisabled={!ttsAudioPath}
                 onPress={handleOpenAudioFile}
                 className="font-medium text-white shadow-success/20"
               >
                 {t('workflow.tts.openFile', '打开文件位置')}
               </Button>
               <Button variant="bordered" onPress={() => setStep('tts')}>
                 {t('workflow.tts.regenerate', '重新生成语音')}
               </Button>
             </div>
          </GlassContainer>
        </WorkflowLayout>
      )
    }
  } else {
    // Config step (default)
    stepContent = (
      <div className="flex flex-col h-full w-full bg-background relative">
        {/* Header - Back button only */}
        <div
          className="flex items-center gap-4 px-6 py-4 relative z-10"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <Button isIconOnly variant="light" onPress={() => navigate('/')} className="[-webkit-app-region:no-drag]">
            <ArrowLeft size={20} />
          </Button>
        </div>

        {/* Content - Scrollable area */}
        <div className="flex-1 flex flex-col items-center overflow-y-auto px-6 py-12">
          <div className="w-full max-w-2xl space-y-12 my-auto pb-20">
            {/* Header Section */}
            <div className="text-center space-y-6">
              <h1 className="text-4xl font-serif font-medium text-foreground">
                {t('workflow.character.title', '生成人物志')}
              </h1>
              <div className="space-y-2">
                <p className="text-lg text-foreground/60 font-serif">
                  {t('workflow.character.configHint', '选择模型和小说文件，开始提取人物信息')}
                </p>
                <p className="text-xs text-foreground/30 font-mono tracking-wide uppercase">
                  {t('workflow.character.settings', '分块方式: 按章节 | 目标字数: ~15万字/块')}
                </p>
              </div>
            </div>

            {/* Selection Area - Glass Container */}
            <div className="space-y-8 p-8 bg-content2/30 rounded-3xl border border-white/5 backdrop-blur-sm">
              <ModelSelector selectedModel={selectedModel} onModelSelect={setSelectedModel} />
              <NovelPicker selectedFile={selectedFile} onFileSelect={setSelectedFile} />

              {/* Target character mode */}
              <div className="w-full">
                <label className="text-sm font-medium text-foreground/70 mb-2 block">
                  {t('workflow.character.targetMode', '指定人物（可选）')}
                </label>
                <Card className="w-full bg-content1/50 border border-white/5 shadow-sm">
                  <CardBody className="p-4 space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground/80">
                            {t('workflow.character.targetModeLabel', '仅分析指定人物')}
                          </span>
                          <Tooltip content={t('workflow.character.targetModeTip', '只分析指定人物的剧情')}>
                            <span className="inline-flex items-center text-foreground/40 cursor-help">
                              <Info size={14} />
                            </span>
                          </Tooltip>
                        </div>
                        <p className="text-xs text-foreground/50">
                          {t('workflow.character.targetModeHint', '开启后需要填写人物名称，否则无法开始任务')}
                        </p>
                      </div>
                      <Switch
                        size="sm"
                        isSelected={isTargetCharacterModeEnabled}
                        onValueChange={(checked) => {
                          setIsTargetCharacterModeEnabled(checked)
                          if (!checked) {
                            setNewCharacterName('')
                          }
                        }}
                      />
                    </div>

                    {isTargetCharacterModeEnabled && (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <Input
                            size="sm"
                            value={newCharacterName}
                            onValueChange={setNewCharacterName}
                            placeholder={t('workflow.character.targetPlaceholder', '输入人物名称')}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleAddCharacter()
                            }}
                            classNames={{
                              inputWrapper: "bg-content2/50 hover:bg-content2/70 focus-within:bg-content2/70"
                            }}
                            className="flex-1"
                          />
                          <Button
                            size="sm"
                            variant="flat"
                            className="h-10"
                            startContent={<Plus size={14} />}
                            onPress={handleAddCharacter}
                            isDisabled={!newCharacterName.trim()}
                          >
                            {t('workflow.character.targetAdd', '添加')}
                          </Button>
                        </div>

                        {targetCharacters.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {targetCharacters.map((char, index) => (
                              <Chip key={`${char}-${index}`} onClose={() => handleRemoveCharacter(index)} size="sm" variant="flat">
                                {char}
                              </Chip>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-foreground/40">
                            {t('workflow.character.targetEmpty', '请添加要分析的人物')}
                          </div>
                        )}
                      </div>
                    )}
                  </CardBody>
                </Card>
              </div>
            </div>
          </div>
        </div>

        <Tooltip content={t('workflow.config.start', '确认开始')} placement="left">
          <Button
            isIconOnly
            radius="full"
            color="primary"
            size="lg"
            className="absolute right-8 top-1/2 -translate-y-1/2 h-16 w-16 z-20 shadow-xl bg-foreground text-background hover:bg-foreground/90 transition-transform hover:scale-105"
            onPress={handleStart}
            isDisabled={!canStart || isStarting}
            isLoading={isStarting}
            aria-label={t('workflow.config.start', '确认开始')}
          >
            {!isStarting && <ArrowRight size={28} />}
          </Button>
        </Tooltip>
      </div>
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

export default CharacterWorkflow
