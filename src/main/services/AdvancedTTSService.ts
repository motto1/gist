import { loggerService } from '@logger'
import { getResourcePath } from '@main/utils'
import { getFilesDir, getTempDir } from '@main/utils/file'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const logger = loggerService.withContext('AdvancedTTSService')

interface AdvancedTTSOptions {
  text?: string
  textFilePath?: string
  voice: string
  style?: string
  rate?: string
  pitch?: string
  region?: string
  outputDir?: string
  filename?: string
}

interface AdvancedTTSResult {
  filePath: string
  timelinePath: string
}

interface VoiceListResult {
  locales: Array<{
    locale: string
    voices: Array<{
      name?: string
      display_name?: string
      local_name?: string
      short_name?: string
      gender?: string
      locale?: string
      locale_name?: string
      style_list?: string[]
      sample_rate_hertz?: string
    }>
  }>
}

interface VoiceStylesResult {
  short_name: string
  display_name?: string
  locale?: string
  gender?: string
  styles: string[]
}

interface CacheSignature {
  exePath: string
  exeMtimeMs: number
  exeSize: number
}

interface VoiceCacheFile<T> {
  updatedAt: number
  data: T
  signature?: CacheSignature
}

const ALIGN_MODEL_DIR_NAME = 'sherpa-onnx-streaming-zipformer-small-ctc-zh-2025-04-01'
const CACHE_DIR_NAME = 'tts-cache'
const VOICES_CACHE_FILE = 'voices.json'
const VOICE_STYLES_CACHE_DIR = 'voice-styles'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const resolveTtsDir = (): string => {
  const exeName = process.platform === 'win32' ? 'tts.exe' : 'tts'

  const appRoot = app.getAppPath()
  const unpackedRoot = path.join(path.dirname(appRoot), 'app.asar.unpacked')
  const isAsarApp = /app\.asar($|[\\/])/.test(appRoot)

  // NOTE: 可执行文件不能从 app.asar 内直接运行；fs.existsSync(asarı路径) 可能为 true，
  // 但 spawn 会失败（ENOENT）。因此打包环境优先使用 app.asar.unpacked / resources。
  const candidates = [
    path.join(process.cwd(), 'tts'),
    path.join(unpackedRoot, 'tts'),
    path.join(path.dirname(app.getPath('exe')), 'tts'),
    path.join(getResourcePath(), 'tts'),
    ...(isAsarApp ? [] : [path.join(appRoot, 'tts')])
  ]

  for (const candidate of candidates) {
    const exePath = path.join(candidate, exeName)
    const looksLikeAsarPath = /app\.asar($|[\\/])/.test(exePath) && !/app\.asar\.unpacked($|[\\/])/.test(exePath)
    if (looksLikeAsarPath) continue
    try {
      if (fs.existsSync(exePath) && fs.statSync(exePath).isFile()) return candidate
    } catch {
      // ignore
    }
  }

  return candidates[0]
}

const resolveAlignModelDir = (ttsDir: string): string | null => {
  const direct = path.join(ttsDir, ALIGN_MODEL_DIR_NAME)
  if (fs.existsSync(direct)) return direct

  const nested = path.join(ttsDir, 'speech_timestamp_prediction-v1-16k-offline', ALIGN_MODEL_DIR_NAME)
  if (fs.existsSync(nested)) return nested

  return null
}

const ensureWavFilename = (name: string) => {
  const trimmed = name.trim()
  if (!trimmed) return `tts-${Date.now()}.wav`
  if (trimmed.toLowerCase().endsWith('.wav')) return trimmed
  const ext = path.extname(trimmed)
  if (!ext) return `${trimmed}.wav`
  return trimmed.slice(0, -ext.length) + '.wav'
}

const runProcess = (command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const detail = stderr.trim() || stdout.trim()
        reject(new Error(detail ? `tts.exe 执行失败（${code}）：${detail}` : `tts.exe 执行失败（${code}）`))
      }
    })
  })
}

const extractJsonFromOutput = (output: string): unknown => {
  const trimmed = output.trim()
  if (!trimmed) {
    throw new Error('tts.exe 输出为空，无法解析 JSON')
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const jsonText = trimmed.slice(start, end + 1)
      return JSON.parse(jsonText)
    }
    throw new Error('tts.exe 输出不是有效 JSON')
  }
}

export class AdvancedTTSService {
  private static instance: AdvancedTTSService
  private voiceCache: VoiceCacheFile<VoiceListResult> | null = null
  private voiceStylesCache = new Map<string, VoiceCacheFile<VoiceStylesResult>>()

  private constructor() {}

  public static getInstance(): AdvancedTTSService {
    if (!AdvancedTTSService.instance) {
      AdvancedTTSService.instance = new AdvancedTTSService()
    }
    return AdvancedTTSService.instance
  }

