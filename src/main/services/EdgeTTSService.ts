import { loggerService } from '@logger'
import { getFilesDir } from '@main/utils/file'
import * as fs from 'fs'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import * as path from 'path'

const logger = loggerService.withContext('EdgeTTSService')

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

  public static getInstance(): EdgeTTSService {
    if (!EdgeTTSService.instance) {
      EdgeTTSService.instance = new EdgeTTSService()
    }
    return EdgeTTSService.instance
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
