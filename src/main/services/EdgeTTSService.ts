import { loggerService } from '@logger'
import { getFilesDir } from '@main/utils/file'
import { app } from 'electron'
import * as fs from 'fs'
import { MsEdgeTTS, OUTPUT_FORMAT, type Voice } from 'msedge-tts'
import * as path from 'path'

const logger = loggerService.withContext('EdgeTTSService')

type VoiceCacheFile = {
  updatedAt: number
  voices: Voice[]
}

type EdgeVoiceRaw = {
  name?: string
  display_name?: string
  local_name?: string
  short_name?: string
  gender?: string
  locale?: string
  locale_name?: string
}

type EdgeVoiceListResult = {
  locales: Array<{
    locale: string
    voices: EdgeVoiceRaw[]
  }>
}

const EDGE_TTS_ZH_LOCAL_NAME_MAP: Record<string, string> = {
  // 标准神经网络 (Neural)
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓逸',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云霞',
  'zh-CN-YunhaoNeural': '云浩',
  'zh-CN-XiaochenNeural': '晓晨',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunyiNeural': '云意',

  // 多语言版 (Multilingual)
  'zh-CN-XiaoxiaoMultilingualNeural': '晓晓多语言',
  'zh-CN-XiaochenMultilingualNeural': '晓晨多语言',
  'zh-CN-XiaoyuMultilingualNeural': '晓语多语言',
  'zh-CN-YunfanMultilingualNeural': '云帆多语言',
  'zh-CN-YunxiaoMultilingualNeural': '云晓多语言',
  'zh-CN-YunyiMultilingualNeural': '云意多语言',

  // 高清版 (HD Flash) - shortName 中带冒号
  'zh-CN-Xiaoxiao:DragonHDFlashLatestNeural': '高清晓晓',
  'zh-CN-Xiaoxiao2:DragonHDFlashLatestNeural': '高清晓晓2',
  'zh-CN-Xiaochen:DragonHDFlashLatestNeural': '高清晓晨',
  'zh-CN-Yunxia:DragonHDFlashLatestNeural': '高清云霞',
  'zh-CN-Yunxiao:DragonHDFlashLatestNeural': '高清云晓',
  'zh-CN-Yunye:DragonHDFlashLatestNeural': '高清云野',
  'zh-CN-Yunyi:DragonHDFlashLatestNeural': '高清云意',

  // 区域与方言
  'zh-CN-XiaoxiaoDialectsNeural': '晓晓方言版',
  'zh-CN-liaoning-XiaobeiNeural': '辽宁-晓北',
  'zh-CN-shaanxi-XiaoniNeural': '陕西-晓妮',
  'zh-CN-Guangxi-YunqiNeural': '广西-云琪',
  'zh-CN-sichuan-YunxiNeural': '四川-云希'
}

const getLocalNameForEdgeTts = (shortName: string, locale: string | undefined, friendlyName: string | undefined) => {
  const mapped = EDGE_TTS_ZH_LOCAL_NAME_MAP[shortName]
  if (mapped) return mapped
  // 只对中文做一些更友好的 fallback；其他语言仍回退为 FriendlyName（大多是英文）
  if (locale?.toLowerCase().startsWith('zh-')) {
    // 例如 zh-CN-XiaoxiaoNeural / zh-CN-Xiaochen:DragonHDFlashLatestNeural
    const parts = shortName.split('-')
    const last = parts[parts.length - 1] || shortName
    return last
  }
  return friendlyName || shortName
}

interface EdgeTTSOptions {
  text: string
  voice: string
  rate?: string // e.g., "+0%", "+10%"
  volume?: string // e.g., "+0%", "+10%"
  pitch?: string // e.g., "+0Hz", "+10Hz"
  outputDir?: string
  filename?: string
}

export class EdgeTTSService {
  private static instance: EdgeTTSService

  private constructor() {}

  private voiceCache: VoiceCacheFile | null = null

  public static getInstance(): EdgeTTSService {
    if (!EdgeTTSService.instance) {
      EdgeTTSService.instance = new EdgeTTSService()
    }
    return EdgeTTSService.instance
  }

  private getCacheDir(): string {
    // 与 advanced-tts 的缓存目录隔离，避免任何耦合。
    return path.join(app.getPath('userData'), 'edge-tts-cache')
  }

  private isCacheFresh(updatedAt: number, ttlMs: number): boolean {
    return Date.now() - updatedAt < ttlMs
  }