  private async resolveInputText(options: AdvancedTTSOptions): Promise<{ path: string; isTemp: boolean }> {
    if (options.textFilePath && fs.existsSync(options.textFilePath)) {
      return { path: options.textFilePath, isTemp: false }
    }

    if (!options.text?.trim()) {
      throw new Error('缺少文本内容')
    }

    const tempDir = getTempDir()
    await fs.promises.mkdir(tempDir, { recursive: true })
    const filePath = path.join(tempDir, `tts-input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    await fs.promises.writeFile(filePath, options.text, 'utf-8')
    return { path: filePath, isTemp: true }
  }

  private getCacheDir(): string {
    return path.join(app.getPath('userData'), CACHE_DIR_NAME)
  }

  private isCacheFresh(updatedAt: number): boolean {
    return Date.now() - updatedAt < CACHE_TTL_MS
  }

  private resolveExe(): { ttsDir: string; exePath: string; signature: CacheSignature } {
    const ttsDir = resolveTtsDir()
    const exePath = path.join(ttsDir, process.platform === 'win32' ? 'tts.exe' : 'tts')
    if (!fs.existsSync(exePath)) {
      throw new Error(`未找到 tts 可执行文件：${exePath}`)
    }
    const stat = fs.statSync(exePath)
    return {
      ttsDir,
      exePath,
      signature: {
        exePath,
        exeMtimeMs: stat.mtimeMs,
        exeSize: stat.size
      }
    }
  }

  private isSignatureMatch(signature: CacheSignature | undefined, current: CacheSignature): boolean {
    if (!signature) return false
    return signature.exeMtimeMs === current.exeMtimeMs && signature.exeSize === current.exeSize
  }

  private async readCacheFile<T>(filePath: string): Promise<VoiceCacheFile<T> | null> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as VoiceCacheFile<T>
      if (!parsed?.data || !parsed.updatedAt) return null
      return parsed
    } catch {
      return null
    }
  }

  private async writeCacheFile<T>(filePath: string, payload: VoiceCacheFile<T>): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  }

  private getStylesCachePath(voice: string): string {
    const safeName = encodeURIComponent(voice)
    return path.join(this.getCacheDir(), VOICE_STYLES_CACHE_DIR, `${safeName}.json`)
  }

  private async fetchVoicesFromExe(): Promise<VoiceListResult> {
    const { ttsDir, exePath } = this.resolveExe()
    const { stdout } = await runProcess(exePath, ['--list-voices'], ttsDir)
    return extractJsonFromOutput(stdout) as VoiceListResult
  }

  public async listVoices(options?: { forceRefresh?: boolean }): Promise<VoiceListResult> {
    const { signature } = this.resolveExe()
    if (!options?.forceRefresh) {
      if (this.voiceCache && this.isCacheFresh(this.voiceCache.updatedAt) && this.isSignatureMatch(this.voiceCache.signature, signature)) {
        return this.voiceCache.data
      }

      const cachePath = path.join(this.getCacheDir(), VOICES_CACHE_FILE)
      const cached = await this.readCacheFile<VoiceListResult>(cachePath)
      if (cached && this.isCacheFresh(cached.updatedAt) && this.isSignatureMatch(cached.signature, signature)) {
        this.voiceCache = cached
        return cached.data
      }
    }

    const data = await this.fetchVoicesFromExe()
    const payload: VoiceCacheFile<VoiceListResult> = { updatedAt: Date.now(), data, signature }
    const cachePath = path.join(this.getCacheDir(), VOICES_CACHE_FILE)
    await this.writeCacheFile(cachePath, payload)
    this.voiceCache = payload
    // 当 voices 刷新时，清理 styles 内存缓存，避免沿用旧 exe 的 voice/style 关系。
    this.voiceStylesCache.clear()
    return data
  }

  public async getVoiceStyles(voice: string): Promise<VoiceStylesResult> {
    const { ttsDir, exePath, signature } = this.resolveExe()
    const cached = this.voiceStylesCache.get(voice)
    if (cached && this.isCacheFresh(cached.updatedAt) && this.isSignatureMatch(cached.signature, signature)) {
      return cached.data
    }

    const cachePath = this.getStylesCachePath(voice)
    const diskCache = await this.readCacheFile<VoiceStylesResult>(cachePath)
    if (diskCache && this.isCacheFresh(diskCache.updatedAt) && this.isSignatureMatch(diskCache.signature, signature)) {
      this.voiceStylesCache.set(voice, diskCache)
      return diskCache.data
    }

    const hasVoice = (data: VoiceListResult, target: string) =>
      data.locales?.some((locale) => (locale.voices || []).some((item) => item.short_name === target))

    try {
      const currentList = await this.listVoices()
      if (!hasVoice(currentList, voice)) {
        const refreshed = await this.listVoices({ forceRefresh: true })
        if (!hasVoice(refreshed, voice)) {
          logger.warn('Advanced TTS voice missing, skip style fetch', { voice })
          const data: VoiceStylesResult = { short_name: voice, styles: [] }
          const payload: VoiceCacheFile<VoiceStylesResult> = { updatedAt: Date.now(), data }
          await this.writeCacheFile(cachePath, payload)
          this.voiceStylesCache.set(voice, payload)
          return data
        }
      }
    } catch (error) {
      logger.warn('Advanced TTS voice list check failed', {
        voice,
        error: (error as Error).message
      })
    }

    try {
      const { stdout } = await runProcess(exePath, ['--voice-styles', voice], ttsDir)
      const data = extractJsonFromOutput(stdout) as VoiceStylesResult
      const payload: VoiceCacheFile<VoiceStylesResult> = { updatedAt: Date.now(), data, signature }
      await this.writeCacheFile(cachePath, payload)
      this.voiceStylesCache.set(voice, payload)
      return data
    } catch (error) {
      const message = (error as Error).message
      if (message.includes('未找到语音') || message.toLowerCase().includes('not found')) {
        try {
          const refreshed = await this.listVoices({ forceRefresh: true })
          const exists = refreshed.locales?.some((locale) =>
            (locale.voices || []).some((item) => item.short_name === voice)
          )
          if (exists) {
            const { stdout } = await runProcess(exePath, ['--voice-styles', voice], ttsDir)
            const data = extractJsonFromOutput(stdout) as VoiceStylesResult
            const payload: VoiceCacheFile<VoiceStylesResult> = { updatedAt: Date.now(), data, signature }
            await this.writeCacheFile(cachePath, payload)
            this.voiceStylesCache.set(voice, payload)
            return data
          }
        } catch (retryError) {
          logger.warn('Advanced TTS voice styles retry failed', {
            voice,
            error: (retryError as Error).message
          })
        }
      }

      logger.warn('Advanced TTS voice styles fallback', {
        voice,
        error: message
      })

      const voiceCache = this.voiceCache ?? await this.readCacheFile<VoiceListResult>(path.join(this.getCacheDir(), VOICES_CACHE_FILE))
      const fallbackStyles =
        voiceCache?.data?.locales
          ?.flatMap((locale) => locale.voices || [])
          ?.find((item) => item.short_name === voice)
          ?.style_list ?? []

      const data: VoiceStylesResult = {
        short_name: voice,
        styles: fallbackStyles
      }
      const payload: VoiceCacheFile<VoiceStylesResult> = { updatedAt: Date.now(), data, signature }
      await this.writeCacheFile(cachePath, payload)
      this.voiceStylesCache.set(voice, payload)
      return data
    }
  }

  public async generate(options: AdvancedTTSOptions): Promise<AdvancedTTSResult> {
    const ttsDir = resolveTtsDir()
    const exePath = path.join(ttsDir, process.platform === 'win32' ? 'tts.exe' : 'tts')

    if (!fs.existsSync(exePath)) {
      throw new Error(`未找到 tts 可执行文件：${exePath}`)
    }

    const alignModelDir = resolveAlignModelDir(ttsDir)
    if (!alignModelDir) {
      throw new Error('未找到对齐模型目录，请检查 tts 目录是否完整')
    }

    const tempDir = getTempDir()
    await fs.promises.mkdir(tempDir, { recursive: true })

    const cleanup: string[] = []
    try {
      const input = await this.resolveInputText(options)
      if (input.isTemp) cleanup.push(input.path)

      const outputDir = options.outputDir || getFilesDir()
      await fs.promises.mkdir(outputDir, { recursive: true })

      const filename = ensureWavFilename(options.filename || `tts-${Date.now()}.wav`)
      const outputPath = path.join(outputDir, filename)
      const timelinePath = path.join(outputDir, `${path.basename(filename, path.extname(filename))}.json`)

      const config = {
        region: options.region ?? 'eastasia',
        voice: options.voice,
        style: options.style ?? 'general',
        rate: options.rate ?? '0',
        pitch: options.pitch ?? '0',
        align_model_dir: alignModelDir
      }

      const configPath = path.join(tempDir, `tts-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
      cleanup.push(configPath)

      logger.info('Advanced TTS start', {
        exePath,
        voice: config.voice,
        style: config.style,
        rate: config.rate,
        pitch: config.pitch,
        region: config.region,
        outputDir,
        filename,
        textFile: path.basename(input.path),
        textLength: options.text?.length ?? null,
        alignModelDir
      })
      await runProcess(exePath, ['-i', input.path, '-o', outputPath, '--timestamps', timelinePath, '-c', configPath], ttsDir)

      return { filePath: outputPath, timelinePath }
    } catch (error) {
      logger.error('Advanced TTS failed', error as Error)
      throw error
    } finally {
      await Promise.all(
        cleanup.map(async (filePath) => {
          try {
            await fs.promises.unlink(filePath)
          } catch {
            // ignore cleanup errors
          }
        })
      )
    }
  }
}

export const advancedTTSService = AdvancedTTSService.getInstance()
