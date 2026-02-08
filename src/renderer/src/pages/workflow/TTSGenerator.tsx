import { Button, Card, CardBody, Tab, Tabs, Textarea } from '@heroui/react'
import { isBasicEdition } from '@renderer/config/edition'
import { useLocalStorageState } from '@renderer/hooks/useLocalStorageState'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { Download, FileText, Mic, Play, Trash2 } from 'lucide-react'
import { type CSSProperties, FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import DragBar from './components/DragBar'
import { getLocaleLabelZh } from './components/ttsLabels'
import TtsVoiceConfigCard, { type AdvancedTTSProvider } from './components/TtsVoiceConfigCard'
import { useAdaptiveScale } from './components/useAdaptiveScale'

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

type VoiceItem = {
  shortName: string
  displayName: string
  localName?: string
  gender?: string
  locale?: string
  localeName?: string
  styleList?: string[]
}

type HistoryItem = {
  id: string
  provider?: AdvancedTTSProvider
  voice: string
  voiceLabel: string
  style?: string
  textPreview: string
  createdAt: string
  audioPath: string
  mime: string
}

type PreviewCacheItem = {
  filePath: string
  mime: string
  createdAt: number
  signature: string
}

const HISTORY_STORAGE_KEY = 'tts.generator.history.v1'
const PREF_KEY_PREFIX = 'tts.voicePrefs.v1'
const PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PREVIEW_CACHE_MAX_ITEMS = 20

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isAdvancedProvider = (value: unknown): value is AdvancedTTSProvider => value === 'microsoft' || value === 'zai'

const formatSigned = (value: number) => `${value >= 0 ? '+' : ''}${value}`
const formatSignedPercent = (value: number) => `${value >= 0 ? '+' : ''}${value}%`

const formatDate = (iso: string) => {
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  } catch {
    return iso
  }
}

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

const loadHistoryFromStorage = (): HistoryItem[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as HistoryItem[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.audioPath === 'string')
  } catch {
    return []
  }
}

const saveHistoryToStorage = (items: HistoryItem[]) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items))
  } catch {
    // ignore storage failures
  }
}

