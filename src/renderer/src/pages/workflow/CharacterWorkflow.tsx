import {
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Progress,
  Select,
  SelectItem,
  Switch,
  Tab,
  Tabs,
  Textarea,
  Tooltip
} from '@heroui/react'
import { getActualProvider, providerToAiSdkConfig } from '@renderer/aiCore/provider/providerConfig'
import { isBasicEdition } from '@renderer/config/edition'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  clearActiveSession,
  clearCompletedSession,
  completeSession,
  setActiveSession,
  updateSessionOutputDir,
  updateSessionProgress
} from '@renderer/store/workflow'
import type { Model } from '@shared/types'
import { ArrowLeft, ArrowRight, Download, Info, Loader2, Mic, Play, Plus, Sparkles } from 'lucide-react'
import { FC, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { useLocalStorageState } from '@renderer/hooks/useLocalStorageState'
import { useRuntime } from '@renderer/hooks/useRuntime'

import DragBar from './components/DragBar'
import FullscreenResultViewer from './components/FullscreenResultViewer'
import ModelSelector from './components/ModelSelector'
import NovelPicker, { SelectedFile } from './components/NovelPicker'
import ProgressDisplay from './components/ProgressDisplay'
import TtsVoiceConfigCard from './components/TtsVoiceConfigCard'
import { getLocaleLabelZh } from './components/ttsLabels'
import WorkflowStepMotion from './components/WorkflowStepMotion'
import { estimateProgressPercent, estimateSecondsFromChars } from './utils/estimateTime'

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

type VoiceRaw = {
  name?: string
  display_name?: string
  local_name?: string
  short_name?: string
  gender?: string
  locale?: string
  locale_name?: string
  style_list?: string[]
  sample_rate_hertz?: string
}

type VoiceListResult = {
  locales: Array<{
    locale: string
    voices: VoiceRaw[]
  }>
}

type VoiceStylesResult = {
  styles?: string[]
}

type AdvancedTTSProvider = 'microsoft' | 'zai'

type VoiceItem = {
  shortName: string
  displayName: string
  localName?: string
  gender?: string
  locale?: string
  localeName?: string
  styleList?: string[]
}

type TtsPreviewCacheItem = {
  filePath: string
  mime: string
  createdAt: number
  signature: string
}

const formatSigned = (value: number) => `${value >= 0 ? '+' : ''}${value}`
const formatSignedPercent = (value: number) => `${value >= 0 ? '+' : ''}${value}%`

const PREF_KEY_PREFIX = 'tts.voicePrefs.v1'
const PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PREVIEW_CACHE_MAX_ITEMS = 20

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isAdvancedProvider = (value: unknown): value is AdvancedTTSProvider => value === 'microsoft' || value === 'zai'

const getGenderKey = (gender?: string) => {
  const normalized = gender?.toLowerCase()
  if (normalized?.startsWith('f')) return 'female'
  if (normalized?.startsWith('m')) return 'male'
  return 'unknown'
}

const getGenderLabel = (gender?: string) => {
  const key = getGenderKey(gender)
  if (key === 'female') return '女声'
  if (key === 'male') return '男声'
  return '未知'
}

const getLanguageLabel = (code: string) => {
  try {
    const display = new Intl.DisplayNames(['zh-CN'], { type: 'language' })
    return display.of(code) ?? code
  } catch {
    return code
  }
}

// --- Reusable UI Components ---

const WorkflowLayout: FC<{ children: ReactNode; nav?: ReactNode; className?: string }> = ({
  children,
  nav,
  className
}) => (
  <div className={`group relative flex h-full w-full flex-col bg-background ${className || ''}`}>
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-12 md:px-20 lg:px-32">
      <div className="my-auto w-full max-w-4xl space-y-10 pb-20">{children}</div>
    </div>
    {nav}
  </div>
)

const StepHeader: FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="space-y-6 text-center">
    <h1 className="font-medium font-serif text-4xl text-foreground">{title}</h1>
    {hint && <p className="font-serif text-foreground/60 text-lg">{hint}</p>}
  </div>
)

const GlassContainer: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
  <div className={`rounded-3xl border border-white/5 bg-content2/30 p-8 backdrop-blur-sm ${className || ''}`}>
    {children}
  </div>
)

const CircularNavButton: FC<{
  direction: 'left' | 'right'
  onPress: () => void | Promise<void>
  isDisabled?: boolean
  isLoading?: boolean
  tooltip: string
  icon?: ReactNode
  color?: 'primary' | 'light'
  className?: string
}> = ({ direction, onPress, isDisabled, isLoading, tooltip, icon, color = 'light', className }) => (
  <Tooltip content={tooltip} placement={direction === 'left' ? 'right' : 'left'}>
    <Button
      isIconOnly
      radius="full"
      variant={color === 'light' ? 'light' : 'solid'}
      color={color === 'primary' ? 'primary' : 'default'}
      size="lg"
      className={`absolute ${direction === 'left' ? 'left-10' : 'right-10'} -translate-y-1/2 top-1/2 z-50 h-16 w-16 ${
        color === 'light' ? 'text-foreground/50 hover:bg-content2/50 hover:text-foreground' : 'shadow-xl'
      } transition-all hover:scale-105 ${className || ''}`}
      onPress={onPress}
      isDisabled={isDisabled}
      isLoading={isLoading}>
      {!isLoading && (icon || (direction === 'left' ? <ArrowLeft size={28} /> : <ArrowRight size={28} />))}
    </Button>
  </Tooltip>
)