  private async readVoiceCache(cachePath: string): Promise<VoiceCacheFile | null> {
    try {
      const content = await fs.promises.readFile(cachePath, 'utf-8')
      const parsed = JSON.parse(content) as VoiceCacheFile
      if (!parsed || typeof parsed.updatedAt !== 'number' || !Array.isArray(parsed.voices)) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  private async writeVoiceCache(cachePath: string, payload: VoiceCacheFile): Promise<void> {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.promises.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf-8')
  }

  private buildVoiceListResult(voices: Voice[]): EdgeVoiceListResult {
    const map = new Map<string, EdgeVoiceRaw[]>()
    for (const voice of voices) {
      const locale = voice.Locale || 'unknown'
      const list = map.get(locale) ?? []
      const localName = getLocalNameForEdgeTts(voice.ShortName, voice.Locale, voice.FriendlyName)
      // 统一输出 snake_case，便于前端复用（与 tts.exe 的 --list-voices 同形）。
      list.push({
        name: voice.Name,
        short_name: voice.ShortName,
        // EdgeTTS 不提供 local_name，这里用本地映射补齐；未命中则回退 FriendlyName/short_name。
        local_name: localName,
        display_name: voice.FriendlyName,
        gender: voice.Gender,
        locale: voice.Locale,
        locale_name: voice.Locale
      })
      map.set(locale, list)
    }
    return {
      locales: Array.from(map.entries())
        .map(([locale, items]) => ({ locale, voices: items }))
        .sort((a, b) => a.locale.localeCompare(b.locale))
    }
  }

  public async listVoices(options?: { forceRefresh?: boolean }): Promise<EdgeVoiceListResult> {
    const ttlMs = 7 * 24 * 60 * 60 * 1000
    const cachePath = path.join(this.getCacheDir(), 'voices.json')

    if (!options?.forceRefresh) {
      if (this.voiceCache && this.isCacheFresh(this.voiceCache.updatedAt, ttlMs)) {
        return this.buildVoiceListResult(this.voiceCache.voices)
      }

      const diskCache = await this.readVoiceCache(cachePath)
      if (diskCache && this.isCacheFresh(diskCache.updatedAt, ttlMs)) {
        this.voiceCache = diskCache
        return this.buildVoiceListResult(diskCache.voices)
      }
    }

    const tts = new MsEdgeTTS({ enableLogger: false })
    try {
      // msedge-tts 内部会走微软在线 voices 接口；这里必须保持“在线拉取”作为数据源。
      const voices = await tts.getVoices()
      const payload: VoiceCacheFile = { updatedAt: Date.now(), voices }
      await this.writeVoiceCache(cachePath, payload)
      this.voiceCache = payload
      logger.info('EdgeTTS voices refreshed', { count: voices.length })
      return this.buildVoiceListResult(voices)
    } finally {
      // 确保释放 ws/资源（即使 getVoices 失败）
      tts.close()
    }
  }

  private getSSML(options: EdgeTTSOptions): string {
    const { text, voice, rate = '+0%', volume = '+0%', pitch = '+0Hz' } = options
    return `
      <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>
        <voice name='${voice}'>
          <prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>
            ${text}
          </prosody>
        </voice>
      </speak>
    `.trim()
  }

  public async generate(options: EdgeTTSOptions): Promise<{ filePath: string; timelinePath: string; duration?: number }> {
    const tts = new MsEdgeTTS({ enableLogger: false })
    const filesDir = getFilesDir()

    try {
      await tts.setMetadata(options.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
        sentenceBoundaryEnabled: true,
        wordBoundaryEnabled: true
      })

      const ssml = this.getSSML(options)

      logger.info(`Generating TTS for voice: ${options.voice}`)

      const { audioFilePath, metadataFilePath } = await tts.rawToFile(filesDir, ssml)

      let finalAudioPath = audioFilePath
      let finalTimelinePath = metadataFilePath

      // Ensure we have a valid timeline path
      if (!finalTimelinePath) {
         const baseName = path.basename(audioFilePath, path.extname(audioFilePath))
         finalTimelinePath = path.join(filesDir, `${baseName}.json`)
         await fs.promises.writeFile(finalTimelinePath, '[]')
      } else {
        // If metadata file exists, verify it's a valid JSON
        if (fs.existsSync(finalTimelinePath)) {
            try {
                const content = await fs.promises.readFile(finalTimelinePath, 'utf-8')
                // Basic check to see if it's JSON; if empty or invalid, write empty array to avoid crashes downstream
                if (!content.trim()) {
                    await fs.promises.writeFile(finalTimelinePath, '[]')
                }
            } catch (e) {
                logger.warn('Failed to read/validate metadata file, resetting to empty array', e as Error)
                await fs.promises.writeFile(finalTimelinePath, '[]')
            }
        }
      }

      // If outputDir is provided, copy files to the target location
      if (options.outputDir) {
        try {
          await fs.promises.mkdir(options.outputDir, { recursive: true })

          const targetFilename = options.filename || path.basename(audioFilePath)
          const targetAudioPath = path.join(options.outputDir, targetFilename)
          const targetTimelineName = path.basename(targetFilename, path.extname(targetFilename)) + '.json'
          const targetTimelinePath = path.join(options.outputDir, targetTimelineName)

          await fs.promises.copyFile(audioFilePath, targetAudioPath)

          if (finalTimelinePath && fs.existsSync(finalTimelinePath)) {
            await fs.promises.copyFile(finalTimelinePath, targetTimelinePath)
          } else {
             await fs.promises.writeFile(targetTimelinePath, '[]')
          }

          finalAudioPath = targetAudioPath
          finalTimelinePath = targetTimelinePath

          logger.info(`Saved TTS files to: ${finalAudioPath}`)
        } catch (err) {
           logger.error('Failed to save TTS files to output dir', err as Error)
        }
      }

      return {
        filePath: finalAudioPath,
        timelinePath: finalTimelinePath
      }
    } catch (error) {
      logger.error('Edge TTS generation failed', error as Error)
      throw error
    } finally {
      tts.close()
    }
  }
}

export const edgeTTSService = EdgeTTSService.getInstance()
