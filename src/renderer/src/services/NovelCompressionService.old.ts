import { createExecutor } from '@readnomore/ai-core'
import { createAiSdkProvider } from '@renderer/aiCore/provider/factory'
import { getActualProvider, providerToAiSdkConfig } from '@renderer/aiCore/provider/providerConfig'
import type { Model } from '@renderer/types'
import type { ModelMessage } from 'ai'

export type CompressionChunk = {
  index: number
  text: string
  start: number
  end: number
  targetLength: number
  compressed?: string
}

export type CompressionStage = 'initializing' | 'compressing' | 'finalizing'

export type CompressionProgress = {
  current: number
  total: number
  percentage: number
  stage: CompressionStage
  chunkIndex?: number
}

export type CompressionUsageMetrics = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  [key: string]: number | undefined
}

export interface CompressionChunkEvent {
  chunk: CompressionChunk
  index: number
  total: number
  startedAt: number
  finishedAt?: number
  durationMs?: number
  usage?: CompressionUsageMetrics
}

export type CompressionLogLevel = 'info' | 'warning' | 'error'

export interface CompressionLogEntry {
  id: string
  timestamp: number
  level: CompressionLogLevel
  message: string
  data?: Record<string, unknown>
}

export interface CompressionCallbacks {
  onStart?: (payload: { totalChunks: number }) => void
  onProgress?: (progress: CompressionProgress) => void
  onChunkStart?: (event: CompressionChunkEvent) => void
  onChunkCompressed?: (event: CompressionChunkEvent) => void
  onLog?: (entry: CompressionLogEntry) => void
}

export interface NovelCompressionOptions {
  ratio: number
  chunkSize: number
  overlap: number
  temperature: number
  signal?: AbortSignal
}

export interface NovelCompressionResult {
  merged: string
  chunks: CompressionChunk[]
}

export class NovelCompressionError extends Error {
  constructor(message: string, public detail?: unknown) {
    super(message)
    this.name = 'NovelCompressionError'
  }
}

export function splitTextIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number,
  ratio: number
): CompressionChunk[] {
  const normalizedChunkSize = Math.max(500, Math.floor(chunkSize))
  const normalizedOverlap = clamp(Math.floor(overlap), 0, normalizedChunkSize - 1)
  const normalizedRatio = clamp(ratio, 0.05, 0.9)

  const chunks: CompressionChunk[] = []
  let start = 0
  let index = 0

  while (start < text.length) {
    const end = Math.min(text.length, start + normalizedChunkSize)
    const chunkText = text.slice(start, end).trim()

    if (chunkText.length > 0) {
      const targetLength = Math.max(120, Math.round(chunkText.length * normalizedRatio))
      chunks.push({ index, text: chunkText, start, end, targetLength })
      index += 1
    }

    if (end >= text.length) {
      break
    }

    const nextStart = end - normalizedOverlap
    start = nextStart > start ? nextStart : end
  }

  return chunks
}