const TTSGenerator: FC = () => {
  const { t } = useTranslation()
  const { hostRef: layoutHostRef, scaledStyle } = useAdaptiveScale(1380)
  const location = useLocation()
  const { edition } = useRuntime()
  const allowAdvanced = !isBasicEdition(edition)

  const popoverPortalContainer = useMemo(() => {
    return typeof document !== 'undefined' ? document.body : undefined
  }, [])

  // Retrieve data passed from CharacterWorkflow (or other sources)
  const { summary, monologue, characterName, outputDir, customText } =
    (location.state as {
      summary?: string
      monologue?: string
      characterName?: string
      outputDir?: string
      customText?: string
    }) || {}

  const [sourceType, setSourceType] = useState<'summary' | 'monologue' | 'custom'>(
    summary ? 'summary' : monologue ? 'monologue' : 'custom'
  )
  const [customTextValue, setCustomTextValue] = useState(customText ?? '')

  const currentText = useMemo(() => {
    if (sourceType === 'custom') return customTextValue
    return sourceType === 'summary' ? summary : monologue
  }, [customTextValue, sourceType, summary, monologue])

  const [ttsMode, setTtsMode] = useState<'normal' | 'advanced'>(allowAdvanced ? 'normal' : 'normal')

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

  const [voice, setVoice] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.normal.voice`,
    'zh-CN-XiaoxiaoNeural',
    isNonEmptyString
  )
  const [advancedVoice, setAdvancedVoice] = useLocalStorageState<string>(
    `${PREF_KEY_PREFIX}.advanced.voice`,
    'zh-CN-XiaoxiaoMultilingualNeural',
    isNonEmptyString
  )
  const [advancedStyle, setAdvancedStyle] = useLocalStorageState<string>(
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

  const [rateValue, setRateValue] = useState(0)
  const [pitchValue, setPitchValue] = useState(0)
  const [advancedRateValue, setAdvancedRateValue] = useState(0)
  const [advancedPitchValue, setAdvancedPitchValue] = useState(0)

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

  const [isGenerating, setIsGenerating] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioPath, setAudioPath] = useState<string | null>(null)
  const [audioMime, setAudioMime] = useState('audio/mpeg')
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])

  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewAudioContextRef = useRef<AudioContext | null>(null)
  const previewAudioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const previewCacheRef = useRef<Map<string, PreviewCacheItem>>(new Map())
  const previewInFlightRef = useRef<Map<string, Promise<PreviewCacheItem>>>(new Map())

  const activeVoice =
    ttsMode === 'advanced'
      ? advancedProvider === 'zai'
        ? advancedZaiVoice
        : advancedVoice
      : voice

  const setActiveVoice = useCallback(
    (value: string) => {
      if (ttsMode === 'advanced') {
        if (advancedProvider === 'zai') {
          setAdvancedZaiVoice(value)
        } else {
          setAdvancedVoice(value)
        }
        return
      }
      setVoice(value)
    },
    [advancedProvider, ttsMode]
  )

  const toFileUrl = useCallback((filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/')
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`
    if (normalized.startsWith('/')) return `file://${encodeURI(normalized)}`
    return `file:///${encodeURI(normalized)}`
  }, [])

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
    setHistoryItems(loadHistoryFromStorage())
  }, [])

  useEffect(() => {
    saveHistoryToStorage(historyItems)
  }, [historyItems])

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

  const voiceMap = useMemo(() => {
    return new Map(voicesForMode.map((v) => [v.shortName, v]))
  }, [voicesForMode])

  const advancedVoiceMap = useMemo(() => {
    return new Map(advancedVoices.map((v) => [v.shortName, v]))
  }, [advancedVoices])

  useEffect(() => {
    if (normalVoices.length > 0) {
      const hasVoice = normalVoices.some((item) => item.shortName === voice)
      if (!hasVoice) {
        setVoice(normalVoices[0].shortName)
      }
    }

    if (advancedVoices.length > 0) {
      const hasAdvancedVoice = advancedVoices.some((item) => item.shortName === advancedVoice)
      if (!hasAdvancedVoice) {
        setAdvancedVoice(advancedVoices[0].shortName)
      }
    }
  }, [advancedVoice, advancedVoices, normalVoices, voice])

  useEffect(() => {
    // 当语言筛选变化后，如果当前“区域”不再匹配语言，则自动回退为“全部”，避免出现空列表/跳动。
    if (languageFilter === 'all') return
    if (regionFilter === 'all') return
    if (!regionFilter.toLowerCase().startsWith(`${languageFilter.toLowerCase()}-`)) {
      setRegionFilter('all')
    }
  }, [languageFilter, regionFilter])

  useEffect(() => {
    // 如果先选了“区域”，则同步语言筛选（仅在语言为“全部”时），保证筛选条件一致。
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
      if (!advancedVoice) return
      if (!advancedVoiceMap.get(advancedVoice)) {
        setStyleOptions([])
        if (!advancedStyle) {
          setAdvancedStyle('general')
        }
        return
      }
      setIsLoadingStyles(true)
      try {
        const result = await window.api.advancedTTS.getVoiceStyles(advancedVoice)
        if (!isMounted) return
        const styles = (result as VoiceStylesResult)?.styles ?? []
        setStyleOptions(styles)
        if (styles.length > 0 && !styles.includes(advancedStyle)) {
          setAdvancedStyle(styles[0])
        } else if (styles.length === 0 && !advancedStyle) {
          setAdvancedStyle('general')
        }
      } catch {
        if (!isMounted) return
        const fallback = advancedVoiceMap.get(advancedVoice)?.styleList ?? []
        setStyleOptions(fallback)
        if (fallback.length > 0 && !fallback.includes(advancedStyle)) {
          setAdvancedStyle(fallback[0])
        } else if (fallback.length === 0 && !advancedStyle) {
          setAdvancedStyle('general')
        }
      } finally {
        if (isMounted) {
          setIsLoadingStyles(false)
        }
      }
    }

    void fetchStyles()
    return () => {
      isMounted = false
    }
  }, [advancedProvider, advancedStyle, advancedVoice, advancedVoiceMap, ttsMode, allowAdvanced])

  const activeVoiceLabel = useMemo(() => {
    const item = voiceMap.get(activeVoice)
    const name = item ? item.localName || item.shortName : activeVoice
    const label = item ? `${name} - ${getGenderLabel(item.gender)}` : name

    if (ttsMode !== 'advanced') return label
    return advancedProvider === 'zai' ? `ZAI - ${label}` : `Microsoft - ${label}`
  }, [activeVoice, advancedProvider, ttsMode, voiceMap])

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
        // 必须在用户手势（点击“试听”）触发时调用，才能解除浏览器的自动播放限制。
        void ctx.resume()
      }
    } catch {
      // ignore
    }
  }, [])

  const readAudioDataUrl = useCallback(async (filePath: string, mime: string) => {
    const base64 = await window.api.fs.read(filePath, 'base64')
    return `data:${mime};base64,${base64}`
  }, [])

  const loadAudioFromFile = useCallback(
    async (filePath: string, mime: string) => {
      const url = await readAudioDataUrl(filePath, mime)
      setAudioPath(filePath)
      setAudioMime(mime)
      setAudioUrl(url)
    },
    [readAudioDataUrl]
  )

  const playPreviewFromFile = useCallback(
    async (filePath: string, mime: string) => {
      // 优先使用 WebAudio：只要在“点击”时 unlock 过 AudioContext，后续异步 decode/start 不会被自动播放策略拦截。
      const ctx = previewAudioContextRef.current
      if (ctx) {
        try {
          if (ctx.state === 'suspended') {
            // 理论上这里不会发生（因为 handlePreview 开头会 unlock），但做个兜底。
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
          console.warn('Preview play via AudioContext failed, fallback to <audio>:', error)
        }
      }

      // fallback：<audio> 播放（可能被自动播放策略拦截）
      const audio = previewAudioRef.current
      if (!audio) {
        throw new Error('Preview audio element is not ready')
      }

      const url = await readAudioDataUrl(filePath, mime)
      audio.src = url

      try {
        audio.pause()
        audio.currentTime = 0
        audio.load()
        await audio.play()
      } catch (error) {
        console.warn('Preview autoplay blocked:', error)
        window.toast?.warning?.(
          t('workflow.tts.previewAutoplayBlocked', '系统阻止自动播放试听音频，请再次点击“试听”或检查系统声音设置')
        )
        throw error
      }
    },
    [base64ToArrayBuffer, readAudioDataUrl, t]
  )

  const requestPreviewAudio = useCallback(
    async (
      cacheKey: string,
      signature: string,
      generate: () => Promise<{ filePath?: string }>
    ): Promise<PreviewCacheItem> => {
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
        const item: PreviewCacheItem = {
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


  const handleGenerate = useCallback(async () => {
    if (!currentText) return
    setIsGenerating(true)
    setAudioUrl(null)
    setAudioPath(null)

    try {
      const extension = ttsMode === 'advanced' ? '.wav' : '.mp3'
      let outputDirPath: string | undefined
      let filename: string | undefined

      if (characterName && outputDir) {
        outputDirPath = await window.api.path.join(outputDir, 'audio')
        filename = `${characterName}_${sourceType === 'summary' ? 'bio' : 'monologue'}${extension}`
      }

      const result =
        ttsMode === 'advanced'
          ? await window.api.advancedTTS.generate(
              advancedProvider === 'zai'
                ? {
                    provider: 'zai',
                    text: currentText,
                    voice: advancedZaiVoice,
                    rate: formatSigned(advancedRateValue),
                    outputDir: outputDirPath,
                    filename
                  }
                : {
                    provider: 'microsoft',
                    text: currentText,
                    voice: advancedVoice,
                    style: advancedStyle || 'general',
                    rate: formatSigned(advancedRateValue),
                    pitch: formatSigned(advancedPitchValue),
                    outputDir: outputDirPath,
                    filename
                  }
            )
          : await window.api.edgeTTS.generate({
              text: currentText,
              voice,
              rate: formatSignedPercent(rateValue),
              pitch: formatSignedPercent(pitchValue),
              outputDir: outputDirPath,
              filename
            })

      if (result.filePath) {
        const mime = result.filePath.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
        await loadAudioFromFile(result.filePath, mime)

        const preview = currentText.length > 80 ? `${currentText.slice(0, 80)}...` : currentText
        const newItem: HistoryItem = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          provider: ttsMode === 'advanced' ? advancedProvider : undefined,
          voice: activeVoice,
          voiceLabel: activeVoiceLabel,
          style: ttsMode === 'advanced' && advancedProvider === 'microsoft' ? advancedStyle : undefined,
          textPreview: preview,
          createdAt: new Date().toISOString(),
          audioPath: result.filePath,
          mime
        }
        setHistoryItems((prev) => [newItem, ...prev].slice(0, 50))

        window.toast?.success?.(t('workflow.tts.success', '生成成功'))
      }
    } catch (error) {
      console.error('TTS Generation failed:', error)
      window.toast?.error?.(t('workflow.tts.failed', '生成失败'))
    } finally {
      setIsGenerating(false)
    }
  }, [
    activeVoice,
    activeVoiceLabel,
    advancedPitchValue,
    advancedProvider,
    advancedRateValue,
    advancedStyle,
    advancedVoice,
    advancedZaiVoice,
    characterName,
    currentText,
    loadAudioFromFile,
    outputDir,
    pitchValue,
    rateValue,
    sourceType,
    t,
    ttsMode,
    voice
  ])

  const handlePreview = useCallback(async () => {
    // 必须在用户点击事件的同步阶段 unlock，否则后续异步播放会被拦截。
    unlockPreviewAudioContext()

    setIsPreviewing(true)

    const cacheKey =
      ttsMode === 'normal'
        ? `edge:${voice}`
        : advancedProvider === 'zai'
          ? `zai:${advancedZaiVoice}`
          : `microsoft:${advancedVoice}`

    const signature =
      ttsMode === 'normal'
        ? JSON.stringify({
            text: previewText,
            rate: formatSignedPercent(rateValue),
            pitch: formatSignedPercent(pitchValue)
          })
        : advancedProvider === 'zai'
          ? JSON.stringify({
              text: previewText,
              rate: formatSigned(advancedRateValue)
            })
          : JSON.stringify({
              text: previewText,
              style: advancedStyle || 'general',
              rate: formatSigned(advancedRateValue),
              pitch: formatSigned(advancedPitchValue)
            })

    const generate = async () => {
      if (ttsMode === 'normal') {
        return window.api.edgeTTS.generate({
          text: previewText,
          voice,
          rate: formatSignedPercent(rateValue),
          pitch: formatSignedPercent(pitchValue)
        })
      }

      if (advancedProvider === 'zai') {
        return window.api.advancedTTS.generate({
          provider: 'zai',
          text: previewText,
          voice: advancedZaiVoice,
          rate: formatSigned(advancedRateValue)
        })
      }

      return window.api.advancedTTS.generate({
        provider: 'microsoft',
        text: previewText,
        voice: advancedVoice,
        style: advancedStyle || 'general',
        rate: formatSigned(advancedRateValue),
        pitch: formatSigned(advancedPitchValue)
      })
    }

    try {
      let previewItem = await requestPreviewAudio(cacheKey, signature, generate)

      try {
        await playPreviewFromFile(previewItem.filePath, previewItem.mime)
      } catch {
        previewCacheRef.current.delete(cacheKey)
        previewItem = await requestPreviewAudio(cacheKey, signature, generate)
        await playPreviewFromFile(previewItem.filePath, previewItem.mime)
      }
    } catch (error) {
      console.error('TTS preview failed:', error)
      window.toast?.error?.(t('workflow.tts.previewFailed', '试听失败'))
    } finally {
      setIsPreviewing(false)
    }
  }, [
    advancedPitchValue,
    advancedProvider,
    advancedRateValue,
    advancedStyle,
    advancedVoice,
    advancedZaiVoice,
    pitchValue,
    playPreviewFromFile,
    previewText,
    rateValue,
    requestPreviewAudio,
    t,
    ttsMode,
    unlockPreviewAudioContext,
    voice
  ])

  const handleDownload = useCallback(() => {
    if (audioPath) {
      window.api.file.showItemInFolder(audioPath)
    }
  }, [audioPath])

  const handleSelectHistory = useCallback(
    async (item: HistoryItem) => {
      try {
        await loadAudioFromFile(item.audioPath, item.mime)
      } catch (error) {
        console.error('Failed to load history audio:', error)
        window.toast?.error?.(t('workflow.tts.failed', '生成失败'))
      }
    },
    [loadAudioFromFile, t]
  )

  const handleClearHistory = useCallback(() => {
    setHistoryItems([])
  }, [])

  const isBusy = isGenerating || isPreviewing

  return (
    <>
      <DragBar />
      <audio ref={previewAudioRef} className="hidden" preload="auto" />
      <div className="relative flex h-full w-full flex-col bg-background">
        <div
          className="relative z-10 flex min-h-[72px] items-center gap-4 border-foreground/10 border-b px-6 py-4"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}>
          <div
            className="flex h-10 w-10 items-center justify-center rounded-full bg-content2 text-foreground/60"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <Mic size={18} />
          </div>
          <h1 className="font-semibold text-xl">{t('workflow.tts.title', '语音生成')}</h1>
        </div>

        <div ref={layoutHostRef} className="flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto w-full max-w-6xl overflow-visible">
            <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-6" style={scaledStyle}>
              <div className="space-y-5">
              <div className="flex flex-col items-center gap-4">
                <div className="rounded-2xl border border-white/5 bg-content2/30 p-1.5 backdrop-blur-sm">
                  <Tabs
                    size="lg"
                    selectedKey={ttsMode}
                    onSelectionChange={(key) => {
                      if (!allowAdvanced && key === 'advanced') return
                      setTtsMode(key as 'normal' | 'advanced')
                      // 切换模式时重置筛选，避免沿用上一个模式的筛选导致“区域/音色”跳动
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

                <TtsVoiceConfigCard
                  isGenerating={isBusy}
                  isPreviewing={isPreviewing}
                  onPreview={handlePreview}
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
                  advancedStyle={advancedStyle}
                  setAdvancedStyle={setAdvancedStyle}
                  styleOptions={styleOptions}
                  isLoadingStyles={isLoadingStyles}
                  rateValue={rateValue}
                  setRateValue={setRateValue}
                  pitchValue={pitchValue}
                  setPitchValue={setPitchValue}
                  advancedRateValue={advancedRateValue}
                  setAdvancedRateValue={setAdvancedRateValue}
                  advancedPitchValue={advancedPitchValue}
                  setAdvancedPitchValue={setAdvancedPitchValue}
                />
              </div>

              <Card>
                <CardBody className="space-y-4 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-lg">
                      <FileText size={18} />
                      {t('workflow.tts.text', '文本内容')}
                    </div>
                    <Button
                      size="sm"
                      variant="light"
                      onPress={() => {
                        if (sourceType === 'custom') {
                          setCustomTextValue('')
                        } else {
                          setSourceType('custom')
                          setCustomTextValue(currentText || '')
                        }
                      }}>
                      {t('workflow.tts.clear', '清空')}
                    </Button>
                  </div>

                  <Tabs
                    size="sm"
                    selectedKey={sourceType}
                    onSelectionChange={(key) => setSourceType(key as 'summary' | 'monologue' | 'custom')}
                    variant="underlined">
                    <Tab key="summary" title={t('workflow.character.secondary.bio', '人物志')} />
                    <Tab key="monologue" title={t('workflow.character.secondary.monologue', '心理独白')} />
                    <Tab key="custom" title={t('workflow.tts.custom', '自定义文本')} />
                  </Tabs>

                  <Textarea
                    value={currentText ?? ''}
                    onValueChange={sourceType === 'custom' ? setCustomTextValue : undefined}
                    placeholder={t('workflow.tts.customPlaceholder', '请输入需要合成的文本')}
                    variant="bordered"
                    minRows={8}
                    isReadOnly={sourceType !== 'custom'}
                  />

                  <div className="flex justify-end">
                    <Button
                      color="primary"
                      startContent={<Mic size={16} />}
                      onPress={handleGenerate}
                      isDisabled={!currentText || isBusy}
                      isLoading={isGenerating}>
                      {isGenerating
                        ? t('workflow.tts.generating', '生成中...')
                        : t('workflow.tts.generate', '立即生成')}
                    </Button>
                  </div>
                </CardBody>
              </Card>
            </div>

            <div className="space-y-5">
              {audioUrl && (
                <Card className="border-success-200 bg-success-50">
                  <CardBody className="space-y-4 p-4">
                    <div className="flex items-center gap-2 font-medium text-success-700">
                      <Play size={18} />
                      {t('workflow.tts.result', '生成结果')}
                    </div>

                    <audio controls preload="metadata" className="w-full">
                      <source src={audioUrl} type={audioMime} />
                      {audioPath && <source src={toFileUrl(audioPath)} type={audioMime} />}
                    </audio>

                    <Button
                      variant="flat"
                      color="success"
                      className="w-full"
                      startContent={<Download size={16} />}
                      onPress={handleDownload}>
                      {t('workflow.tts.openFile', '打开文件位置')}
                    </Button>
                  </CardBody>
                </Card>
              )}

              <Card>
                <CardBody className="space-y-4 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-lg">
                      <Play size={18} />
                      {t('workflow.tts.history', '历史记录')}
                    </div>
                    <Button
                      size="sm"
                      variant="light"
                      onPress={handleClearHistory}
                      isDisabled={historyItems.length === 0}>
                      <Trash2 size={14} />
                      {t('workflow.tts.clear', '清空')}
                    </Button>
                  </div>

                  {historyItems.length === 0 ? (
                    <div className="py-6 text-center text-foreground/40 text-sm">
                      {t('workflow.tts.emptyHistory', '暂无历史记录')}
                    </div>
                  ) : (
                    <div className="flex max-h-[520px] flex-col gap-2 overflow-y-auto">
                      {historyItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="rounded-lg border border-divider bg-content1 p-3 text-left transition-colors hover:bg-content2"
                          onClick={() => void handleSelectHistory(item)}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-sm">{item.voiceLabel}</span>
                            <span className="text-foreground/40 text-xs">{formatDate(item.createdAt)}</span>
                          </div>
                          <p className="mt-1 truncate text-foreground/60 text-xs">{item.textPreview}</p>
                          {item.style && (
                            <p className="mt-1 text-foreground/40 text-xs">
                              {t('workflow.tts.style', '风格')}: {item.style}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </div>
      </div>
      </div>
    </>
  )
}

export default TTSGenerator