const CharacterWorkflow: FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [searchParams] = useSearchParams()
  const { edition } = useRuntime()
  const allowAdvanced = !isBasicEdition(edition)

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
  const [isStarting, setIsStarting] = useState(false) // 防重复提交

  // 人物 TXT 合集（用于"非指定人物模式"的结果展示）
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

  // 阶段内进度条（用于二次总结/语音生成）
  const [stageProgress, setStageProgress] = useState<ProcessingState | null>(null)

  // 提取阶段：伪进度 + 计时 + dots 动画
  const [extractPseudoPercentage, setExtractPseudoPercentage] = useState(0)
  const [extractElapsedSeconds, setExtractElapsedSeconds] = useState(0)
  const [extractDotCount, setExtractDotCount] = useState(1)
  const extractStartMsRef = useRef(0)
  const extractPseudoTimerRef = useRef<number | null>(null)
  const extractElapsedTimerRef = useRef<number | null>(null)
  const extractDotsTimerRef = useRef<number | null>(null)
  const extractCompleteTimeoutRef = useRef<number | null>(null)

  // 二次总结可编辑草稿（来自落盘文件；保存时写回文件）
  const [secondaryBioDraft, setSecondaryBioDraft] = useState<string>('')
  const [secondaryMonologueDraft, setSecondaryMonologueDraft] = useState<string>('')

  // 二次总结编辑的"脏状态"：避免切换 Tab/步骤时被磁盘内容覆盖
  const secondaryDraftKeyRef = useRef<string | null>(null)
  const secondaryDraftDirtyRef = useRef<{ bio: boolean; monologue: boolean }>({ bio: false, monologue: false })

  const setSecondaryDraft = useCallback((kind: SecondaryKind, value: string) => {
    if (kind === 'bio') {
      setSecondaryBioDraft(value)
      setSecondaryBioText(value.trim() ? value : null)
      secondaryDraftDirtyRef.current.bio = true
      return
    }

    setSecondaryMonologueDraft(value)
    setSecondaryMonologueText(value.trim() ? value : null)
    secondaryDraftDirtyRef.current.monologue = true
  }, [])

  // 语音生成（第三阶段）
  const [ttsMode, setTtsMode] = useState<'normal' | 'advanced'>(allowAdvanced ? 'normal' : 'normal')
  const [ttsSourceKind, setTtsSourceKind] = useState<'bio' | 'monologue'>('bio')
  const [normalVoiceLocales, setNormalVoiceLocales] = useState<VoiceListResult['locales']>([])
  const [advancedVoiceLocales, setAdvancedVoiceLocales] = useState<VoiceListResult['locales']>([])
  const [isLoadingNormalVoices, setIsLoadingNormalVoices] = useState(false)
  const [normalVoiceLoadError, setNormalVoiceLoadError] = useState<string | null>(null)
  const [isLoadingAdvancedVoices, setIsLoadingAdvancedVoices] = useState(false)
  const [advancedVoiceLoadError, setAdvancedVoiceLoadError] = useState<string | null>(null)

  const [advancedProvider, setAdvancedProvider] = useLocalStorageState<AdvancedTTSProvider>(
    `${PREF_KEY_PREFIX}.advanced.provider`,
    'microsoft',
    isAdvancedProvider
  )

  const isLoadingVoices =
    ttsMode === 'advanced'
      ? advancedProvider === 'microsoft'
        ? isLoadingAdvancedVoices
        : false
      : isLoadingNormalVoices
  const voiceLoadError =
    ttsMode === 'advanced'
      ? advancedProvider === 'microsoft'
        ? advancedVoiceLoadError
        : null
      : normalVoiceLoadError
  const [ttsVoice, setTtsVoice] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.normal.voice`,
    'zh-CN-XiaoxiaoNeural',
    isNonEmptyString
  )
  const [advancedTtsVoice, setAdvancedTtsVoice] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.advanced.voice`,
    'zh-CN-XiaoxiaoMultilingualNeural',
    isNonEmptyString
  )
  const [advancedTtsStyle, setAdvancedTtsStyle] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.advanced.style`,
    'general',
    isNonEmptyString
  )
  const [advancedZaiVoice, setAdvancedZaiVoice] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.advanced.zai.voice`,
    'system_001',
    isNonEmptyString
  )
  const [styleOptions, setStyleOptions] = useState<string[]>([])
  const [isLoadingStyles, setIsLoadingStyles] = useState(false)
  const [ttsRateValue, setTtsRateValue] = useState(0)
  const [ttsPitchValue, setTtsPitchValue] = useState(0)
  const [advancedTtsRateValue, setAdvancedTtsRateValue] = useState(0)
  const [advancedTtsPitchValue, setAdvancedTtsPitchValue] = useState(0)
  // 默认：中文 + 区域全部 + 性别全部（普通版/高级版一致）
  const [languageFilter, setLanguageFilter] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.filter.language`,
    'zh',
    isNonEmptyString
  )
  const [regionFilter, setRegionFilter] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.filter.region`,
    'all',
    isNonEmptyString
  )
  const [genderFilter, setGenderFilter] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.filter.gender`,
    'all',
    isNonEmptyString
  )
  const [isTtsGenerating, setIsTtsGenerating] = useState(false)
  const [isTtsPreviewing, setIsTtsPreviewing] = useState(false)
  const [ttsAudioPath, setTtsAudioPath] = useState<string | null>(null)
  const [ttsAudioUrl, setTtsAudioUrl] = useState<string | null>(null)
  const [ttsAudioMime, setTtsAudioMime] = useState('audio/mpeg')
  const ttsGenerationTokenRef = useRef(0)

  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewAudioContextRef = useRef<AudioContext | null>(null)
  const previewAudioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const previewCacheRef = useRef<Map<string, TtsPreviewCacheItem>>(new Map())
  const previewInFlightRef = useRef<Map<string, Promise<TtsPreviewCacheItem>>>(new Map())
  const previewTokenRef = useRef(0)

  const isTtsBusy = isTtsGenerating || isTtsPreviewing

  const activeVoice =
    ttsMode === 'advanced'
      ? advancedProvider === 'zai'
        ? advancedZaiVoice
        : advancedTtsVoice
      : ttsVoice

  const setActiveVoice = useCallback(
    (value: string) => {
      if (ttsMode === 'advanced') {
        if (advancedProvider === 'zai') {
          setAdvancedZaiVoice(value)
        } else {
          setAdvancedTtsVoice(value)
        }
        return
      }
      setTtsVoice(value)
    },
    [advancedProvider, ttsMode]
  )

  const advancedVoices = useMemo<VoiceItem[]>(() => {
    const items: VoiceItem[] = []
    for (const group of advancedVoiceLocales) {
      for (const raw of group.voices ?? []) {
        const shortName = raw.short_name?.trim() || raw.name?.trim()
        if (!shortName) continue
        items.push({
          shortName,
          displayName: raw.display_name || raw.local_name || shortName,
          localName: raw.local_name,
          gender: raw.gender,
          locale: raw.locale || group.locale,
          localeName: raw.locale_name,
          styleList: raw.style_list
        })
      }
    }
    return items
  }, [advancedVoiceLocales])

  const normalVoices = useMemo<VoiceItem[]>(() => {
    const items: VoiceItem[] = []
    for (const group of normalVoiceLocales) {
      for (const raw of group.voices ?? []) {
        const shortName = raw.short_name?.trim() || raw.name?.trim()
        if (!shortName) continue
        items.push({
          shortName,
          displayName: raw.display_name || raw.local_name || shortName,
          localName: raw.local_name,
          gender: raw.gender,
          locale: raw.locale || group.locale,
          localeName: raw.locale_name
        })
      }
    }
    return items
  }, [normalVoiceLocales])

  const voicesForMode = useMemo(() => {
    // 普通版与高级版数据源完全解耦：普通版来自 EdgeTTS 在线 voices；高级版来自 tts.exe --list-voices
    return ttsMode === 'advanced' ? advancedVoices : normalVoices
  }, [advancedVoices, normalVoices, ttsMode])

  const localesForMode = useMemo(() => {
    return ttsMode === 'advanced' ? advancedVoiceLocales : normalVoiceLocales
  }, [advancedVoiceLocales, normalVoiceLocales, ttsMode])

  const advancedVoiceMap = useMemo(() => {
    return new Map(advancedVoices.map((v) => [v.shortName, v]))
  }, [advancedVoices])

  useEffect(() => {
    let isMounted = true
    const loadAdvancedVoices = async () => {
      if (!allowAdvanced) return
      if (advancedProvider !== 'microsoft') return
      setIsLoadingAdvancedVoices(true)
      setAdvancedVoiceLoadError(null)
      try {
        const result = await window.api.advancedTTS.listVoices()
        const locales = (result as VoiceListResult)?.locales ?? []
        if (!isMounted) return
        setAdvancedVoiceLocales(locales)
      } catch (error) {
        if (!isMounted) return
        setAdvancedVoiceLoadError((error as Error).message)
        window.toast?.error?.(t('workflow.tts.voiceLoadFailed', '语音模型加载失败'))
      } finally {
        if (isMounted) {
          setIsLoadingAdvancedVoices(false)
        }
      }
    }

    void loadAdvancedVoices()
    return () => {
      isMounted = false
    }
  }, [advancedProvider, allowAdvanced, t])

  useEffect(() => {
    let isMounted = true
    const loadNormalVoices = async () => {
      setIsLoadingNormalVoices(true)
      setNormalVoiceLoadError(null)
      try {
        const result = await window.api.edgeTTS.listVoices()
        if (!isMounted) return
        const locales = (result as VoiceListResult)?.locales ?? []
        setNormalVoiceLocales(locales)
      } catch (error) {
        if (!isMounted) return
        setNormalVoiceLoadError((error as Error).message)
        window.toast?.error?.(t('workflow.tts.voiceLoadFailed', '语音模型加载失败'))
      } finally {
        if (isMounted) {
          setIsLoadingNormalVoices(false)
        }
      }
    }

    void loadNormalVoices()
    return () => {
      isMounted = false
    }
  }, [t])

  useEffect(() => {
    if (normalVoices.length > 0) {
      const hasVoice = normalVoices.some((item) => item.shortName === ttsVoice)
      if (!hasVoice) {
        setTtsVoice(normalVoices[0].shortName)
      }
    }

    if (advancedVoices.length > 0) {
      const hasAdvancedVoice = advancedVoices.some((item) => item.shortName === advancedTtsVoice)
      if (!hasAdvancedVoice) {
        setAdvancedTtsVoice(advancedVoices[0].shortName)
      }
    }
  }, [advancedTtsVoice, advancedVoices, normalVoices, ttsVoice])

  useEffect(() => {
    // 当语言筛选变化后，如果当前"区域"不再匹配语言，则自动回退为"全部"，避免出现空列表/跳动。
    if (languageFilter === 'all') return
    if (regionFilter === 'all') return
    if (!regionFilter.toLowerCase().startsWith(`${languageFilter.toLowerCase()}-`)) {
      setRegionFilter('all')
    }
  }, [languageFilter, regionFilter])

  useEffect(() => {
    // 如果先选了"区域"，则同步语言筛选（仅在语言为"全部"时），保证筛选条件一致。
    if (regionFilter === 'all') return
    if (languageFilter !== 'all') return
    const nextLanguage = regionFilter.split('-')[0]
    if (nextLanguage) {
      setLanguageFilter(nextLanguage)
    }
  }, [languageFilter, regionFilter])

  const languageOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of localesForMode) {
      const languageCode = group.locale?.split('-')[0]
      if (!languageCode || map.has(languageCode)) continue
      map.set(languageCode, getLanguageLabel(languageCode))
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
  }, [localesForMode])

  const regionOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of localesForMode) {
      const locale = group.locale
      if (!locale) continue
      if (languageFilter !== 'all' && !locale.toLowerCase().startsWith(`${languageFilter.toLowerCase()}-`)) continue
      if (map.has(locale)) continue
      map.set(locale, getLocaleLabelZh(locale))
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
  }, [languageFilter, localesForMode])

  const genderOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of localesForMode) {
      for (const voice of group.voices ?? []) {
        const key = getGenderKey(voice.gender)
        if (map.has(key)) continue
        map.set(key, getGenderLabel(voice.gender))
      }
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
  }, [localesForMode])

  const languageSelectItems = useMemo(() => {
    const base = [
      { value: 'all', label: t('workflow.tts.all', '全部') },
      { value: 'zh', label: getLanguageLabel('zh') }
    ]
    const extra = languageOptions.filter((item) => item.value !== 'zh')
    return [...base, ...extra]
  }, [languageOptions, t])

  const regionSelectItems = useMemo(() => {
    return [{ value: 'all', label: t('workflow.tts.all', '全部') }, ...regionOptions]
  }, [regionOptions, t])

  const genderSelectItems = useMemo(() => {
    return [{ value: 'all', label: t('workflow.tts.all', '全部') }, ...genderOptions]
  }, [genderOptions, t])

  const filteredVoices = useMemo(() => {
    return voicesForMode.filter((item) => {
      if (languageFilter !== 'all') {
        if (!item.locale?.toLowerCase().startsWith(`${languageFilter.toLowerCase()}-`)) return false
      }
      if (regionFilter !== 'all') {
        if (item.locale !== regionFilter) return false
      }
      if (genderFilter !== 'all') {
        if (getGenderKey(item.gender) !== genderFilter) return false
      }
      return true
    })
  }, [genderFilter, languageFilter, regionFilter, voicesForMode])

  useEffect(() => {
    if (ttsMode === 'advanced' && advancedProvider === 'zai') return
    if (filteredVoices.length === 0) return
    const isIncluded = filteredVoices.some((item) => item.shortName === activeVoice)
    if (!isIncluded) {
      setActiveVoice(filteredVoices[0].shortName)
    }
  }, [activeVoice, advancedProvider, filteredVoices, setActiveVoice, ttsMode])

  useEffect(() => {
    let isMounted = true
    const fetchStyles = async () => {
      if (ttsMode !== 'advanced') return
      if (!allowAdvanced) return
      if (advancedProvider !== 'microsoft') return
      if (!advancedTtsVoice) return
      if (!advancedVoiceMap.get(advancedTtsVoice)) {
        setStyleOptions([])
        if (!advancedTtsStyle) {
          setAdvancedTtsStyle('general')
        }
        return
      }
      setIsLoadingStyles(true)
      try {
        const result = await window.api.advancedTTS.getVoiceStyles(advancedTtsVoice)
        if (!isMounted) return
        const styles = (result as VoiceStylesResult)?.styles ?? []
        setStyleOptions(styles)
        if (styles.length > 0 && !styles.includes(advancedTtsStyle)) {
          setAdvancedTtsStyle(styles[0])
        } else if (styles.length === 0 && !advancedTtsStyle) {
          setAdvancedTtsStyle('general')
        }
      } catch {
        if (!isMounted) return
        const fallback = advancedVoiceMap.get(advancedTtsVoice)?.styleList ?? []
        setStyleOptions(fallback)
        if (fallback.length > 0 && !fallback.includes(advancedTtsStyle)) {
          setAdvancedTtsStyle(fallback[0])
        } else if (fallback.length === 0 && !advancedTtsStyle) {
          setAdvancedTtsStyle('general')
        }
      } finally {
        if (!isMounted) return
        setIsLoadingStyles(false)
      }
    }

    void fetchStyles()
    return () => {
      isMounted = false
    }
  }, [advancedProvider, advancedTtsStyle, advancedTtsVoice, advancedVoiceMap, ttsMode, allowAdvanced])

  const popoverPortalContainer = useMemo(() => {
    return typeof document !== 'undefined' ? document.body : undefined
  }, [])

  // Check if can start
  const canStart =
    selectedModel !== null && selectedFile !== null && (!isTargetCharacterModeEnabled || targetCharacters.length > 0)
  const estimatedTotalSeconds = estimateSecondsFromChars(activeSession?.inputCharCount ?? 0)

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
    setSecondaryBioDraft('')
    setSecondaryMonologueDraft('')
    secondaryDraftKeyRef.current = null
    secondaryDraftDirtyRef.current = { bio: false, monologue: false }
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
          const safeReadDir = async (targetDir: string): Promise<FsEntry[] | null> => {
            try {
              return (await window.api.fs.readdir(targetDir)) as FsEntry[]
            } catch {
              return null
            }
          }

          const hasMatchingFile = async (targetDir: string, namePattern: RegExp) => {
            const entries = await safeReadDir(targetDir)
            if (!entries) return false
            return entries.some((e) => e.isFile && namePattern.test(e.name ?? ''))
          }

          if (!(await safeReadDir(dir))) return 'config'

          const audioDir = await window.api.path.join(dir, 'audio')
          if (await hasMatchingFile(audioDir, /\.(mp3|wav)$/i)) return 'done'

          // 若已有"二次总结"落盘（哪怕未生成音频），说明已过第一阶段
          const bioDir = await window.api.path.join(dir, '二次总结', '人物志')
          const monologueDir = await window.api.path.join(dir, '二次总结', '心理独白')
          if ((await hasMatchingFile(bioDir, /\.txt$/i)) || (await hasMatchingFile(monologueDir, /\.txt$/i))) {
            return 'secondary'
          }

          // 第一阶段完成的强标志：人物TXT合集里出现任意 .txt 文件
          const charactersDir = await window.api.path.join(dir, '人物TXT合集')
          if (await hasMatchingFile(charactersDir, /\.txt$/i)) return 'secondary'

          // 默认回到"少女祈祷中"：避免空目录/临时目录导致误跳二次总结
          return 'extracting'
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
          const detectedStep = await detectStepByOutputDir(historyOutputDir)
          setStep(detectedStep)
          if (detectedStep === 'secondary' || detectedStep === 'tts' || detectedStep === 'done') {
            setIsCharacterListLoading(true)
          }
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
                const detectedStep = await detectStepByOutputDir(historySession.outputDir)
                setStep(detectedStep)
                if (detectedStep === 'secondary' || detectedStep === 'tts' || detectedStep === 'done') {
                  setIsCharacterListLoading(true)
                }
                setHistoryBookTitle(historySession.bookTitle)
                setIsRestoring(false)
                return
              }
            }
            // Even if file not found, still show complete state with no result
            setOutputDir(historySession.outputDir)
            const detectedStep = await detectStepByOutputDir(historySession.outputDir)
            setStep(detectedStep)
            if (detectedStep === 'secondary' || detectedStep === 'tts' || detectedStep === 'done') {
              setIsCharacterListLoading(true)
            }
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

        // 若存在 Redux active session（从主页"进行中"进入），优先使用主进程 state.outputPath
        // 避免 Redux 中 outputDir 仍是旧的 bookDir/character，导致二次总结/音频落盘目录对不上。
        if (activeSession && state?.outputPath) {
          const looksLikeFile = /\.[a-z0-9]+$/i.test(state.outputPath)
          const dir = looksLikeFile ? await window.api.path.dirname(state.outputPath) : state.outputPath

          setOutputDir(dir)
          const detectedStep = await detectStepByOutputDir(dir)
          setStep(detectedStep)

          // 当恢复到二次总结/语音/完成阶段时，预设 isCharacterListLoading = true
          // 防止 isRestoring 解除后、characterTxtFiles 异步加载完成前，页面闪现"初始视图"
          if (detectedStep === 'secondary' || detectedStep === 'tts' || detectedStep === 'done') {
            setIsCharacterListLoading(true)
          }

          // 恢复二次总结阶段的进度条：若 Redux stage 表明正在生成，重新启动进度条。
          // 生成完成后 Redux stage 会被清理为 '等待二次总结'，所以此处匹配意味着确实在生成中。
          if (detectedStep === 'secondary') {
            const reduxStage = activeSession.progress?.stage || ''
            if (reduxStage === '生成人物志' || reduxStage === '生成心理独白') {
              startStageProgress(reduxStage, activeSession.progress?.stageStartedAt)
            }
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

          if (activeSession.outputDir !== dir) {
            dispatch(updateSessionOutputDir({ type: 'character', outputDir: dir }))
          }

          return
        }

        if (state?.isProcessing) {
          // Task is running - restore to extracting step
          setStep('extracting')
          if (state.outputPath) {
            // outputPath 可能是"任务目录"或"文件路径"，做一次启发式兼容
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
            const detectedStep = dir ? await detectStepByOutputDir(dir) : 'config'
            setStep(detectedStep)
            // 同上：预设加载状态，防止闪现初始视图
            if (detectedStep === 'secondary' || detectedStep === 'tts' || detectedStep === 'done') {
              setIsCharacterListLoading(true)
            }
            // 恢复二次总结阶段的进度条（同上）
            if (detectedStep === 'secondary' && dir) {
              const reduxStage = activeSession.progress?.stage || ''
              if (reduxStage === '生成人物志' || reduxStage === '生成心理独白') {
                startStageProgress(reduxStage, activeSession.progress?.stageStartedAt)
              }
              }
            }
            if (activeSession.progress) {
              setProgress(activeSession.progress)
            }
          } else if (activeSession.status === 'complete') {
            // 已完成任务：从 Launcher 再进入时应当开始新任务；旧结果请通过历史记录访问。
            // （人物志整体以 mp3 落盘为完成标志，避免在这里恢复旧目录导致"查看页/新任务"语义混乱。）
            dispatch(clearActiveSession('character'))
          }
        }
        // Note: Don't restore completed state from main process when entering from launcher
        // User wants to start a new task, not view old results
        // Old results can be accessed via history with sessionId parameter
      } catch (error) {
        console.error('Failed to restore state:', error)
      } finally {
        hasRestoredRef.current = true // 标记已完成恢复
        setIsRestoring(false)
      }
    }

    restoreState()
  }, [historySessionId, historyOutputDir]) // 仅在路由参数变化时恢复

  const selectedCharacterFile = characterTxtFiles.find((f) => f.path === selectedCharacterPath) ?? null
  const selectedCharacterName = selectedCharacterFile?.name?.replace(/\.txt$/i, '') ?? null

  // stageProgressRef 用于轮询 effect 中避免 stageProgress 频繁更新导致 effect 重运行
  const stageProgressRef = useRef(stageProgress)
  stageProgressRef.current = stageProgress

  // 二次总结/语音阶段：从"人物TXT合集"读取人物列表（文件系统即真相）
  const shouldUseCharacterTxtFolder = (step === 'secondary' || step === 'tts' || step === 'done') && !!outputDir
  const hasSecondaryOutput = Boolean(secondaryBioDraft.trim()) || Boolean(secondaryMonologueDraft.trim())

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

  const getSecondaryFilePath = useCallback(
    async (kind: SecondaryKind): Promise<string | null> => {
      if (!outputDir || !selectedCharacterName) return null
      const kindDirName = kind === 'bio' ? '人物志' : '心理独白'
      const safeStem = sanitizeSecondaryFileStem(selectedCharacterName)
      return await window.api.path.join(outputDir, '二次总结', kindDirName, `${safeStem}.txt`)
    },
    [outputDir, sanitizeSecondaryFileStem, selectedCharacterName]
  )

  const persistSecondaryDraftToDisk = useCallback(
    async (kind: SecondaryKind, value: string) => {
      const filePath = await getSecondaryFilePath(kind)
      if (!filePath) return

      const dirPath = await window.api.path.dirname(filePath)
      await window.api.file.mkdir(dirPath)
      await window.api.file.write(filePath, value)

      const normalized = value.trim() ? value : null
      if (kind === 'bio') {
        setSecondaryBioText(normalized)
        setSecondaryBioDraft(normalized ?? '')
        secondaryDraftDirtyRef.current.bio = false
      } else {
        setSecondaryMonologueText(normalized)
        setSecondaryMonologueDraft(normalized ?? '')
        secondaryDraftDirtyRef.current.monologue = false
      }
    },
    [getSecondaryFilePath]
  )

  const findAnyAudioFile = useCallback(async (): Promise<string | null> => {
    if (!outputDir) return null
    try {
      const audioDir = await window.api.path.join(outputDir, 'audio')
      const entries = (await window.api.fs.readdir(audioDir)) as FsEntry[]
      const audios = entries
        .filter((e) => e.isFile && /\.(mp3|wav)$/i.test(e.name ?? ''))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      return audios[0]?.path ?? null
    } catch {
      return null
    }
  }, [outputDir])

  const toFileUrl = useCallback((filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/')

    // Windows absolute path: C:/...
    if (/^[a-zA-Z]:\//.test(normalized)) {
      return `file:///${encodeURI(normalized)}`
    }

    // POSIX absolute path: /...
    if (normalized.startsWith('/')) {
      return `file://${encodeURI(normalized)}`
    }

    // Fallback (shouldn't happen)
    return `file:///${encodeURI(normalized)}`
  }, [])

  const loadAudioByPath = useCallback(async (audioPath: string) => {
    const mime = audioPath.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
    try {
      const base64 = await window.api.fs.read(audioPath, 'base64')
      const url = `data:${mime};base64,${base64}`
      setTtsAudioPath(audioPath)
      setTtsAudioUrl(url)
      setTtsAudioMime(mime)
      return audioPath
    } catch {
      setTtsAudioPath(audioPath)
      setTtsAudioUrl(null)
      setTtsAudioMime(mime)
      return audioPath
    }
  }, [])

  const loadSecondaryFromDisk = useCallback(
    async (kind: SecondaryKind) => {
      const setLoading = kind === 'bio' ? setIsSecondaryBioLoading : setIsSecondaryMonologueLoading

      // 立即设置 loading 标志（同步，在任何 await 之前），
      // 保证 isSecondaryInitial 在同一渲染帧中为 false，避免"初始视图"闪现。
      setLoading(true)

      const key = outputDir && selectedCharacterPath ? `${outputDir}::${selectedCharacterPath}` : null
      if (key && secondaryDraftKeyRef.current !== key) {
        secondaryDraftKeyRef.current = key
        secondaryDraftDirtyRef.current = { bio: false, monologue: false }
      }

      // 若用户正在编辑当前 kind，则不要用磁盘内容覆盖编辑中的草稿
      if (secondaryDraftDirtyRef.current[kind]) {
        setLoading(false)
        return
      }

      const filePath = await getSecondaryFilePath(kind)
      if (!filePath) {
        if (kind === 'bio') setSecondaryBioText(null)
        else setSecondaryMonologueText(null)
        if (kind === 'bio') setSecondaryBioDraft('')
        else setSecondaryMonologueDraft('')
        secondaryDraftDirtyRef.current[kind] = false
        setLoading(false)
        return
      }

      const setText = kind === 'bio' ? setSecondaryBioText : setSecondaryMonologueText
      const setDraft = kind === 'bio' ? setSecondaryBioDraft : setSecondaryMonologueDraft

      try {
        const content = await window.api.fs.readText(filePath)
        const normalized = content?.trim() ? content : null
        setText(normalized)
        setDraft(normalized ?? '')
        secondaryDraftDirtyRef.current[kind] = false
      } catch {
        setText(null)
        setDraft('')
        secondaryDraftDirtyRef.current[kind] = false
      } finally {
        setLoading(false)
      }
    },
    [getSecondaryFilePath, outputDir, selectedCharacterPath]
  )

  const secondaryAutoLoadKeyRef = useRef<string | null>(null)

  // 二次总结/语音阶段：人物切换时，自动读取二次总结结果（不存在则保持为空）
  useEffect(() => {
    if (!(step === 'secondary' || step === 'tts' || step === 'done')) return
    if (!selectedCharacterName || !selectedCharacterPath || !outputDir) {
      setSecondaryBioText(null)
      setSecondaryMonologueText(null)
      setSecondaryBioDraft('')
      setSecondaryMonologueDraft('')
      secondaryDraftKeyRef.current = null
      secondaryDraftDirtyRef.current = { bio: false, monologue: false }
      setIsSecondaryBioLoading(false)
      setIsSecondaryMonologueLoading(false)
      secondaryAutoLoadKeyRef.current = null
      return
    }

    const key = `${outputDir}::${selectedCharacterPath}`
    const isCharacterChanged = secondaryAutoLoadKeyRef.current !== key
    secondaryAutoLoadKeyRef.current = key

    // 仅在"人物/任务目录"变化时清空，避免从第三阶段返回时闪白
    if (isCharacterChanged) {
      setSecondaryBioText(null)
      setSecondaryMonologueText(null)
      setSecondaryBioDraft('')
      setSecondaryMonologueDraft('')
      secondaryDraftDirtyRef.current = { bio: false, monologue: false }
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
    if (isTtsBusy) return

    // 用户从最终结果页返回到语音页时，应允许停留在语音页调整参数/重新生成。
    // 此时通常已经有 ttsAudioPath（以及可选的 ttsAudioUrl），不应再次自动跳回 done。
    if (ttsAudioPath) return

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
  }, [
    activeSession?.status,
    dispatch,
    findAnyAudioFile,
    isTtsBusy,
    loadAudioByPath,
    outputDir,
    step,
    ttsAudioPath
  ])

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

  // 完成页：自动读取 人物TXT合集 作为"人物列表 + 单人展示"的数据源（无缓存，文件系统即真相）
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

        // 优先自动选中"已经生成过二次总结"的人物（文件系统即真相；避免用户误以为需要重新生成）
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
  const stageProgressStartRef = useRef<number>(0)

  /**
   * 基于已过去的秒数计算模拟百分比（确定性函数，不含随机）。
   * 曲线：前 30 秒快速增长到 ~60%，之后缓慢爬升，最高 92%。
   */
  const calcStagePercentage = useCallback((elapsedMs: number) => {
    const t = elapsedMs / 1000
    // 1 - e^(-0.05t) 在 t=30 约 0.78, t=60 约 0.95
    return Math.min(92, Math.round(8 + 84 * (1 - Math.exp(-0.05 * t))))
  }, [])

  const startStageProgress = useCallback((stage: string, startedAt?: number) => {
    if (stageProgressTimerRef.current) {
      window.clearInterval(stageProgressTimerRef.current)
      stageProgressTimerRef.current = null
    }
    const origin = startedAt ?? Date.now()
    stageProgressStartRef.current = origin

    const pct = calcStagePercentage(Date.now() - origin)
    setStageProgress({ stage, percentage: pct })

    stageProgressTimerRef.current = window.setInterval(() => {
      const p = calcStagePercentage(Date.now() - origin)
      setStageProgress((prev) => (prev ? { ...prev, stage, percentage: p } : { stage, percentage: p }))
    }, 450)
  }, [calcStagePercentage])

  const stopStageProgress = useCallback((opts?: { finalPercentage?: number; keepMs?: number }) => {
    if (stageProgressTimerRef.current) {
      window.clearInterval(stageProgressTimerRef.current)
      stageProgressTimerRef.current = null
    }
    const finalPercentage = opts?.finalPercentage
    const keepMs = opts?.keepMs ?? 250
    if (finalPercentage !== undefined) {
      setStageProgress((prev) =>
        prev ? { ...prev, percentage: finalPercentage } : { stage: 'completed', percentage: finalPercentage }
      )
      window.setTimeout(() => setStageProgress(null), keepMs)
    } else {
      setStageProgress(null)
    }
  }, [])

  // 恢复进度条后的文件轮询：当 stageProgress 存在且处于 secondary 步骤时，
  // 定期检查磁盘上是否已出现二次总结文件。一旦检测到，停止进度条并重新加载内容。
  // 这覆盖了以下场景：用户在生成中离开，IPC 在后台完成并落盘，前端重新进入后需要检测到。
  useEffect(() => {
    if (step !== 'secondary' || !stageProgressRef.current || !outputDir || !selectedCharacterName) return
    // 仅在"恢复的进度条"场景下轮询（正常生成流程由 handleGenerateSecondary 的 await 处理）
    if (isSecondaryBioGenerating || isSecondaryMonologueGenerating) return

    const kind: SecondaryKind = (stageProgressRef.current.stage || '').includes('人物志') ? 'bio' : 'monologue'
    const kindDirName = kind === 'bio' ? '人物志' : '心理独白'
    // 距阶段开始至少 10 秒后才开始轮询，避免"重新生成"场景中误检到旧文件
    const startedAt = stageProgressStartRef.current || Date.now()
    const graceMs = Math.max(0, 10_000 - (Date.now() - startedAt))

    let cancelled = false

    const poll = async () => {
      // 如果进度条已被其他逻辑停止，不再轮询
      if (!stageProgressRef.current) return

      try {
        const safeStem = sanitizeSecondaryFileStem(selectedCharacterName)
        const filePath = await window.api.path.join(outputDir, '二次总结', kindDirName, `${safeStem}.txt`)
        const exists = await window.api.fs.exists(filePath)
        if (exists && !cancelled) {
          // 文件已落盘：停止进度条并重新加载内容
          stopStageProgress({ finalPercentage: 100 })
          secondaryDraftDirtyRef.current[kind] = false
          loadSecondaryFromDisk(kind)

          // 更新 Redux 进度
          dispatch(
            updateSessionProgress({
              type: 'character',
              progress: { percentage: 80, stage: '等待二次总结' },
              status: 'processing'
            })
          )
        }
      } catch {
        // ignore
      }
    }

    // grace period 后开始首次轮询，之后每 3 秒一次
    const startTimer = window.setTimeout(() => {
      if (cancelled) return
      poll()
      const interval = window.setInterval(poll, 3000)
      // 保存 interval id 以便 cleanup
      timerRef = interval
    }, graceMs)
    let timerRef: number | null = null

    return () => {
      cancelled = true
      window.clearTimeout(startTimer)
      if (timerRef !== null) window.clearInterval(timerRef)
    }
  }, [step, outputDir, selectedCharacterName, sanitizeSecondaryFileStem, stopStageProgress, loadSecondaryFromDisk, dispatch, isSecondaryBioGenerating, isSecondaryMonologueGenerating])

  const formatElapsed = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  useEffect(() => {
    const stopAll = (opts?: { reset?: boolean }) => {
      if (extractPseudoTimerRef.current) {
        window.clearInterval(extractPseudoTimerRef.current)
        extractPseudoTimerRef.current = null
      }
      if (extractElapsedTimerRef.current) {
        window.clearInterval(extractElapsedTimerRef.current)
        extractElapsedTimerRef.current = null
      }
      if (extractDotsTimerRef.current) {
        window.clearInterval(extractDotsTimerRef.current)
        extractDotsTimerRef.current = null
      }
      if (extractCompleteTimeoutRef.current) {
        window.clearTimeout(extractCompleteTimeoutRef.current)
        extractCompleteTimeoutRef.current = null
      }

      if (opts?.reset) {
        setExtractPseudoPercentage(0)
        setExtractElapsedSeconds(0)
        setExtractDotCount(1)
        extractStartMsRef.current = 0
      }
    }

    if (step !== 'extracting') {
      stopAll({ reset: true })
      return
    }

    // 失败时保持当前 UI（不再继续增长），等待自动重试或用户取消
    if (progress.stage === 'failed') {
      stopAll()
      return
    }

    // 已进入"收尾→切页"的过渡窗口时，不要重新启动伪进度
    if (extractCompleteTimeoutRef.current) {
      return
    }

    // 已启动过计时/进度动画时，不要因主进程频繁推送进度而重置
    if (extractPseudoTimerRef.current || extractElapsedTimerRef.current || extractDotsTimerRef.current) {
      return
    }

    const startedAtMs = (() => {
      try {
        const iso = activeSession?.startedAt
        if (!iso) return 0
        const ms = new Date(iso).getTime()
        return Number.isNaN(ms) ? 0 : ms
      } catch {
        return 0
      }
    })()

    // 初始化计时（尽量复用 Redux 的 startedAt，用于"返回进行中"时恢复计时）
    extractStartMsRef.current = extractStartMsRef.current || startedAtMs || Date.now()
    const initialElapsedSeconds = Math.max(0, Math.floor((Date.now() - extractStartMsRef.current) / 1000))
    setExtractElapsedSeconds(initialElapsedSeconds)
    setExtractPseudoPercentage(estimateProgressPercent(initialElapsedSeconds, estimatedTotalSeconds))

    // 计时器
    extractElapsedTimerRef.current = window.setInterval(() => {
      const start = extractStartMsRef.current
      if (!start) return
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000))
      setExtractElapsedSeconds(elapsedSeconds)
      setExtractPseudoPercentage(estimateProgressPercent(elapsedSeconds, estimatedTotalSeconds))
    }, 1000)

    // dots: 1,2,3,2,1 循环
    const pattern = [1, 2, 3, 2, 1]
    let idx = 0
    setExtractDotCount(pattern[idx])
    extractDotsTimerRef.current = window.setInterval(() => {
      idx = (idx + 1) % pattern.length
      setExtractDotCount(pattern[idx])
    }, 360)

    return () => {
      stopAll()
    }
  }, [activeSession?.startedAt, estimatedTotalSeconds, progress.stage, step])

  // Handle start processing
  const handleStart = useCallback(async () => {
    if (!canStart || !selectedModel || !selectedFile || isStarting) return

    setIsStarting(true) // 防重复提交
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
      const providerConfigs = [
        {
          modelId: selectedModel.id,
          providerId: config.providerId,
          options: config.options
        }
      ]

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
      dispatch(
        setActiveSession({
          type: 'character',
          session: {
            id: sessionId,
            type: 'character',
            status: 'processing',
            bookId: selectedFile.id,
            bookTitle: selectedFile.origin_name || selectedFile.name || '未命名',
            bookPath: selectedFile.path,
            inputCharCount: fileContent.length,
            modelId: selectedModel.id,
            modelName: selectedModel.name,
            outputDir: characterDir,
            startedAt: new Date().toISOString(),
            progress: { percentage: 0, stage: 'initializing' }
          }
        })
      )

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
      setIsStarting(false) // 重置防重复提交状态
    }
  }, [canStart, selectedModel, selectedFile, dispatch, isStarting])

  // 追踪当前任务的开始时间，用于过滤旧状态
  const taskStartTimeRef = useRef<number>(0)

  // 主进程状态 - 用于可靠接收所有更新
  const [mainProcessState, setMainProcessState] = useState<{
    isProcessing?: boolean
    progress?: ProcessingState & { stage: string }
    result?: { merged?: string }
    outputPath?: string // 实际的任务目录路径（带时间戳）
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
  useEffect(() => {
    stepRef.current = step
  }, [step])
  useEffect(() => {
    resultRef.current = result
  }, [result])
  useEffect(() => {
    progressRef.current = progress
  }, [progress])
  useEffect(() => {
    outputDirRef.current = outputDir
  }, [outputDir])

  // 响应主进程状态变化 - 处理业务逻辑
  useEffect(() => {
    if (!mainProcessState) return

    const currentStep = stepRef.current
    const currentResult = resultRef.current
    const currentProgress = progressRef.current
    const currentOutputDir = outputDirRef.current

    // 同步处理状态
    // 仅在用户仍处于"配置/提取"阶段时，才自动切换到提取进度页。
    // 避免用户在二次总结/语音/完成阶段手动浏览时被主进程状态强制拉回，导致"无法回退/闪烁/内容重叠"。
    if (
      mainProcessState.isProcessing &&
      (currentStep === 'config' || currentStep === 'extracting') &&
      currentStep !== 'extracting'
    ) {
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
        dispatch(
          updateSessionProgress({
            type: 'character',
            progress: {
              stage: newProgress.stage,
              percentage: newProgress.percentage,
              current: newProgress.current,
              total: newProgress.total
            },
            // 工作流整体以 mp3 落盘为完成标志；人物提取完成不应归档历史
            status: 'processing'
          })
        )
      }

      // 处理失败状态 - 保持在 processing 步骤，等待自动重试
      if (newProgress.stage === 'failed') {
        console.log('[CharacterWorkflow] Task failed, staying in processing step for auto-retry')
        // 失败时不跳转到 complete，保持在 processing 等待自动重试
        return
      }

      // 检查完成状态 - 支持 completed 和 finalizing (100% 且有结果)
      const isCompleted =
        newProgress.stage === 'completed' ||
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

        // 转换步骤：人物提取完成后直接进入二次总结阶段（不显示"提取完成"）
        if (currentStep === 'extracting') {
          // 让提取阶段的伪进度条自然收尾：先跳到 100%，短暂停留后再切换页面。
          if (!extractCompleteTimeoutRef.current) {
            if (extractPseudoTimerRef.current) {
              window.clearInterval(extractPseudoTimerRef.current)
              extractPseudoTimerRef.current = null
            }
            if (extractElapsedTimerRef.current) {
              window.clearInterval(extractElapsedTimerRef.current)
              extractElapsedTimerRef.current = null
            }
            if (extractDotsTimerRef.current) {
              window.clearInterval(extractDotsTimerRef.current)
              extractDotsTimerRef.current = null
            }

            setExtractPseudoPercentage(100)

            console.log('[CharacterWorkflow] Transitioning to secondary step')
            extractCompleteTimeoutRef.current = window.setTimeout(() => {
              extractCompleteTimeoutRef.current = null
              setStepDirection(1)
              setStep('secondary')
              dispatch(
                updateSessionProgress({
                  type: 'character',
                  progress: { percentage: 60, stage: '等待二次总结' },
                  status: 'processing'
                })
              )
            }, 260)
          }
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

  const handleGenerateSecondary = useCallback(
    async (kind: SecondaryKind) => {
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
      const stageStartedAt = Date.now()
      startStageProgress(stageLabel, stageStartedAt)
      dispatch(
        updateSessionProgress({
          type: 'character',
          progress: { percentage: 70, stage: stageLabel, stageStartedAt },
          status: 'processing'
        })
      )
      try {
        const actualProvider = getActualProvider(secondaryModel)
        if (!actualProvider) {
          throw new Error(`Could not find provider for model: ${secondaryModel.name}`)
        }
        const config = providerToAiSdkConfig(actualProvider, secondaryModel)
        const providerConfigs = [
          {
            modelId: secondaryModel.id,
            providerId: config.providerId,
            options: config.options
          }
        ]

        await window.api.novelCharacter.generateSecondary({
          providerConfigs,
          outputDir,
          plotFilePath: selectedCharacterPath,
          characterName: selectedCharacterName,
          kind
        })

        // 重新生成属于"覆盖落盘结果"的操作，允许覆盖当前编辑草稿
        secondaryDraftDirtyRef.current[kind] = false
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
        // 清理 Redux 中的"生成中"stage，避免恢复时误判为仍在生成
        dispatch(
          updateSessionProgress({
            type: 'character',
            progress: { percentage: 80, stage: '等待二次总结' },
            status: 'processing'
          })
        )
      }
    },
    [
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
    ]
  )

  const handleGoToTtsStep = useCallback(
    async (opts?: { updateProgress?: boolean }) => {
      // 第三阶段不展示内容，只展示参数与来源选择
      ttsGenerationTokenRef.current += 1
      stopStageProgress()
      setIsTtsGenerating(false)

      // 进入第三阶段前，先将用户编辑的草稿写回文件，避免切换步骤/刷新后回退
      if (secondaryBioDraft.trim()) {
        await persistSecondaryDraftToDisk('bio', secondaryBioDraft)
      }
      if (secondaryMonologueDraft.trim()) {
        await persistSecondaryDraftToDisk('monologue', secondaryMonologueDraft)
      }

      // 从二次总结页进入第三阶段时，确保 UI 能立即按来源可用性更新
      loadSecondaryFromDisk('bio')
      loadSecondaryFromDisk('monologue')

      setStepDirection(1)
      setStep('tts')

      if (opts?.updateProgress === false) return

      dispatch(
        updateSessionProgress({
          type: 'character',
          progress: { percentage: 85, stage: '等待生成语音' },
          status: 'processing'
        })
      )
    },
    [
      dispatch,
      loadSecondaryFromDisk,
      persistSecondaryDraftToDisk,
      secondaryBioDraft,
      secondaryMonologueDraft,
      stopStageProgress
    ]
  )

  const handleBackToSecondaryStep = useCallback(() => {
    ttsGenerationTokenRef.current += 1
    stopStageProgress()
    setIsTtsGenerating(false)
    setStepDirection(-1)
    setStep('secondary')
  }, [stopStageProgress])

  const previewText = useMemo(() => {
    const text = t('workflow.tts.previewSampleText', '你好，这是语音试听。').trim()
    return text || '你好，这是语音试听。'
  }, [t])

  const prunePreviewCache = useCallback(() => {
    const now = Date.now()
    for (const [key, item] of previewCacheRef.current.entries()) {
      if (now - item.createdAt > PREVIEW_CACHE_TTL_MS) {
        previewCacheRef.current.delete(key)
      }
    }

    if (previewCacheRef.current.size <= PREVIEW_CACHE_MAX_ITEMS) return

    const sortedEntries = Array.from(previewCacheRef.current.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt)
    const overflow = sortedEntries.length - PREVIEW_CACHE_MAX_ITEMS
    for (let index = 0; index < overflow; index += 1) {
      previewCacheRef.current.delete(sortedEntries[index][0])
    }
  }, [])

  const base64ToArrayBuffer = useCallback((base64: string) => {
    const binary = window.atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes.buffer
  }, [])

  const unlockPreviewAudioContext = useCallback(() => {
    try {
      if (!previewAudioContextRef.current) {
        previewAudioContextRef.current = new AudioContext()
      }
      const ctx = previewAudioContextRef.current
      if (ctx && ctx.state === 'suspended') {
        void ctx.resume()
      }
    } catch {
      // ignore
    }
  }, [])

  const playPreviewFromFile = useCallback(
    async (filePath: string, mime: string) => {
      const ctx = previewAudioContextRef.current
      if (ctx) {
        try {
          if (ctx.state === 'suspended') {
            await ctx.resume()
          }

          const base64 = await window.api.fs.read(filePath, 'base64')
          const arrayBuffer = base64ToArrayBuffer(base64)
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))

          if (previewAudioSourceRef.current) {
            try {
              previewAudioSourceRef.current.stop()
            } catch {
              // ignore
            }
            try {
              previewAudioSourceRef.current.disconnect()
            } catch {
              // ignore
            }
            previewAudioSourceRef.current = null
          }

          const source = ctx.createBufferSource()
          source.buffer = audioBuffer
          source.connect(ctx.destination)
          source.start(0)
          previewAudioSourceRef.current = source
          return
        } catch (error) {
          console.warn('[CharacterWorkflow] Preview play via AudioContext failed, fallback to <audio>:', error)
        }
      }

      const audio = previewAudioRef.current
      if (!audio) {
        throw new Error('Preview audio element is not ready')
      }

      const base64 = await window.api.fs.read(filePath, 'base64')
      audio.src = `data:${mime};base64,${base64}`

      try {
        audio.pause()
        audio.currentTime = 0
        audio.load()
        await audio.play()
      } catch (error) {
        console.warn('[CharacterWorkflow] Preview autoplay blocked:', error)
        window.toast?.warning?.(
          t('workflow.tts.previewAutoplayBlocked', '系统阻止自动播放试听音频，请再次点击"试听"或检查系统声音设置')
        )
        throw error
      }
    },
    [base64ToArrayBuffer, t]
  )

  const requestPreviewAudio = useCallback(
    async (
      cacheKey: string,
      signature: string,
      generate: () => Promise<{ filePath?: string }>
    ): Promise<TtsPreviewCacheItem> => {
      const cached = previewCacheRef.current.get(cacheKey)
      if (cached) {
        if (cached.signature === signature && Date.now() - cached.createdAt <= PREVIEW_CACHE_TTL_MS) {
          return cached
        }
        previewCacheRef.current.delete(cacheKey)
      }

      const inFlight = previewInFlightRef.current.get(cacheKey)
      if (inFlight) {
        return inFlight
      }

      const request = (async () => {
        const result = await generate()

        if (!result.filePath) {
          throw new Error('Preview generation returned empty filePath.')
        }

        const mime = result.filePath.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
        const item: TtsPreviewCacheItem = {
          filePath: result.filePath,
          mime,
          createdAt: Date.now(),
          signature
        }

        previewCacheRef.current.set(cacheKey, item)
        prunePreviewCache()
        return item
      })()

      previewInFlightRef.current.set(cacheKey, request)

      try {
        return await request
      } finally {
        previewInFlightRef.current.delete(cacheKey)
      }
    },
    [prunePreviewCache]
  )

  const handlePreviewTts = useCallback(async () => {
    unlockPreviewAudioContext()
    if (isTtsBusy) return

    setIsTtsPreviewing(true)
    const token = ++previewTokenRef.current

    const cacheKey =
      ttsMode === 'normal'
        ? `edge:${ttsVoice}`
        : advancedProvider === 'zai'
          ? `zai:${advancedZaiVoice}`
          : `microsoft:${advancedTtsVoice}`

    const signature =
      ttsMode === 'normal'
        ? JSON.stringify({
            text: previewText,
            rate: formatSignedPercent(ttsRateValue),
            pitch: formatSignedPercent(ttsPitchValue)
          })
        : advancedProvider === 'zai'
          ? JSON.stringify({
              text: previewText,
              rate: formatSigned(advancedTtsRateValue)
            })
          : JSON.stringify({
              text: previewText,
              style: advancedTtsStyle || 'general',
              rate: formatSigned(advancedTtsRateValue),
              pitch: formatSigned(advancedTtsPitchValue)
            })

    const generate = async () => {
      if (ttsMode === 'normal') {
        return window.api.edgeTTS.generate({
          text: previewText,
          voice: ttsVoice,
          rate: formatSignedPercent(ttsRateValue),
          pitch: formatSignedPercent(ttsPitchValue)
        })
      }

      if (advancedProvider === 'zai') {
        return window.api.advancedTTS.generate({
          provider: 'zai',
          text: previewText,
          voice: advancedZaiVoice,
          rate: formatSigned(advancedTtsRateValue)
        })
      }

      return window.api.advancedTTS.generate({
        provider: 'microsoft',
        text: previewText,
        voice: advancedTtsVoice,
        style: advancedTtsStyle || 'general',
        rate: formatSigned(advancedTtsRateValue),
        pitch: formatSigned(advancedTtsPitchValue)
      })
    }

    try {
      const previewItem = await requestPreviewAudio(cacheKey, signature, generate)
      if (token !== previewTokenRef.current) return
      await playPreviewFromFile(previewItem.filePath, previewItem.mime)
    } catch (error) {
      console.error('[CharacterWorkflow] TTS preview failed:', error)
      window.toast?.error?.(t('workflow.tts.previewFailed', '试听失败'))
    } finally {
      if (token === previewTokenRef.current) {
        setIsTtsPreviewing(false)
      }
    }
  }, [
    advancedProvider,
    advancedTtsPitchValue,
    advancedTtsRateValue,
    advancedTtsStyle,
    advancedTtsVoice,
    advancedZaiVoice,
    isTtsBusy,
    playPreviewFromFile,
    previewText,
    requestPreviewAudio,
    t,
    ttsMode,
    ttsPitchValue,
    ttsRateValue,
    ttsVoice,
    unlockPreviewAudioContext
  ])

  const handleGenerateTts = useCallback(async () => {
    if (!outputDir || !selectedCharacterName) return
    if (isTtsBusy) return

    const kind = ttsSourceKind
    const text = kind === 'bio' ? secondaryBioDraft : secondaryMonologueDraft

    if (!text?.trim()) {
      window.toast?.error?.(t('workflow.character.tts.missingSource', '未找到对应文本，请先生成二次总结'))
      return
    }

    setIsTtsGenerating(true)
    const ttsStageStartedAt = Date.now()
    startStageProgress('生成语音', ttsStageStartedAt)
    dispatch(
      updateSessionProgress({
        type: 'character',
        progress: { percentage: 92, stage: '生成语音', stageStartedAt: ttsStageStartedAt },
        status: 'processing'
      })
    )

    const generationToken = ++ttsGenerationTokenRef.current

    try {
      // 生成前先把编辑内容写回落盘文件，确保"音频对应当前编辑内容"且回退不丢失
      await persistSecondaryDraftToDisk(kind, text)
      if (generationToken !== ttsGenerationTokenRef.current) return

      const audioDir = await window.api.path.join(outputDir, 'audio')
      if (generationToken !== ttsGenerationTokenRef.current) return

      const safeStem = sanitizeSecondaryFileStem(selectedCharacterName)
      const extension = ttsMode === 'advanced' ? '.wav' : '.mp3'
      const filename = `${safeStem}_${kind}${extension}`

      const textFilePath = ttsMode === 'advanced' ? await getSecondaryFilePath(kind) : null

      const result =
        ttsMode === 'advanced'
          ? await window.api.advancedTTS.generate(
              advancedProvider === 'zai'
                ? {
                    provider: 'zai',
                    text,
                    textFilePath: textFilePath ?? undefined,
                    voice: advancedZaiVoice,
                    rate: formatSigned(advancedTtsRateValue),
                    outputDir: audioDir,
                    filename
                  }
                : {
                    provider: 'microsoft',
                    text,
                    textFilePath: textFilePath ?? undefined,
                    voice: advancedTtsVoice,
                    style: advancedTtsStyle || 'general',
                    rate: formatSigned(advancedTtsRateValue),
                    pitch: formatSigned(advancedTtsPitchValue),
                    outputDir: audioDir,
                    filename
                  }
            )
          : await window.api.edgeTTS.generate({
              text,
              voice: ttsVoice,
              rate: formatSignedPercent(ttsRateValue),
              pitch: formatSignedPercent(ttsPitchValue),
              outputDir: audioDir,
              filename
            })
      if (generationToken !== ttsGenerationTokenRef.current) return

      const audioPath = result?.filePath as string | undefined
      if (!audioPath) {
        throw new Error('生成成功但未返回音频路径')
      }

      const mime = audioPath.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
      const base64 = await window.api.fs.read(audioPath, 'base64')
      if (generationToken !== ttsGenerationTokenRef.current) return

      setTtsAudioPath(audioPath)
      setTtsAudioUrl(`data:${mime};base64,${base64}`)
      setTtsAudioMime(mime)
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
    isTtsBusy,
    outputDir,
    sanitizeSecondaryFileStem,
    selectedCharacterName,
    startStageProgress,
    stopStageProgress,
    t,
    ttsMode,
    advancedProvider,
    advancedTtsStyle,
    advancedTtsVoice,
    advancedTtsPitchValue,
    advancedTtsRateValue,
    advancedZaiVoice,
    ttsPitchValue,
    ttsRateValue,
    ttsSourceKind,
    ttsVoice
  ])

  const handleOpenAudioFile = useCallback(() => {
    if (ttsAudioPath) {
      window.api.file.showItemInFolder(ttsAudioPath)
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
  }, [dispatch, stopStageProgress])

  const handleBackToConfigStep = useCallback(() => {
    // 仅做 UI 导航，不主动取消主进程任务（避免误删已生成结果）
    ttsGenerationTokenRef.current += 1
    stopStageProgress()
    setIsTtsGenerating(false)
    setIsSecondaryBioGenerating(false)
    setIsSecondaryMonologueGenerating(false)
    setStep('config')
  }, [stopStageProgress])

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
        <div className="flex h-full w-full flex-col items-center justify-center bg-background">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      </>
    )
  }

  let stepContent: ReactNode

  // Render based on step
  if (step === 'extracting') {
    const navButtons = (
      <CircularNavButton
        direction="left"
        tooltip={t('workflow.processing.cancel', '取消并返回')}
        onPress={handleCancel}
      />
    )

    stepContent = (
      <WorkflowLayout nav={navButtons}>
        <StepHeader
          title={t('workflow.character.stage1.title', '第一阶段：人物提取')}
          hint={t('workflow.character.processingHint', '请耐心等待，处理完成后将自动显示结果')}
        />

        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-8">
          {/* 失败状态提示 */}
          {progress.stage === 'failed' && (
            <Card className="w-full border-warning-200 bg-warning-50">
              <CardBody>
                <div className="mb-2 font-semibold text-warning-600">⚠️ 任务失败：部分分块未能生成</div>
                <div className="text-foreground/60 text-sm">
                  已成功处理 {progress.current}/{progress.total} 个分块。
                  系统将在3秒后自动重试，或点击"取消任务"后手动重新开始。
                </div>
              </CardBody>
            </Card>
          )}

          <div className="w-full rounded-3xl border border-white/5 bg-content1/50 p-8 backdrop-blur-sm">
            <div className="mx-auto w-full max-w-lg">
              <div className="mb-6">
                <Progress
                  aria-label="Extracting progress"
                  value={extractPseudoPercentage}
                  color="primary"
                  size="lg"
                  className="w-full"
                  showValueLabel
                />
              </div>

              <div className="space-y-1 text-center">
                <p className="font-medium text-foreground text-lg">{`少女祈祷中${'.'.repeat(extractDotCount)}`}</p>
                <p className="text-foreground/50 text-sm">
                  {t('workflow.elapsed', '已用时 {{time}}', { time: formatElapsed(extractElapsedSeconds) })}
                </p>
                <p className="text-foreground/50 text-sm">
                  {t('workflow.estimatedTotal', '预计用时 {{time}}', { time: formatElapsed(estimatedTotalSeconds) })}
                </p>
              </div>
            </div>

            {progress.stage !== 'failed' && (
              <div className="mt-8 flex items-center justify-center gap-4">
                <Loader2 size={32} className="animate-spin text-primary" />
              </div>
            )}
          </div>
        </div>
      </WorkflowLayout>
    )
  } else if (step === 'secondary' || step === 'tts' || step === 'done') {
    const showCharacterPicker = shouldUseCharacterTxtFolder
    const fullscreenBaseTitle = historyBookTitle ?? selectedFile?.origin_name ?? selectedFile?.name ?? '人物志'

    // 判断二次总结是否处于"初始视图"（只有人物选择 + 两个生成按钮）：
    // 1. 必须在 secondary 步骤
    // 2. 没有阶段进度条（stageProgress）
    // 3. 没有任何已生成内容
    // 4. 人物列表不在加载中（避免恢复时异步加载期间闪现初始视图）
    // 5. 二次总结内容不在加载中（避免磁盘读取期间闪现初始视图）
    // 6. Redux session 的 stage 未表明正在生成二次总结（避免从"进行中"返回时闪回初始视图）
    const reduxSecondaryStage = activeSession?.progress?.stage || ''
    const isReduxGeneratingSecondary = reduxSecondaryStage === '生成人物志'
      || reduxSecondaryStage === '生成心理独白'
    const isSecondaryInitial = step === 'secondary' && !stageProgress && !hasSecondaryOutput
      && !isCharacterListLoading
      && !isSecondaryBioLoading && !isSecondaryMonologueLoading
      && !isReduxGeneratingSecondary

    const navButtons = (
      <>
        {step === 'secondary' && isSecondaryInitial && (
          <>
            <CircularNavButton
              direction="right"
              tooltip={t('workflow.character.secondary.generateBio', '生成：人物志')}
              onPress={() => handleGenerateSecondary('bio')}
              isDisabled={
                !selectedCharacterName ||
                !selectedCharacterPath ||
                !outputDir ||
                isSecondaryBioGenerating ||
                isSecondaryBioLoading
              }
              isLoading={isSecondaryBioGenerating || isSecondaryBioLoading}
              className="-mt-12"
            />
            <CircularNavButton
              direction="right"
              tooltip={t('workflow.character.secondary.generateMonologue', '生成：心理独白')}
              onPress={() => handleGenerateSecondary('monologue')}
              isDisabled={
                !selectedCharacterName ||
                !selectedCharacterPath ||
                !outputDir ||
                isSecondaryMonologueGenerating ||
                isSecondaryMonologueLoading
              }
              isLoading={isSecondaryMonologueGenerating || isSecondaryMonologueLoading}
              className="mt-12"
            />
          </>
        )}

        {step === 'secondary' && !isSecondaryInitial && (
          <CircularNavButton
            direction="right"
            tooltip={t('workflow.character.stage2.next', '下一步：生成语音')}
            onPress={() => handleGoToTtsStep({ updateProgress: false })}
            isDisabled={!secondaryBioDraft.trim() && !secondaryMonologueDraft.trim()}
          />
        )}

        {step === 'tts' && (
          <>
            <CircularNavButton
              direction="left"
              tooltip={t('workflow.character.stage3.prev', '上一步')}
              onPress={handleBackToSecondaryStep}
              isDisabled={isTtsBusy}
            />
            <CircularNavButton
              direction="right"
              tooltip={t('workflow.tts.generate', '开始生成')}
              onPress={handleGenerateTts}
              isDisabled={
                isTtsBusy ||
                (ttsSourceKind === 'bio'
                  ? isSecondaryBioLoading || !secondaryBioDraft.trim()
                  : isSecondaryMonologueLoading || !secondaryMonologueDraft.trim())
              }
              isLoading={
                isTtsGenerating || (ttsSourceKind === 'bio' ? isSecondaryBioLoading : isSecondaryMonologueLoading)
              }
              color="primary"
              icon={<Mic size={28} />}
            />
          </>
        )}

        {step === 'done' && (
          <>
            <CircularNavButton
              direction="left"
              tooltip={t('workflow.character.stage4.prev', '上一步')}
              onPress={() => setStep('tts')}
            />
            <CircularNavButton
              direction="right"
              tooltip={t('workflow.character.stage4.next', '开始新任务')}
              onPress={handleBackToConfigStep}
            />
          </>
        )}
      </>
    )

    stepContent = (
      <WorkflowLayout nav={navButtons}>
        {step === 'secondary' && (
          <div className="flex w-full flex-col items-center gap-10">
            <StepHeader title={t('workflow.character.stage2.title', '第二阶段：二次总结')} />

            {showCharacterPicker &&
              (isSecondaryInitial ? (
                // Initial View
                <div className="mt-4 flex w-full max-w-2xl flex-col items-center justify-center gap-8">
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
                        trigger: 'h-14 bg-content2/50 hover:bg-content2 transition-colors',
                        value: 'text-center font-medium text-lg'
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
                      }}>
                      {characterTxtFiles.map((f) => {
                        const name = f.name.replace(/\.txt$/i, '')
                        return (
                          <SelectItem key={f.path} textValue={name}>
                            <div className="w-full text-center">{name}</div>
                          </SelectItem>
                        )
                      })}
                    </Select>
                  </div>

                  {!isCharacterListLoading && characterTxtFiles.length === 0 && (
                    <div className="text-center text-foreground/40 text-sm">
                      {t('workflow.character.result.noCharacters', '未找到人物 TXT')}
                    </div>
                  )}
                </div>
              ) : (
                // Standard View
                <div className="w-full max-w-3xl space-y-6">
                  {stageProgress && (
                    <Card className="mb-4 w-full">
                      <CardBody className="py-6">
                        <ProgressDisplay
                          percentage={stageProgress.percentage}
                          stage={stageProgress.stage}
                          current={stageProgress.current}
                          total={stageProgress.total}
                        />
                      </CardBody>
                    </Card>
                  )}

                  <div className="flex flex-col items-center gap-4">
                    <div className="rounded-2xl border border-white/5 bg-content2/30 p-1.5 backdrop-blur-sm">
                      <Tabs
                        size="lg"
                        selectedKey={secondaryKind}
                        onSelectionChange={(key) => setSecondaryKind(key as SecondaryKind)}
                        variant="light"
                        classNames={{
                          tabList: 'gap-2',
                          cursor: 'bg-background shadow-sm',
                          tab: 'h-9 px-6',
                          tabContent: 'group-data-[selected=true]:text-primary font-medium'
                        }}>
                        <Tab key="bio" title={t('workflow.character.secondary.bio', '人物志')} />
                        <Tab key="monologue" title={t('workflow.character.secondary.monologue', '心理独白')} />
                      </Tabs>
                    </div>

                    <div className="flex items-center justify-center gap-4 py-2">
                      <div className="rounded-2xl border border-white/5 bg-content2/30 p-1 backdrop-blur-sm">
                        <Select
                          aria-label={t('workflow.character.result.selectCharacter', '选择人物')}
                          placeholder={t('workflow.character.result.selectCharacter', '选择人物')}
                          selectedKeys={selectedCharacterPath ? [selectedCharacterPath] : []}
                          onChange={(e) => setSelectedCharacterPath(e.target.value || null)}
                          variant="flat"
                          size="sm"
                          className="w-[200px]"
                          isDisabled={isCharacterListLoading || characterTxtFiles.length === 0}
                          popoverProps={{ classNames: { content: 'z-[200]' } }}
                          classNames={{
                            trigger: 'bg-transparent shadow-none hover:bg-content2/50 min-h-unit-8 h-8',
                            value: 'text-center font-medium'
                          }}>
                          {characterTxtFiles.map((f) => {
                            const name = f.name.replace(/\.txt$/i, '')
                            return (
                              <SelectItem key={f.path} textValue={name}>
                                <div className="w-full text-center">{name}</div>
                              </SelectItem>
                            )
                          })}
                        </Select>
                      </div>

                      <Button
                        size="sm"
                        variant="flat"
                        color="primary"
                        startContent={<Sparkles size={14} />}
                        isLoading={
                          secondaryKind === 'bio'
                            ? isSecondaryBioGenerating || isSecondaryBioLoading
                            : isSecondaryMonologueGenerating || isSecondaryMonologueLoading
                        }
                        isDisabled={!selectedCharacterPath || !outputDir}
                        onPress={() => handleGenerateSecondary(secondaryKind)}
                        className="h-10 rounded-xl px-6">
                        {secondaryKind === 'bio'
                          ? secondaryBioText
                            ? t('workflow.character.secondary.regenerate', '重新生成')
                            : t('workflow.character.secondary.generate', '生成')
                          : secondaryMonologueText
                            ? t('workflow.character.secondary.regenerate', '重新生成')
                            : t('workflow.character.secondary.generate', '生成')}
                      </Button>
                    </div>
                  </div>

                  {/* Editable Result Box - Matches OutlineWorkflow style */}
                  <Card className="group relative w-full max-w-3xl">
                    <CardBody className="p-0">
                      <Textarea
                        minRows={6}
                        maxRows={25}
                        value={secondaryKind === 'bio' ? secondaryBioDraft : secondaryMonologueDraft}
                        onValueChange={(v) => setSecondaryDraft(secondaryKind, v)}
                        placeholder={t('workflow.character.secondary.empty', '尚未生成，点击"生成"即可')}
                        classNames={{
                          base: 'w-full h-full',
                          inputWrapper:
                            'h-full !bg-transparent !shadow-none hover:!bg-transparent focus-within:!bg-transparent data-[hover=true]:!bg-transparent group-data-[focus=true]:!bg-transparent !ring-0 !ring-offset-0 !outline-none !border-none p-6 !rounded-none',
                          input:
                            'h-full !text-sm !leading-[1.75] text-foreground/80 font-normal !pr-2 !outline-none !ring-0 focus:!ring-0 placeholder:text-foreground/30 caret-primary'
                        }}
                      />
                    </CardBody>
                    {(secondaryKind === 'bio' ? secondaryBioDraft : secondaryMonologueDraft).trim() && (
                      <FullscreenResultViewer
                        content={secondaryKind === 'bio' ? secondaryBioDraft : secondaryMonologueDraft}
                        kind="text"
                        title={[
                          fullscreenBaseTitle,
                          selectedCharacterName,
                          secondaryKind === 'bio'
                            ? t('workflow.character.secondary.bio', '人物志')
                            : t('workflow.character.secondary.monologue', '心理独白')
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        onSave={(newContent) => {
                          if (secondaryKind === 'bio') {
                            setSecondaryBioDraft(newContent)
                          } else {
                            setSecondaryMonologueDraft(newContent)
                          }
                        }}
                      />
                    )}
                  </Card>
                </div>
              ))}
          </div>
        )}

        {step === 'tts' && (
          <div className="flex w-full flex-col items-center gap-8">
            <StepHeader title={t('workflow.character.stage3.actions', '声音设置')} />

            {/* Controls: Tabs & Character Select */}
            <div
              className={`flex flex-col items-center gap-4 ${isTtsBusy ? 'pointer-events-none opacity-60' : ''}`}>
              {/* Tabs for Mode */}
              <div className="rounded-2xl border border-white/5 bg-content2/30 p-1.5 backdrop-blur-sm">
                <Tabs
                  size="lg"
                  selectedKey={ttsMode}
                  onSelectionChange={(key) => {
                    if (!allowAdvanced && key === 'advanced') return
                    setTtsMode(key as 'normal' | 'advanced')
                    // 切换模式时重置筛选，避免沿用上一个模式的筛选导致"区域/音色"跳动
                    setLanguageFilter('zh')
                    setRegionFilter('all')
                    setGenderFilter('all')
                  }}
                  variant="light"
                  classNames={{
                    tabList: 'gap-2',
                    cursor: 'bg-background shadow-sm',
                    tab: 'h-9 px-6',
                    tabContent: 'group-data-[selected=true]:text-primary font-medium'
                  }}>
                  <Tab key="normal" title={t('workflow.tts.mode.normal', '普通版')} />
                  {allowAdvanced && <Tab key="advanced" title={t('workflow.tts.mode.advanced', '高级版')} />}
                </Tabs>
              </div>

              {/* Tabs for Source */}
              <div className="rounded-2xl border border-white/5 bg-content2/30 p-1.5 backdrop-blur-sm">
                <Tabs
                  size="lg"
                  selectedKey={ttsSourceKind}
                  onSelectionChange={(key) => setTtsSourceKind(key as 'bio' | 'monologue')}
                  variant="light"
                  classNames={{
                    tabList: 'gap-2',
                    cursor: 'bg-background shadow-sm',
                    tab: 'h-9 px-6',
                    tabContent: 'group-data-[selected=true]:text-primary font-medium'
                  }}>
                  <Tab key="bio" title={t('workflow.character.secondary.bio', '人物志')} />
                  <Tab key="monologue" title={t('workflow.character.secondary.monologue', '心理独白')} />
                </Tabs>
              </div>

              {/* Character Selector */}
              <div className="rounded-2xl border border-white/5 bg-content2/30 p-1 backdrop-blur-sm">
                <Select
                  aria-label={t('workflow.character.result.selectCharacter', '选择人物')}
                  placeholder={t('workflow.character.result.selectCharacter', '选择人物')}
                  selectedKeys={selectedCharacterPath ? [selectedCharacterPath] : []}
                  onChange={(e) => setSelectedCharacterPath(e.target.value || null)}
                  variant="flat"
                  size="sm"
                  className="w-[200px]"
                  isDisabled={isTtsBusy || isCharacterListLoading || characterTxtFiles.length === 0}
                  popoverProps={{ classNames: { content: 'z-[200]' } }}
                  classNames={{
                    trigger: 'bg-transparent shadow-none hover:bg-content2/50 min-h-unit-8 h-8',
                    value: 'text-center font-medium'
                  }}>
                  {characterTxtFiles.map((f) => {
                    const name = f.name.replace(/\.txt$/i, '')
                    return (
                      <SelectItem key={f.path} textValue={name}>
                        <div className="w-full text-center">{name}</div>
                      </SelectItem>
                    )
                  })}
                </Select>
              </div>
            </div>

            {/* Configuration Card */}
            <TtsVoiceConfigCard
              isGenerating={isTtsBusy}
              isPreviewing={isTtsPreviewing}
              onPreview={handlePreviewTts}
              ttsMode={ttsMode}
              advancedProvider={advancedProvider}
              setAdvancedProvider={setAdvancedProvider}
              portalContainer={popoverPortalContainer}
              voiceLoadError={voiceLoadError}
              isLoadingVoices={isLoadingVoices}
              languageFilter={languageFilter}
              setLanguageFilter={setLanguageFilter}
              regionFilter={regionFilter}
              setRegionFilter={setRegionFilter}
              genderFilter={genderFilter}
              setGenderFilter={setGenderFilter}
              languageSelectItems={languageSelectItems}
              regionSelectItems={regionSelectItems}
              genderSelectItems={genderSelectItems}
              filteredVoices={filteredVoices}
              activeVoice={activeVoice}
              setActiveVoice={setActiveVoice}
              advancedStyle={advancedTtsStyle}
              setAdvancedStyle={setAdvancedTtsStyle}
              styleOptions={styleOptions}
              isLoadingStyles={isLoadingStyles}
              rateValue={ttsRateValue}
              setRateValue={setTtsRateValue}
              pitchValue={ttsPitchValue}
              setPitchValue={setTtsPitchValue}
              advancedRateValue={advancedTtsRateValue}
              setAdvancedRateValue={setAdvancedTtsRateValue}
              advancedPitchValue={advancedTtsPitchValue}
              setAdvancedPitchValue={setAdvancedTtsPitchValue}
            />
          </div>
        )}

        {step === 'done' && (
          <div className="flex w-full flex-col items-center gap-10">
            <StepHeader
              title={t('workflow.character.stage4.title', '最终结果：语音')}
              hint={t('workflow.character.stage4.hint', '已生成音频，可直接播放')}
            />

            <Card className="w-full max-w-2xl border-success-200 bg-success-50 shadow-sm">
              <CardBody className="space-y-6 p-8">
                <div className="flex items-center justify-center gap-2 font-medium text-lg text-success-700">
                  <Play size={24} />
                  {t('workflow.tts.result', '生成结果')}
                </div>

                {ttsAudioUrl ? (
                  <audio controls preload="metadata" className="w-full">
                    <source src={ttsAudioUrl} type={ttsAudioMime} />
                    {ttsAudioPath && <source src={toFileUrl(ttsAudioPath)} type={ttsAudioMime} />}
                  </audio>
                ) : (
                  <div className="text-center text-foreground/50 text-sm">
                    {t('workflow.tts.noAudioPreview', '音频已生成，但预览加载失败；可打开文件位置播放')}
                  </div>
                )}

                <div className="flex items-center justify-center gap-4">
                  <Button
                    variant="flat"
                    color="success"
                    startContent={<Download size={18} />}
                    isDisabled={!ttsAudioPath}
                    onPress={handleOpenAudioFile}
                    className="h-12 px-6">
                    {t('workflow.tts.openFile', '打开文件位置')}
                  </Button>
                  <Button variant="bordered" onPress={() => setStep('tts')} className="h-12 px-6">
                    {t('workflow.tts.regenerate', '重新生成语音')}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </div>
        )}
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
          title={t('workflow.character.title', '生成人物志')}
          hint={t('workflow.character.configHint', '选择模型和小说文件，开始提取人物信息')}
        />

        <GlassContainer className="space-y-8">
          <ModelSelector
            selectedModel={selectedModel}
            onModelSelect={setSelectedModel}
            storageKey="workflow.modelSelector.last.character.v1"
          />
          <NovelPicker selectedFile={selectedFile} onFileSelect={setSelectedFile} />

          {/* Target character mode */}
          <div className="w-full">
            <label className="mb-2 block font-medium text-foreground/70 text-sm">
              {t('workflow.character.targetMode', '指定人物（可选）')}
            </label>
            <Card className="w-full border border-white/5 bg-content1/50 shadow-sm">
              <CardBody className="space-y-4 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground/80 text-sm">
                        {t('workflow.character.targetModeLabel', '仅分析指定人物')}
                      </span>
                      <Tooltip content={t('workflow.character.targetModeTip', '只分析指定人物的剧情')}>
                        <span className="inline-flex cursor-help items-center text-foreground/40">
                          <Info size={14} />
                        </span>
                      </Tooltip>
                    </div>
                    <p className="text-foreground/50 text-xs">
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
                          inputWrapper: 'bg-content2/50 hover:bg-content2/70 focus-within:bg-content2/70'
                        }}
                        className="flex-1"
                        variant="flat"
                      />
                      <Button
                        size="sm"
                        variant="flat"
                        className="h-10"
                        startContent={<Plus size={14} />}
                        onPress={handleAddCharacter}
                        isDisabled={!newCharacterName.trim()}>
                        {t('workflow.character.targetAdd', '添加')}
                      </Button>
                    </div>

                    {targetCharacters.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {targetCharacters.map((char, index) => (
                          <Chip
                            key={`${char}-${index}`}
                            onClose={() => handleRemoveCharacter(index)}
                            size="sm"
                            variant="flat">
                            {char}
                          </Chip>
                        ))}
                      </div>
                    ) : (
                      <div className="text-foreground/40 text-xs">
                        {t('workflow.character.targetEmpty', '请添加要分析的人物')}
                      </div>
                    )}
                  </div>
                )}
              </CardBody>
            </Card>
          </div>
        </GlassContainer>
      </WorkflowLayout>
    )
  }

  return (
    <>
      <DragBar />
      <audio ref={previewAudioRef} className="hidden" preload="auto" />
      <WorkflowStepMotion motionKey={step} direction={stepDirection}>
        {stepContent}
      </WorkflowStepMotion>
    </>
  )
}

export default CharacterWorkflow