export function buildCompressionMessages(chunk: CompressionChunk, ratio: number): ModelMessage[] {
  const percentage = Math.round(clamp(ratio, 0.05, 0.9) * 100)
  const systemPrompt =
    '你是一名资深小说编辑，擅长在保持叙事逻辑和人物性格的前提下，将长篇文本阅读为紧凑的中文段落。请保留故事主线、关键事件与情感张力，确保语言流畅自然。'
  const userPrompt = `请将以下内容阅读到原文字数的约 ${percentage}%（目标字数约 ${chunk.targetLength} 字），要求：\n1. 保留人物名称、称谓与关键事件。\n2. 保持时间顺序与因果关系清晰。\n3. 避免添加与原文不一致的情节或设定。\n4. 输出为自然流畅的中文段落，不要添加额外解释、标题或列表。\n\n原文片段：\n${chunk.text}`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

export async function compressNovelWithModel(
  model: Model,
  content: string,
  options: NovelCompressionOptions,
  callbacks?: CompressionCallbacks
): Promise<NovelCompressionResult> {
  if (!model) {
    throw new NovelCompressionError('未选择任何模型')
  }
  if (!content || content.trim().length === 0) {
    throw new NovelCompressionError('文本内容为空，无法阅读')
  }

  callbacks?.onLog?.(
    createLogEntry('info', '开始准备阅读任务', {
      contentLength: content.length,
      requestedRatio: options.ratio,
      chunkSize: options.chunkSize,
      overlap: options.overlap
    })
  )

  const normalizedRatio = clamp(options.ratio, 0.05, 0.9)
  const normalizedChunkSize = Math.max(500, Math.floor(options.chunkSize))
  const normalizedOverlap = clamp(Math.floor(options.overlap), 0, normalizedChunkSize - 1)
  const normalizedTemperature = clamp(options.temperature, 0, 1.5)

  callbacks?.onLog?.(
    createLogEntry('info', '正在拆解文本为分块', {
      normalizedChunkSize,
      normalizedOverlap
    })
  )

  const chunks = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, normalizedRatio)

  callbacks?.onLog?.(
    createLogEntry('info', '文本分块完成', {
      chunkCount: chunks.length
    })
  )

  if (chunks.length === 0) {
    throw new NovelCompressionError('无法根据当前设置生成有效的文本分块')
  }

  const totalChunks = chunks.length
  callbacks?.onStart?.({ totalChunks })
  callbacks?.onProgress?.({
    current: 0,
    total: totalChunks,
    percentage: 0,
    stage: 'initializing'
  })
  callbacks?.onLog?.(
    createLogEntry('info', '开始初始化阅读任务', {
      totalChunks,
      ratio: normalizedRatio,
      chunkSize: normalizedChunkSize,
      overlap: normalizedOverlap
    })
  )

  const provider = getActualProvider(model)
  const config = providerToAiSdkConfig(provider, model)
  const providerConfig = {
    providerId: config.providerId,
    options: { ...config.options }
  }

  let languageModel: any
  let executor: ReturnType<typeof createExecutor>

  try {
    const localProvider = await createAiSdkProvider({ ...providerConfig })
    if (!localProvider) {
      throw new Error('Provider创建失败')
    }

    languageModel = localProvider.languageModel(model.id)
    if (!languageModel) {
      throw new Error(`模型 ${model.id} 不可用`)
    }

    executor = createExecutor(providerConfig.providerId, providerConfig.options, [])
    callbacks?.onLog?.(
      createLogEntry('info', '模型初始化完成', {
        modelId: model.id,
        providerId: providerConfig.providerId
      })
    )
  } catch (error) {
    const serialized = serializeError(error)
    callbacks?.onLog?.(createLogEntry('error', '模型初始化失败', { error: serialized }))
    throw new NovelCompressionError('模型初始化失败', serialized)
  }

  const compressedChunks: CompressionChunk[] = []

  for (let i = 0; i < totalChunks; i += 1) {
    const chunk = chunks[i]
    const startedAt = Date.now()

    const startEvent: CompressionChunkEvent = {
      chunk,
      index: i,
      total: totalChunks,
      startedAt
    }

    callbacks?.onChunkStart?.(startEvent)
    callbacks?.onLog?.(
      createLogEntry('info', `开始阅读第 ${i + 1}/${totalChunks} 段`, {
        chunkIndex: i,
        inputLength: chunk.text.length,
        targetLength: chunk.targetLength
      })
    )
    callbacks?.onProgress?.({
      current: i,
      total: totalChunks,
      percentage: calculatePercentage(i, totalChunks),
      stage: 'compressing',
      chunkIndex: i
    })

    try {
      const response = await executor.generateText({
        model: languageModel,
        messages: buildCompressionMessages(chunk, normalizedRatio),
        temperature: normalizedTemperature,
        maxOutputTokens: Math.max(256, Math.round(chunk.targetLength * 1.5)),
        abortSignal: options.signal
      })

      if (!response) {
        throw new Error(`第${i + 1}段：模型返回空响应`)
      }

      const compressedText = (response as any).text?.trim?.() ?? ''
      if (!compressedText) {
        throw new Error(`第${i + 1}段：模型返回空文本`)
      }

      const finishedAt = Date.now()
      const usage = extractUsageMetrics(response)
      const compressedChunk: CompressionChunk = { ...chunk, compressed: compressedText }
      compressedChunks.push(compressedChunk)

      const completeEvent: CompressionChunkEvent = {
        chunk: compressedChunk,
        index: i,
        total: totalChunks,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        usage
      }

      callbacks?.onChunkCompressed?.(completeEvent)
      callbacks?.onLog?.(
        createLogEntry('info', `完成阅读第 ${i + 1}/${totalChunks} 段`, {
          chunkIndex: i,
          durationMs: completeEvent.durationMs,
          usage
        })
      )
      callbacks?.onProgress?.({
        current: i + 1,
        total: totalChunks,
        percentage: calculatePercentage(i + 1, totalChunks),
        stage: 'compressing',
        chunkIndex: i
      })
    } catch (error) {
      const serialized = serializeError(error)
      callbacks?.onLog?.(
        createLogEntry('error', `阅读第 ${i + 1}/${totalChunks} 段失败`, {
          chunkIndex: i,
          error: serialized
        })
      )

      if (isAbortError(error)) {
        throw new NovelCompressionError('阅读已被取消', serialized)
      }

      const errorMessage = `在处理第${i + 1}/${totalChunks}段时出错: ${serialized.message}`
      throw new NovelCompressionError(errorMessage, {
        ...serialized,
        chunkIndex: i,
        totalChunks,
        chunkText: chunk.text.substring(0, 100) + (chunk.text.length > 100 ? '...' : '')
      })
    }
  }

  callbacks?.onProgress?.({
    current: totalChunks,
    total: totalChunks,
    percentage: 100,
    stage: 'finalizing'
  })
  callbacks?.onLog?.(createLogEntry('info', '阅读任务完成', { totalChunks }))

  const merged = compressedChunks.map((chunk) => chunk.compressed).filter(Boolean).join('\n\n')
  return { merged, chunks: compressedChunks }
}

function calculatePercentage(current: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)))
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

function isAbortError(error: unknown): error is { name: string } {
  return typeof error === 'object' && error !== null && 'name' in (error as any) && (error as any).name === 'AbortError'
}

function extractUsageMetrics(response: any): CompressionUsageMetrics | undefined {
  const usageSource = response?.usage ?? response?.response?.usage
  if (!usageSource || typeof usageSource !== 'object') {
    return undefined
  }

  const usage: CompressionUsageMetrics = {}
  for (const [key, value] of Object.entries(usageSource)) {
    if (typeof value === 'number') {
      usage[key] = value
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined
}

function createLogEntry(
  level: CompressionLogLevel,
  message: string,
  data?: Record<string, unknown>
): CompressionLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    level,
    message,
    data
  }
}

export function serializeError(error: unknown): { message: string; stack?: string; data?: any } {
  if (!error) return { message: 'Unknown error' }
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    }
  }
  if (typeof error === 'object') {
    const plain = { ...(error as Record<string, any>) }
    return {
      message: plain.message ?? JSON.stringify(plain),
      stack: plain.stack,
      data: plain
    }
  }
  return { message: String(error) }
}
