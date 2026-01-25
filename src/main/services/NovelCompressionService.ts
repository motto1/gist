import { loggerService } from '@logger'
import { AsyncMutex, processConcurrently } from '@main/utils/async-mutex'
import { parseChapters, splitTextByChapters } from '@main/utils/chapter-parser'
import { readTextFileWithAutoEncoding, sanitizeFilename } from '@main/utils/file'
import { createLogEntry } from '@main/utils/log-buffer'
import { clamp, splitTextIntoChunks as baseSplitTextIntoChunks } from '@main/utils/novel-utils'
import { IpcChannel } from '@shared/IpcChannel'
import type {
  ChapterInfo,
  CompressionChunk,
  CompressionLogEntry,
  NovelCompressionResult
} from '@shared/types'
import type { Model, Provider } from '@types'
import type { ModelMessage } from 'ai'
import { BrowserWindow, ipcMain, Notification } from 'electron'
import fs from 'fs/promises'
import path from 'path'

import {
  clearAllProviders,
  createAndRegisterProvider,
  type ProviderId
} from '../../../packages/aiCore/src/core/providers'
import { createExecutor } from '../../../packages/aiCore/src/core/runtime'
import { novelCompressionMemoryService } from './NovelCompressionMemoryService'

const logger = loggerService.withContext('NovelCompressionService')
let abortController = new AbortController()

type StartOptions = { autoRetry?: boolean }

const compressionRunDirByTaskKey = new Map<string, string>()
let currentStartOptions: StartOptions = {}

export interface NovelCompressionOptions {
  ratio: number
  chunkSize: number
  overlap: number
  temperature: number
  maxConcurrency?: number  // 每个模型的最大并发数，默认8
  signal?: AbortSignal
  resumeFromChunk?: number
  maxRetries?: number
  retryDelay?: number
  models?: Model[]
  providers?: Provider[]
  enableModelRotation?: boolean
  customPrompt?: string
}

type ModelExecutor = {
  model: Model
  provider: Provider
  executor: any
  providerId: ProviderId
  providerOptions: any
  index: number  // 执行器在数组中的索引，用于健康度追踪
}

// 模型健康度管理
interface ModelHealth {
  modelId: string
  successCount: number
  failureCount: number
  totalAttempts: number
  successRate: number
  lastError?: string
  isHealthy: boolean
}

// 默认并发限制：每个模型一次最多处理8个分块
const DEFAULT_MAX_CONCURRENT_CHUNKS_PER_MODEL = 8

// 分块最大重试次数（跨所有模型）
const MAX_CHUNK_RETRIES = 10

/**
 * 模型健康检查配置
 */
const MODEL_HEALTH_CONFIG = {
  /** 连续失败多少次后标记为不健康 */
  MAX_CONSECUTIVE_FAILURES: 3,
  /** 最小尝试次数（用于计算成功率） */
  MIN_ATTEMPTS_FOR_RATE: 5,
  /** 成功率低于此阈值标记为不健康 */
  MIN_SUCCESS_RATE: 0.3
} as const

/**
 * Per-Model Worker: 每个模型独立运行，最多8个并发
 *
 * 核心设计：
 * - 每个worker有8个"任务槽"（类似goroutine）
 * - 阶段1: 处理专属初始任务（均匀分配）
 * - 阶段2: 处理共享队列中的失败任务
 * - 健康模型快速处理，自动获得更多任务
 * - 总并发数 = n × 8
 */
async function runModelWorker(
  executor: ModelExecutor,
  initialTasks: number[],      // 专属初始任务
  sharedQueue: number[],        // 共享失败任务队列
  queueMutex: AsyncMutex,       // 队列访问互斥锁
  initialTasksMutex: AsyncMutex, // initialTasks 访问互斥锁
  modelHealthMutex: AsyncMutex, // 模型健康度互斥锁（保护 modelHealth 对象）
  chunks: Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[],
  normalizedRatio: number,
  normalizedTemperature: number,
  totalChunks: number,
  outputDir: string,
  baseName: string,
  options: NovelCompressionOptions,
  modelHealthMap: Map<string, ModelHealth>,
  compressedChunks: CompressionChunk[],
  incrementCompleted: () => Promise<number>,  // 改为异步
  chunkRetryCount: Map<number, number>,
  maxChunkRetries: number,
  maxConcurrentPerModel: number,  // 每个模型的最大并发数
  signal: AbortSignal | undefined,
  memoryService: typeof novelCompressionMemoryService,
  generateModelHealthStats: () => any[],  // 生成健康度统计的函数
  useChapterMode: boolean = false  // 是否使用章节模式 Prompt
): Promise<void> {
  const healthKey = `${executor.index}`
  const modelHealth = modelHealthMap.get(healthKey)!

  // 日志批处理缓冲区，减少状态更新频率
  const logBuffer: CompressionLogEntry[] = []
  const logMutex = new AsyncMutex()  // 保护 logBuffer
  const LOG_BATCH_SIZE = 10  // 每10条日志批量更新一次

  const flushLogs = async () => {
    await logMutex.runExclusive(async () => {
      if (logBuffer.length > 0) {
        memoryService.updateState({
          logs: [...memoryService.getState().logs, ...logBuffer]
        })
        logBuffer.length = 0  // 清空缓冲区
      }
    })
  }

  const addLog = async (entry: CompressionLogEntry) => {
    await logMutex.runExclusive(async () => {
      logBuffer.push(entry)
      if (logBuffer.length >= LOG_BATCH_SIZE) {
        // 在锁内刷新，避免死锁：先拷贝再清空
        const toFlush = [...logBuffer]
        logBuffer.length = 0
        // 在锁外更新状态
        memoryService.updateState({
          logs: [...memoryService.getState().logs, ...toFlush]
        })
      }
    })
  }

  logger.info(`Worker #${executor.index} 启动`, {
    model: executor.model.name,
    maxConcurrency: maxConcurrentPerModel,
    initialTasksCount: initialTasks.length,
    taskRange: initialTasks.length > 0 ? `${initialTasks[0] + 1}-${initialTasks[initialTasks.length - 1] + 1}` : 'none',
    healthKey
  })

  await addLog(createLogEntry('info', `Worker #${executor.index} ${executor.model.name} 启动`, {
    workerIndex: executor.index,
    model: executor.model.name,
    initialTasks: initialTasks.length,
    taskRange: initialTasks.length > 0 ? `${initialTasks[0] + 1}-${initialTasks[initialTasks.length - 1] + 1}` : 'none'
  }))

  // 创建任务槽，每个槽持续从共享队列获取任务
  const workerSlots: Promise<void>[] = []

  for (let slotId = 0; slotId < maxConcurrentPerModel; slotId++) {
    const slotPromise = (async () => {
      logger.info(`Worker #${executor.index} Slot ${slotId} 启动`)

      while (true) {
        if (signal?.aborted) {
          logger.info(`Worker #${executor.index} Slot ${slotId} 收到取消信号`)
          break
        }

        // 检查模型健康度 - 不健康立即停止，释放资源给其他模型
        if (!modelHealth.isHealthy) {
          // 使用互斥锁保护任务转移操作，避免竞态条件
          await initialTasksMutex.runExclusive(async () => {
            if (initialTasks.length > 0) {
              const tasksToTransfer = [...initialTasks]
              initialTasks.length = 0  // 先清空，避免其他Slot同时访问

              // 使用队列锁保护 sharedQueue 的写入
              await queueMutex.runExclusive(async () => {
                sharedQueue.push(...tasksToTransfer)
              })

              logger.warn(`Worker #${executor.index} Slot ${slotId} 将${tasksToTransfer.length}个未完成任务转移到共享队列`, {
                transferredTasks: tasksToTransfer.length
              })
            }
          })

          logger.warn(`Worker #${executor.index} Slot ${slotId} 模型不健康，停止工作，释放资源`, {
            failureCount: modelHealth.failureCount,
            successRate: `${Math.round(modelHealth.successRate * 100)}%`,
            sharedQueueLength: sharedQueue.length
          })

          await addLog(createLogEntry('warning', `Worker #${executor.index} Slot ${slotId} 因健康度下降停止，未完成任务转移到共享队列`, {
            model: executor.model.name,
            workerIndex: executor.index,
            slotId,
            failureCount: modelHealth.failureCount,
            successRate: `${Math.round(modelHealth.successRate * 100)}%`,
            sharedQueueLength: sharedQueue.length
          }))
          await flushLogs()  // 立即刷新日志，因为worker即将退出
          break
        }

        // 使用互斥锁原子地获取任务：先从专属队列，再从共享队列
        const taskInfo = await initialTasksMutex.runExclusive(async () => {
          let chunkIndex = initialTasks.shift()
          let fromSharedQueue = false

          if (chunkIndex === undefined) {
            // 专属队列为空，尝试从共享队列获取
            chunkIndex = await queueMutex.runExclusive(async () => {
              return sharedQueue.shift()
            })
            fromSharedQueue = true
          }

          return { chunkIndex, fromSharedQueue }
        })

        const { chunkIndex, fromSharedQueue } = taskInfo

        if (chunkIndex === undefined) {
          // 两个队列都为空，退出循环
          logger.info(`Worker #${executor.index} Slot ${slotId} 所有队列为空，完成工作`)
          break
        }

        logger.info(`Worker #${executor.index} Slot ${slotId} 获取分块${chunkIndex + 1}`, {
          source: fromSharedQueue ? 'shared-queue' : 'initial-tasks',
          remainingInitial: initialTasks.length,
          remainingShared: sharedQueue.length
        })

        // 检查该分块的全局重试次数
        const currentRetries = chunkRetryCount.get(chunkIndex) || 0
        if (currentRetries >= maxChunkRetries) {
          logger.error(`Worker #${executor.index} Slot ${slotId} 分块${chunkIndex + 1}已达最大重试次数${maxChunkRetries}，标记为彻底失败`, {
            chunkIndex,
            retries: currentRetries,
            maxRetries: maxChunkRetries
          })

          memoryService.updateState({
            chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
              idx === chunkIndex ? {
                ...cs,
                status: 'error',
                errorMessage: `所有模型尝试均失败（${currentRetries}次重试）`
              } : cs
            )
          })

          await addLog(createLogEntry('error', `分块${chunkIndex + 1}已达最大重试次数，彻底失败`, {
            chunkIndex,
            retries: currentRetries,
            maxRetries: maxChunkRetries
          }))

          // 不放回队列，继续处理下一个任务
          continue
        }

        // 增加重试计数
        chunkRetryCount.set(chunkIndex, currentRetries + 1)

        // 处理该分块
        const maxRetries = 2
        let success = false

        for (let retry = 0; retry <= maxRetries && !success; retry++) {
          if (signal?.aborted) {
            // 使用互斥锁将任务放回共享队列
            await queueMutex.runExclusive(async () => {
              sharedQueue.unshift(chunkIndex)
            })
            throw new NovelCompressionError('用户取消了阅读任务')
          }

          try {
            const chunk = chunks[chunkIndex]
            const startTime = Date.now()

            memoryService.updateState({
              chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
                idx === chunkIndex ? {
                  ...cs,
                  status: 'processing',
                  startedAt: startTime,
                  model: `#${executor.index} ${executor.model.name}`
                } : cs
              )
            })

            logger.info(`Worker #${executor.index} Slot ${slotId} 处理分块${chunkIndex + 1} (重试${retry}/${maxRetries})`, {
              chunkIndex,
              executorIndex: executor.index,
              slotId,
              attempt: retry + 1
            })

            // 根据分块模式选择 Prompt
            const messages = useChapterMode
              ? buildChapterAwareCompressionMessages(
                  chunk,
                  normalizedRatio,
                  options.customPrompt,
                  chunkIndex === totalChunks - 1
                )
              : buildCompressionMessages(
                  chunk,
                  normalizedRatio,
                  options.customPrompt,
                  chunkIndex === totalChunks - 1
                )

            const response = await createCancellablePromise<GenerateTextResponse>(
              executor.executor.generateText({
                model: executor.model.id,
                messages,
                temperature: normalizedTemperature,
                signal
              }),
              signal!
            )

            if (!response) throw new Error(`第${chunkIndex + 1}段：模型返回空响应`)
            const compressedText = response.text?.trim() ?? ''
            if (!compressedText) {
              throw new Error(`第${chunkIndex + 1}段：模型返回空文本`)
            }

            const completedAt = Date.now()
            const durationMs = completedAt - startTime
            const compressedChunk: CompressionChunk = { ...chunk, compressed: compressedText }

            // 保存到共享数组（通过索引设置，避免push的竞态）
            compressedChunks[chunkIndex] = compressedChunk

            // 保存分块文件
            if (outputDir && baseName && compressedText) {
              try {
                await saveChunkFile(outputDir, baseName, chunkIndex, compressedText)
                logger.info(`块文件已保存: ${baseName}_output_${chunkIndex + 1}.txt`)
              } catch (saveError) {
                logger.warn(`保存块文件失败: ${chunkIndex + 1}`, saveError as Error)
              }
            }

            // 更新模型健康度（成功）- 使用互斥锁保护
            await modelHealthMutex.runExclusive(async () => {
              modelHealth.successCount++
              modelHealth.totalAttempts++
              modelHealth.successRate = modelHealth.successCount / modelHealth.totalAttempts
              modelHealth.isHealthy = true
            })

            // 原子递增完成计数（使用 await）
            const completedCount = await incrementCompleted()

            const usage = extractUsageMetrics(response)

            // 更新UI状态（每次成功都更新健康度统计）
            memoryService.updateState({
              progress: {
                current: completedCount,
                total: totalChunks,
                percentage: calculatePercentage(completedCount, totalChunks),
                stage: 'compressing'
              },
              chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
                idx === chunkIndex ? {
                  ...cs,
                  status: 'completed',
                  outputLength: compressedText.length,
                  usage,
                  durationMs,
                  finishedAt: completedAt,
                  model: `#${executor.index} ${executor.model.name}`
                } : cs
              ),
              modelHealthStats: generateModelHealthStats() // 每次都更新
            })

            // 使用批量日志更新
            await addLog(createLogEntry('info', `完成第 ${chunkIndex + 1}/${totalChunks} 节 [Worker #${executor.index} Slot ${slotId}] (${completedCount}/${totalChunks})`, {
              chunkIndex,
              model: executor.model.name,
              workerIndex: executor.index,
              slotId,
              durationMs
            }))

            logger.info(`Worker #${executor.index} Slot ${slotId} 完成分块${chunkIndex + 1}`, {
              chunkIndex,
              durationMs
            })

            success = true

          } catch (error) {
            logger.warn(`Worker #${executor.index} Slot ${slotId} 分块${chunkIndex + 1}失败 (重试${retry}/${maxRetries})`, error as Error)

            // 更新模型健康度（失败）- 使用互斥锁保护
            let becameUnhealthy = false
            await modelHealthMutex.runExclusive(async () => {
              modelHealth.failureCount++
              modelHealth.totalAttempts++
              modelHealth.successRate = modelHealth.totalAttempts > 0
                ? modelHealth.successCount / modelHealth.totalAttempts
                : 0
              modelHealth.lastError = (error as Error).message

              // 根据配置的阈值判断模型健康度
              if (modelHealth.failureCount >= MODEL_HEALTH_CONFIG.MAX_CONSECUTIVE_FAILURES ||
                  (modelHealth.totalAttempts >= MODEL_HEALTH_CONFIG.MIN_ATTEMPTS_FOR_RATE &&
                   modelHealth.successRate < MODEL_HEALTH_CONFIG.MIN_SUCCESS_RATE)) {
                if (modelHealth.isHealthy) {
                  modelHealth.isHealthy = false
                  becameUnhealthy = true
                }
              }
            })

            // 如果刚变为不健康，更新统计并记录日志（在锁外执行，避免死锁）
            if (becameUnhealthy) {
              logger.warn(`Worker #${executor.index} 模型被标记为不健康`, {
                successRate: `${Math.round(modelHealth.successRate * 100)}%`,
                failures: modelHealth.failureCount
              })

              // 立即更新健康度统计
              memoryService.updateState({
                modelHealthStats: generateModelHealthStats(),
                logs: [
                  ...memoryService.getState().logs,
                  createLogEntry('warning', `Worker #${executor.index} ${executor.model.name}健康度下降`, {
                    model: executor.model.name,
                    workerIndex: executor.index,
                    successRate: `${Math.round(modelHealth.successRate * 100)}%`,
                    failures: modelHealth.failureCount
                  })
                ]
              })
            }

            // 如果是最后一次重试且失败，将任务放回共享队列供其他worker尝试
            if (retry === maxRetries && !success) {
              const totalRetries = chunkRetryCount.get(chunkIndex) || 0
              const healthyWorkersCount = Array.from(modelHealthMap.values()).filter(h => h.isHealthy).length
              logger.warn(`Worker #${executor.index} Slot ${slotId} 分块${chunkIndex + 1}所有重试均失败，放回共享队列`, {
                chunkIndex,
                workerRetries: retry + 1,
                totalRetries,
                healthyWorkers: healthyWorkersCount
              })

              await queueMutex.runExclusive(async () => {
                sharedQueue.push(chunkIndex)  // 放入共享队列
              })

              memoryService.updateState({
                chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
                  idx === chunkIndex ? {
                    ...cs,
                    status: 'pending',  // 改为pending，因为会重新尝试
                    errorMessage: `Worker #${executor.index} 失败，放入共享队列等待重试（总重试${totalRetries}/${maxChunkRetries}次）`
                  } : cs
                )
              })

              await addLog(createLogEntry('warning', `分块${chunkIndex + 1}放入共享队列，等待其他worker重试`, {
                chunkIndex,
                failedWorker: executor.index,
                failedModel: executor.model.name,
                totalRetries,
                maxRetries: maxChunkRetries,
                sharedQueueLength: sharedQueue.length,
                healthyWorkers: healthyWorkersCount
              }))
            } else if (retry < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 1000))
            }
          }
        }
      }

      logger.info(`Worker #${executor.index} Slot ${slotId} 完成`)
    })()

    workerSlots.push(slotPromise)
  }

  // 等待所有任务槽完成
  await Promise.all(workerSlots)

  logger.info(`Worker #${executor.index} 完成`, {
    model: executor.model.name,
    successCount: modelHealth.successCount,
    failureCount: modelHealth.failureCount,
    successRate: `${Math.round(modelHealth.successRate * 100)}%`,
    remainingInitial: initialTasks.length,
    remainingShared: sharedQueue.length
  })

  await addLog(createLogEntry('info', `Worker #${executor.index} ${executor.model.name} 完成`, {
    workerIndex: executor.index,
    model: executor.model.name,
    successCount: modelHealth.successCount,
    failureCount: modelHealth.failureCount,
    successRate: `${Math.round(modelHealth.successRate * 100)}%`,
    healthy: modelHealth.isHealthy
  }))

  // 最后刷新所有剩余日志
  await flushLogs()
}


interface GenerateTextResponse {
  text?: string
  [key: string]: any
}

export class NovelCompressionError extends Error {
  constructor(
    message: string,
    public detail?: unknown
  ) {
    super(message)
    this.name = 'NovelCompressionError'
  }
}

// createLogEntry 已移至 @main/utils/log-buffer

// splitTextIntoChunks 包装器 - 基于 @main/utils/novel-utils
function splitTextIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number,
  ratio: number
): Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[] {
  return baseSplitTextIntoChunks(text, chunkSize, overlap, ratio) as Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[]
}

// 本地封装：调用共享的 splitTextByChapters，返回正确类型
function localSplitTextByChapters(
  text: string,
  chapters: ChapterInfo[],
  chaptersPerChunk: number,
  ratio: number
): Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[] {
  return splitTextByChapters(text, chapters, chaptersPerChunk, ratio, clamp)
}

// =================================================================
// 章节感知 Prompt
// =================================================================

/**
 * 构建章节感知的压缩 Prompt
 */
function buildChapterAwareCompressionMessages(
  chunk: CompressionChunk,
  ratio: number,
  _customPrompt?: string,  // 预留参数，用于将来支持自定义 Prompt
  isLastChunk?: boolean
): ModelMessage[] {
  const percentage = Math.round(clamp(ratio, 0.01, 0.9) * 100)
  const chapterTitles = chunk.chapterTitles || []
  const hasChapters = chapterTitles.length > 0
  
  const systemPrompt = '你是一名专业的内容摘要服务。你的任务是忠实地将提供的长篇文本片段按章节分别压缩成更紧凑的中文摘要，同时严格保留原文的核心信息。'

  const 衔接要求 = isLastChunk
    ? '**上下文平滑衔接**：这是整个故事的**最后一个片段**。请确保压缩后文本的开头能够自然地承接上一片段的结尾，并为故事提供一个**完整、明确的结局**。'
    : '**上下文平滑衔接**：这是一个长篇故事的连续片段。请确保压缩后文本的开头能够自然地承接上一片段的结尾，结尾也能为下一片段的开头做好铺垫。'

  const chapterInstruction = hasChapters
    ? `本分块包含以下章节：${chapterTitles.join('、')}
请严格按照这些章节标题分别输出压缩内容。`
    : `请自动识别文本中的章节标题（如"第X章"、"Chapter X"等），并按章节分别输出压缩内容。
如果文本中没有明确的章节标题，则将整个分块作为单个整体输出。`

  const userPrompt = `请严格按照以下要求，将提供的"原文片段"按章节分别压缩到约 ${chunk.targetLength} 字（约原文的 ${percentage}%）。

**核心要求：**
1. **绝对忠实原文**：所有输出内容必须直接源自原文。严禁杜撰、猜测或添加任何原文中未明确提及的情节。
2. **按章节输出**：${chapterInstruction}
3. **保留关键元素**：必须保留所有主要人物的名称、称谓，以及推动情节发展的关键事件和核心对话。
4. **保持逻辑连贯**：确保压缩后的内容在时间顺序和因果关系上与原文保持一致。
5. ${衔接要求}

**输出格式：**
【章节标题】
压缩内容...

【章节标题】
压缩内容...

**注意事项：**
- 保持章节顺序，不要遗漏章节
- 每个章节的压缩内容应独立完整
- 不要添加任何前言、解释或总结性发言

**原文片段：**
${chunk.text}`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

function buildCompressionMessages(
  chunk: CompressionChunk,
  ratio: number,
  customPrompt?: string,
  isLastChunk?: boolean
): ModelMessage[] {
  const percentage = Math.round(clamp(ratio, 0.01, 0.9) * 100)
  const systemPrompt =
    '你是一名专业的内容摘要服务。你的任务是忠实地将提供的长篇文本片段阅读并转换成更紧凑的中文摘要，同时严格保留原文的核心信息。'

  let userPrompt: string
  if (customPrompt) {
    userPrompt = customPrompt
      .replace('{targetLength}', String(chunk.targetLength))
      .replace('{percentage}', String(percentage))
      .replace('{text}', chunk.text)
  } else {
    const 衔接要求 = isLastChunk
      ? '**上下文平滑衔接**：这是整个故事的**最后一个片段**。请确保阅读后文本的开头能够自然地承接上一片段的结尾，并为故事提供一个**完整、明确的结局**。请忠实于原文的结尾，不要自行添加总结性话语。'
      : '**上下文平滑衔接**：这是一个长篇故事的连续片段。请确保阅读后文本的开头能够自然地承接上一片段的结尾，结尾也能为下一片段的开头做好铺垫。不要在开头或结尾处添加任何总结性或开启性的话语，除非原文就有。'

    userPrompt = `请严格按照以下要求，将提供的"原文片段"阅读并总结到约 ${chunk.targetLength} 字（约原文的 ${percentage}%）。

**核心要求：**
1.  **绝对忠实原文**：所有输出内容必须直接源自原文。严禁杜撰、猜测或添加任何原文中未明确提及的情节、人物对话、心理活动或场景描述。
2.  **保留关键元素**：必须保留所有主要人物的名称、称谓，以及推动情节发展的关键事件和核心对话。
3.  **保持逻辑连贯**：确保阅读后的内容在时间顺序和因果关系上与原文保持一致。
4.  ${衔接要求}

**输出格式：**
-   直接输出阅读后的中文段落。
-   不要添加任何标题、前言、解释或总结性发言。

**原文片段：**
${chunk.text}`
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}


// 文件夹管理工具函数
async function createOutputDirectory(
  baseOutputPath: string,
  chunksBaseName: string,
  continueLatestTask: boolean
): Promise<string> {
  const parsedPath = path.parse(baseOutputPath)
  const dirBaseName = chunksBaseName && chunksBaseName.trim().length > 0 ? chunksBaseName : parsedPath.name
  const parentDir = parsedPath.dir

  const prefix = `${dirBaseName}_chunks_`
  const legacyDir = path.join(parentDir, `${dirBaseName}_chunks`)
  const taskKey = `${parentDir}|${dirBaseName}`

  if (currentStartOptions.autoRetry) {
    const forcedDir = compressionRunDirByTaskKey.get(taskKey)
    if (forcedDir) {
      try {
        const stat = await fs.stat(forcedDir)
        if (stat.isDirectory()) {
          logger.info('失败自动重试：复用本次任务目录', { outputDir: forcedDir })
          compressionRunDirByTaskKey.set(taskKey, forcedDir)
          return forcedDir
        }
      } catch {
        // ignore
      }
    }
  }

  const listTimestampDirs = async (): Promise<string[]> => {
    try {
      const entries = await fs.readdir(parentDir)
      const dirs = await Promise.all(
        entries
          .filter((name) => name.startsWith(prefix))
          .map(async (name) => {
            const full = path.join(parentDir, name)
            try {
              const stat = await fs.stat(full)
              return stat.isDirectory() ? full : null
            } catch {
              return null
            }
          })
      )
      return dirs.filter((d): d is string => typeof d === 'string')
    } catch {
      return []
    }
  }

  const createNewTimestampDir = async (): Promise<string> => {
    const baseRunDirName = `${dirBaseName}_chunks_${Date.now()}`
    let runDir = path.join(parentDir, baseRunDirName)
    let counter = 1

    // 确保父目录存在
    await fs.mkdir(parentDir, { recursive: true })

    while (true) {
      try {
        await fs.mkdir(runDir, { recursive: false })
        return runDir
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
        counter += 1
        runDir = path.join(parentDir, `${baseRunDirName}_${counter}`)
      }
    }
  }

  if (!continueLatestTask) {
    const runDir = await createNewTimestampDir()
    logger.info('继续最近任务已关闭，创建新的输出目录', { outputDir: runDir })
    compressionRunDirByTaskKey.set(taskKey, runDir)
    return runDir
  }

  try {
    const candidateDirs = await listTimestampDirs()
    if (candidateDirs.length > 0) {
      const dirsWithStats = await Promise.all(
        candidateDirs.map(async (dir) => ({
          dir,
          stat: await fs.stat(dir)
        }))
      )
      const latestDir = dirsWithStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].dir
      logger.info('继续最近任务已开启，复用最新任务目录', { outputDir: latestDir })
      compressionRunDirByTaskKey.set(taskKey, latestDir)
      return latestDir
    }
  } catch (error) {
    logger.debug('检查最新任务目录失败', { error })
  }

  // 兼容旧版本：{baseName}_chunks
  try {
    const stat = await fs.stat(legacyDir)
    if (stat.isDirectory()) {
      logger.info('检测到旧格式 chunks 目录，复用该目录', { outputDir: legacyDir })
      compressionRunDirByTaskKey.set(taskKey, legacyDir)
      return legacyDir
    }
  } catch {
    // ignore
  }

  const runDir = await createNewTimestampDir()
  logger.info('没有可复用目录，创建新的任务目录', { outputDir: runDir })
  compressionRunDirByTaskKey.set(taskKey, runDir)
  return runDir
}

async function detectExistingChunks(outputDir: string, totalChunks: number): Promise<Set<number>> {
  const existingChunks = new Set<number>()

  try {
    const files = await fs.readdir(outputDir)

    for (const file of files) {
      const match = file.match(/^(.+)_output_(\d+)\.txt$/)
      if (match) {
        const chunkIndex = parseInt(match[2], 10) - 1 // 转换为0基索引
        if (chunkIndex >= 0 && chunkIndex < totalChunks) {
          existingChunks.add(chunkIndex)
        }
      }
    }
  } catch (error) {
    // 文件夹不存在，返回空集合
  }

  return existingChunks
}

async function saveChunkFile(outputDir: string, baseName: string, chunkIndex: number, content: string): Promise<void> {
  const chunkFileName = `${baseName}_output_${chunkIndex + 1}.txt`
  const chunkFilePath = path.join(outputDir, chunkFileName)

  await fs.writeFile(chunkFilePath, content, 'utf-8')
}

async function mergeChunkFiles(outputDir: string, baseName: string, totalChunks: number, _finalOutputPath: string): Promise<string> {
  const mergedParts: string[] = []

  for (let i = 0; i < totalChunks; i++) {
    const chunkFileName = `${baseName}_output_${i + 1}.txt`
    const chunkFilePath = path.join(outputDir, chunkFileName)

    try {
      const chunkContent = await fs.readFile(chunkFilePath, 'utf-8')
      mergedParts.push(chunkContent.trim())
    } catch (error) {
      throw new NovelCompressionError(`缺少块文件: ${chunkFileName}`)
    }
  }

  const mergedContent = mergedParts.join('\n\n')

  // Save compressed.txt inside the task folder (outputDir) instead of parent directory
  // This prevents overwriting when running multiple tasks for the same book
  const taskFolderOutputPath = path.join(outputDir, 'compressed.txt')
  await fs.writeFile(taskFolderOutputPath, mergedContent, 'utf-8')

  logger.info('合并结果已保存到任务文件夹', { outputPath: taskFolderOutputPath })

  return mergedContent
}

async function compressNovelWithModel(
  model: Model,
  providerConfig: { providerId: ProviderId; options: any },
  content: string,
  options: NovelCompressionOptions,
  outputPath?: string
): Promise<NovelCompressionResult> {
  const memoryService = novelCompressionMemoryService
  const signal = abortController.signal
  options.signal = signal
  logger.info('Novel compression started', { modelId: model.id, providerId: providerConfig.providerId })

  if (!model) {
    throw new NovelCompressionError('未选择任何模型')
  }
  if (!content || content.trim().length === 0) {
    throw new NovelCompressionError('文本内容为空，无法阅读')
  }

  const normalizedRatio = clamp(options.ratio, 0.01, 0.9)
  const normalizedChunkSize = Math.max(500, Math.min(500000, Math.floor(options.chunkSize)))
  const normalizedOverlap = clamp(Math.floor(options.overlap), 0, normalizedChunkSize - 1)
  const normalizedTemperature = clamp(options.temperature, 0, 1.5)
  const maxConcurrentPerModel = Math.max(
    1,
    Math.min(50, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_CHUNKS_PER_MODEL))
  )

  // 获取分块模式设置
  const currentState = memoryService.getState()
  const chunkMode = currentState.chunkMode || 'bySize'
  const chaptersPerChunk = currentState.chaptersPerChunk || 3
  const chapterParseResult = currentState.chapterParseResult

  // 根据分块模式选择分块方式
  let chunks: Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[]
  let useChapterMode = false

  if (chunkMode === 'byChapter' && chapterParseResult?.success && chapterParseResult.chapters.length > 0) {
    // 按章节分块模式
    logger.info('使用按章节分块模式', {
      totalChapters: chapterParseResult.totalChapters,
      chaptersPerChunk,
      usedRule: chapterParseResult.usedRule
    })
    chunks = localSplitTextByChapters(content, chapterParseResult.chapters, chaptersPerChunk, normalizedRatio)
    useChapterMode = true
    
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【章节模式】按章节分块完成', {
          totalChapters: chapterParseResult.totalChapters,
          chaptersPerChunk,
          totalChunks: chunks.length,
          usedRule: chapterParseResult.usedRule
        })
      ]
    })
  } else {
    // 按字数分块模式（默认）
    chunks = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, normalizedRatio)
  }

  const totalChunks = chunks.length

  if (totalChunks === 0) {
    throw new NovelCompressionError('无法根据当前设置生成有效的文本分块')
  }

  let outputDir = ''
  let baseName = ''
  const existingChunks: CompressionChunk[] = []
  let existingChunkIndices: Set<number> = new Set()

  if (outputPath) {
    try {
      const parsedPath = path.parse(outputPath)
      const selected = currentState.selectedFile
      const outputBaseName = parsedPath.name
      let rawBaseName = outputBaseName

      // TextBooks 场景：最终输出固定为 compressed.txt，需要用输入文件名作为 chunks 基名
      if (outputBaseName.toLowerCase() === 'compressed') {
        rawBaseName =
          (selected?.origin_name ? path.parse(selected.origin_name).name : '') ||
          (selected?.name ? path.parse(selected.name).name : '') ||
          outputBaseName
      } else if (outputBaseName.toLowerCase().endsWith('.compressed')) {
        // 默认输出路径：{name}.compressed{ext}，chunks 目录使用 {name}_chunks
        rawBaseName = outputBaseName.slice(0, -'.compressed'.length)
      }

      baseName = sanitizeFilename(rawBaseName)
      outputDir = await createOutputDirectory(outputPath, baseName, !!currentState.continueLatestTask)
      existingChunkIndices = await detectExistingChunks(outputDir, totalChunks)

      if (existingChunkIndices.size > 0) {
        for (const chunkIndex of existingChunkIndices) {
          if (chunkIndex < chunks.length) {
            try {
              const chunkFileName = `${baseName}_output_${chunkIndex + 1}.txt`
              const chunkFilePath = path.join(outputDir, chunkFileName)
              const chunkContent = await fs.readFile(chunkFilePath, 'utf-8')
              existingChunks[chunkIndex] = { ...chunks[chunkIndex], compressed: chunkContent.trim() }
            } catch (error) {
              logger.warn(`读取块文件失败: ${chunkIndex + 1}`, error as Error)
            }
          }
        }
        const log = createLogEntry(
          'info',
          `检测到 ${existingChunkIndices.size} 个已完成块，将跳过这些块。`,
          {
            completedCount: existingChunkIndices.size,
            totalChunks,
            existingChunks: Array.from(existingChunkIndices)
              .sort((a, b) => a - b)
              .map((i) => i + 1)
          }
        )
        memoryService.updateState({ logs: [...memoryService.getState().logs, log] })
      }
    } catch (error) {
      logger.warn('检测分块文件失败，从头开始阅读', error as Error)
    }
  }

  memoryService.updateState({
    progress: {
      current: existingChunkIndices.size,
      total: totalChunks,
      percentage: calculatePercentage(existingChunkIndices.size, totalChunks),
      stage: 'initializing'
    },
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '已生成小说分块', {
        totalChunks,
        chunkSize: normalizedChunkSize,
        overlap: normalizedOverlap,
        ratio: normalizedRatio,
        resumedChunkCount: existingChunkIndices.size
      })
    ],
    chunkSummaries: Array.from({ length: totalChunks }, (_, index) => ({
      index,
      status: existingChunkIndices.has(index) ? 'completed' : 'pending',
      inputLength: chunks[index]?.text.length ?? 0,
      targetLength: chunks[index]?.targetLength ?? 0
    }))
  })

  try {
    // 注册AI Provider（清理后重新注册，确保状态一致性）
    clearAllProviders()
    const { providerId, options: providerOptions } = providerConfig
    await createAndRegisterProvider(providerId, providerOptions)

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '模型提供方已注册完成', { providerId, modelId: model.id })
      ]
    })

    const executor = createExecutor(providerId, { ...providerOptions, mode: 'chat' })
    const compressedChunks: CompressionChunk[] = [...existingChunks]
    const maxRetries = options.maxRetries ?? 3
    const baseRetryDelay = options.retryDelay ?? 3000

    // 单模型并发处理逻辑
    const pendingChunkIndexes: number[] = []
    
    // 收集待处理的分块索引
    for (let i = 0; i < totalChunks; i++) {
      if (!existingChunkIndices.has(i)) {
        pendingChunkIndexes.push(i)
      }
    }
    
    logger.info('[SingleModel] 并发配置', {
      totalPendingChunks: pendingChunkIndexes.length,
      totalChunks,
      maxConcurrentPerModel
    })
    
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `单模型并发：开始处理 ${pendingChunkIndexes.length} 个待处理分块`, {
          pendingChunks: pendingChunkIndexes.length,
          totalChunks,
          maxConcurrency: maxConcurrentPerModel
        })
      ]
    })
    
    // 使用原子计数器避免竞态条件
    let completedCount = existingChunkIndices.size
    
    // 并发处理分块 - 受 maxConcurrentPerModel 限制
    const processChunk = async (chunkIndex: number): Promise<void> => {
      const chunk = chunks[chunkIndex]
      const startedAt = Date.now()

      memoryService.updateState({
        chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
          idx === chunkIndex
            ? {
                ...cs,
                status: 'processing',
                startedAt
              }
            : cs
        ),
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `开始阅读第 ${chunkIndex + 1}/${totalChunks} 段`, {
            chunkIndex,
            chunkLength: chunk.text.length
          })
        ]
      })

      let retryCount = 0
      let success = false
      let lastError: Error | null = null
      
      while (!success && retryCount <= maxRetries) {
        if (signal.aborted || options.signal?.aborted) {
          throw new NovelCompressionError('用户取消了阅读任务')
        }

        try {
          if (retryCount > 0) {
            const retryDelay = baseRetryDelay * Math.pow(2, retryCount - 1)
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry(
                  'retry',
                  `第 ${chunkIndex + 1}/${totalChunks} 段重试 ${retryCount}/${maxRetries}，等待 ${Math.round(
                    retryDelay / 1000
                  )}s 后重试`,
                  { chunkIndex, retryCount, maxRetries, delayMs: retryDelay }
                )
              ]
            })
            await new Promise((resolve) => setTimeout(resolve, retryDelay))
          }

          // 根据分块模式选择 Prompt
          const messages = useChapterMode
            ? buildChapterAwareCompressionMessages(
                chunk,
                normalizedRatio,
                options.customPrompt,
                chunkIndex === totalChunks - 1
              )
            : buildCompressionMessages(
                chunk,
                normalizedRatio,
                options.customPrompt,
                chunkIndex === totalChunks - 1
              )

          const response = await createCancellablePromise<GenerateTextResponse>(
            executor.generateText({
              model: model.id,
              messages,
              temperature: normalizedTemperature,
              signal: options.signal
            }),
            options.signal!
          )

          if (!response) throw new Error(`第${chunkIndex + 1}段：模型返回空响应`)
          const compressedText = response.text?.trim() ?? ''
          if (!compressedText) {
            logger.warn(`Model returned empty text for chunk ${chunkIndex + 1}. Full response:`, {
              response: JSON.stringify(response, null, 2)
            })
            throw new Error(`第${chunkIndex + 1}段：模型返回空文本`)
          }

          if (signal.aborted || options.signal?.aborted) {
            throw new NovelCompressionError('用户取消了阅读任务')
          }

          const completedAt = Date.now()
          const compressedChunk: CompressionChunk = { ...chunk, compressed: compressedText }
          compressedChunks[chunkIndex] = compressedChunk

          if (outputDir && baseName && compressedText) {
            try {
              await saveChunkFile(outputDir, baseName, chunkIndex, compressedText)
              logger.info(`块文件已保存: ${baseName}_output_${chunkIndex + 1}.txt`)
            } catch (saveError) {
              logger.warn(`保存块文件失败: ${chunkIndex + 1}`, saveError as Error)
              memoryService.updateState({
                logs: [
                  ...memoryService.getState().logs,
                  createLogEntry('warning', `块文件 ${chunkIndex + 1} 保存失败，但处理继续进行`, {
                    chunkIndex,
                    error: (saveError as Error).message
                  })
                ]
              })
            }
          }

          const usage = extractUsageMetrics(response)
          const durationMs = completedAt - startedAt
          
          // 使用原子计数器递增
          completedCount++

          memoryService.updateState({
            progress: {
              current: completedCount,
              total: totalChunks,
              percentage: calculatePercentage(completedCount, totalChunks),
              stage: 'compressing'
            },
            chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
              idx === chunkIndex
                ? {
                    ...cs,
                    status: 'completed',
                    outputLength: compressedText.length,
                    usage,
                    durationMs,
                    finishedAt: completedAt
                  }
                : cs
            ),
            logs: [
              ...memoryService.getState().logs,
              createLogEntry(
                'info',
                `完成阅读第 ${chunkIndex + 1}/${totalChunks} 段 (${completedCount}/${totalChunks})${
                  retryCount > 0 ? ` (重试${retryCount}次后成功)` : ''
                }`,
                { chunkIndex, durationMs, usage, retryCount, completedCount }
              )
            ]
          })

          success = true
        } catch (error) {
          if ((error as Error).name === 'AbortError') {
            logger.info(`Chunk ${chunkIndex + 1} processing was aborted.`)
            throw new NovelCompressionError('用户取消了阅读任务')
          }

          lastError = error as Error
          retryCount++

          const isRateLimitError =
            lastError.message.includes('no candidates returned') ||
            lastError.message.includes('rate limit') ||
            lastError.message.includes('quota') ||
            lastError.message.includes('too many requests')

          if (isRateLimitError && retryCount <= maxRetries) {
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry(
                  'warning',
                  `第 ${chunkIndex + 1}/${totalChunks} 段遇到API限制，准备重试 ${retryCount}/${maxRetries}`,
                  { chunkIndex, retryCount, maxRetries, error: lastError.message }
                )
              ]
            })
          } else if (retryCount > maxRetries) {
            const errorMessage = `第 ${chunkIndex + 1}/${totalChunks} 段重试 ${maxRetries} 次后仍然失败: ${
              lastError?.message || '未知错误'
            }`
            memoryService.updateState({
              chunkSummaries: memoryService.getState().chunkSummaries.map((cs, idx) =>
                idx === chunkIndex
                  ? {
                      ...cs,
                      status: 'error',
                      errorMessage: lastError?.message || '未知错误',
                      finishedAt: Date.now()
                    }
                  : cs
              ),
              logs: [
                ...memoryService.getState().logs,
                createLogEntry('error', errorMessage + ` (可尝试从第 ${chunkIndex + 1} 段断点续传)`, {
                  chunkIndex,
                  totalChunks,
                  resumeFromChunk: chunkIndex,
                  preview: chunk.text.substring(0, 100)
                })
              ]
            })
            // best-effort：单个分块失败不终止整体任务，保留已完成分块并继续处理其他分块
            return
          } else {
            memoryService.updateState({
              logs: [
                ...memoryService.getState().logs,
                createLogEntry(
                  'warning',
                  `第 ${chunkIndex + 1}/${totalChunks} 段出现错误，准备重试 ${retryCount}/${maxRetries}: ${
                    lastError.message
                  }`,
                  { chunkIndex, retryCount, maxRetries, error: lastError.message }
                )
              ]
            })
          }
        }
      }
    }
    
    // 限制并发，避免 Promise.all 造成请求洪峰（前端 maxConcurrency 对应此处）
    await processConcurrently(
      pendingChunkIndexes.map((chunkIndex) => () => processChunk(chunkIndex)),
      maxConcurrentPerModel
    )

    // 检查是否所有分块都成功（参考NovelCharacterService的失败检查）
    const currentChunkSummaries = memoryService.getState().chunkSummaries
    const failedChunks = currentChunkSummaries.filter(cs => cs.status === 'error')
    const successfulChunks = currentChunkSummaries.filter(cs => cs.status === 'completed')

    if (failedChunks.length > 0) {
      const failedIndexes = failedChunks.map(cs => cs.index + 1)
      const failureDetails = failedChunks
        .filter(cs => cs.errorMessage)
        .map(cs => `第${cs.index + 1}节: ${cs.errorMessage}`)

      memoryService.updateState({
        progress: {
          current: successfulChunks.length,
          total: totalChunks,
          percentage: calculatePercentage(successfulChunks.length, totalChunks),
          stage: 'failed'
        },
        isProcessing: false,
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', `任务失败：有 ${failedChunks.length} 个分块未能生成，请使用断点续传重新运行`, {
            successfulChunks: successfulChunks.length,
            failedChunks: failedChunks.length,
            totalChunks,
            failedIndexes,
            failures: failureDetails
          })
        ]
      })

      // 发送失败通知
      try {
        new Notification({
          title: '小说阅读失败',
          body: `${failedChunks.length} 个分块失败，请重新运行以续传`,
          silent: false
        }).show()
      } catch (notifError) {
        logger.warn('Failed to show failure notification', notifError as Error)
      }

      throw new NovelCompressionError(
        `阅读未完成：${failedChunks.length}/${totalChunks} 个分块失败。已生成的分块已保存，请重新运行任务以断点续传。`,
        {
          successfulChunks: successfulChunks.length,
          failedChunks: failedChunks.length,
          totalChunks,
          failedIndexes,
          failureDetails,
          canResume: true,
          outputDir
        }
      )
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'finalizing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '所有分段阅读完成', { totalChunks })
      ]
    })

    let finalOutput = ''
    if (outputDir && baseName && outputPath) {
      try {
        finalOutput = await mergeChunkFiles(outputDir, baseName, totalChunks, outputPath)
        memoryService.updateState({
          logs: [
            ...memoryService.getState().logs,
            createLogEntry('info', '所有块文件已合并到最终输出文件', {
              outputPath,
              totalChunks,
              outputLength: finalOutput.length
            })
          ]
        })
      } catch (mergeError) {
        logger.warn('合并块文件失败，使用内存中的结果', mergeError as Error)
        finalOutput = compressedChunks
          .map((chunk) => chunk.compressed)
          .filter(Boolean)
          .join('\n\n')
        if (outputPath) {
          try {
            // 确保输出文件的父目录存在
            await fs.mkdir(path.dirname(outputPath), { recursive: true })
            await fs.writeFile(outputPath, finalOutput, 'utf-8')
          } catch (writeError) {
            logger.error('写入最终输出文件失败', writeError as Error)
          }
        }
      }
    } else {
      finalOutput = compressedChunks
        .map((chunk) => chunk.compressed)
        .filter(Boolean)
        .join('\n\n')
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'completed' },
      result: { merged: finalOutput, chunks: compressedChunks },
      outputPath: outputDir,  // 更新为实际的任务目录路径（带时间戳）
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '小说阅读任务完成', {
          outputLength: finalOutput.length,
          totalChunks: compressedChunks.length
        })
      ]
    })

    return { merged: finalOutput, chunks: compressedChunks }
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('Single-model compression task was cancelled.')
      const currentState = memoryService.getState()
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? totalChunks,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
      return { merged: 'Operation Cancelled', chunks: [] }
    } else {
      logger.error('Novel compression failed', error as Error)
      const currentState = memoryService.getState()
      memoryService.updateState({
        progress: {
          current: currentState.progress?.current ?? 0,
          total: totalChunks,
          percentage: calculatePercentage(currentState.progress?.current ?? 0, totalChunks),
          stage: 'failed'
        },
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', '小说阅读任务失败', { message: (error as Error).message })
        ]
      })
      throw error instanceof NovelCompressionError
        ? error
        : new NovelCompressionError('阅读过程中出现错误', error)
    }
  }
}
function calculatePercentage(current: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)))
}

function extractUsageMetrics(response: any): Record<string, number> | undefined {
  const usageSource = response?.usage ?? response?.response?.usage
  if (!usageSource || typeof usageSource !== 'object') {
    return undefined
  }

  const usageEntries: Record<string, number> = {}
  for (const [key, value] of Object.entries(usageSource)) {
    if (typeof value === 'number') {
      usageEntries[key] = value
    }
  }

  return Object.keys(usageEntries).length > 0 ? usageEntries : undefined
}

// clamp 函数已移至 @main/utils/novel-utils

// 进度信息相关类型和函数
// interface ProgressMetadata {
//   totalChunks: number
//   completedChunks: number
//   modelId?: string
//   providerId?: string
//   timestamp: string
//   status: 'in_progress' | 'completed' | 'failed'
//   chunkStatus?: Array<{
//     index: number
//     status: 'completed' | 'pending' | 'failed'
//     length?: number
//   }>
// }

// function generateProgressInfo(
//   allChunks: CompressionChunk[],
//   completedChunks: CompressionChunk[],
//   metadata: ProgressMetadata
// ): string {
//   const chunkStatus = allChunks.map(chunk => {
//     const completed = completedChunks.find(c => c.index === chunk.index)
//     return {
//       index: chunk.index,
//       status: completed ? 'completed' as const : 'pending' as const,
//       length: completed?.compressed?.length
//     }
//   })

//   const progressData = {
//     ...metadata,
//     chunkStatus
//   }

//   const progressJson = JSON.stringify(progressData, null, 2)
  
//   return `\n\n<!-- COMPRESSION_PROGRESS_START\n${progressJson}\nCOMPRESSION_PROGRESS_END -->`
// }

// function parseProgressInfo(content: string): ProgressMetadata | null {
//   const progressMatch = content.match(/<!-- COMPRESSION_PROGRESS_START\n([\s\S]*?)\nCOMPRESSION_PROGRESS_END -->/)
//   if (!progressMatch) {
//     return null
//   }

//   try {
//     return JSON.parse(progressMatch[1])
//   } catch (error) {
//     return null
//   }
// }

// function extractContentWithoutProgress(content: string): string {
//   return content.replace(/\n\n<!-- COMPRESSION_PROGRESS_START[\s\S]*?COMPRESSION_PROGRESS_END -->/, '')
// }

// function detectResumePointFromFile(filePath: string): Promise<number | null> {
//   return new Promise((resolve) => {
//     // 这里应该读取文件内容，但由于我们在主进程中，需要使用 Node.js 的 fs 模块
//     // 暂时返回 null，让前端处理文件读取
//     resolve(null)
//   })
// }

async function compressNovelWithMultipleModels(
  models: Model[],
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  content: string,
  options: NovelCompressionOptions,
  outputPath?: string
): Promise<NovelCompressionResult> {
  const memoryService = novelCompressionMemoryService
  const signal = abortController.signal
  options.signal = signal
  logger.info('Multi-model novel compression started', {
    modelCount: models.length,
    modelIds: models.map((m) => m.id)
  })

  if (!models || models.length === 0) {
    throw new NovelCompressionError('未选择任何模型')
  }
  if (!content || content.trim().length === 0) {
    throw new NovelCompressionError('文本内容为空，无法阅读')
  }

  const normalizedRatio = clamp(options.ratio, 0.01, 0.9)
  const normalizedChunkSize = Math.max(500, Math.min(500000, Math.floor(options.chunkSize)))
  const normalizedOverlap = clamp(Math.floor(options.overlap), 0, normalizedChunkSize - 1)
  const normalizedTemperature = clamp(options.temperature, 0, 1.5)
  const maxConcurrentPerModel = Math.max(1, Math.min(50, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_CHUNKS_PER_MODEL)))

  // 获取分块模式设置
  const currentState = memoryService.getState()
  const chunkMode = currentState.chunkMode || 'bySize'
  const chaptersPerChunk = currentState.chaptersPerChunk || 3
  const chapterParseResult = currentState.chapterParseResult

  // 根据分块模式选择分块方式
  let chunks: Omit<CompressionChunk, 'compressed' | 'model' | 'usage' | 'durationMs' | 'retries'>[]
  let useChapterMode = false

  if (chunkMode === 'byChapter' && chapterParseResult?.success && chapterParseResult.chapters.length > 0) {
    // 按章节分块模式
    logger.info('【多模型】使用按章节分块模式', {
      totalChapters: chapterParseResult.totalChapters,
      chaptersPerChunk,
      usedRule: chapterParseResult.usedRule
    })
    chunks = localSplitTextByChapters(content, chapterParseResult.chapters, chaptersPerChunk, normalizedRatio)
    useChapterMode = true
    
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【多模型·章节模式】按章节分块完成', {
          totalChapters: chapterParseResult.totalChapters,
          chaptersPerChunk,
          totalChunks: chunks.length,
          usedRule: chapterParseResult.usedRule
        })
      ]
    })
  } else {
    // 按字数分块模式（默认）
    chunks = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, normalizedRatio)
  }

  const totalChunks = chunks.length

  if (totalChunks === 0) {
    throw new NovelCompressionError('无法根据当前设置生成有效的文本分块')
  }

  let outputDir = ''
  let baseName = ''

  if (outputPath) {
    try {
      const parsedPath = path.parse(outputPath)
      const selected = currentState.selectedFile
      const outputBaseName = parsedPath.name
      let rawBaseName = outputBaseName

      if (outputBaseName.toLowerCase() === 'compressed') {
        rawBaseName =
          (selected?.origin_name ? path.parse(selected.origin_name).name : '') ||
          (selected?.name ? path.parse(selected.name).name : '') ||
          outputBaseName
      } else if (outputBaseName.toLowerCase().endsWith('.compressed')) {
        rawBaseName = outputBaseName.slice(0, -'.compressed'.length)
      }

      baseName = sanitizeFilename(rawBaseName)
      outputDir = await createOutputDirectory(outputPath, baseName, !!currentState.continueLatestTask)
      const existingChunkIndices = await detectExistingChunks(outputDir, totalChunks)

      if (existingChunkIndices.size > 0) {
        let maxContinuousIndex = 0
        while (existingChunkIndices.has(maxContinuousIndex)) {
          maxContinuousIndex++
        }
        options.resumeFromChunk = Math.max(options.resumeFromChunk ?? 0, maxContinuousIndex)
        const log = createLogEntry(
          'info',
          `多模型压缩检测到 ${existingChunkIndices.size} 个已完成块，从第 ${
            (options.resumeFromChunk ?? 0) + 1
          } 块开始`,
          {
            resumeFromChunk: options.resumeFromChunk,
            totalChunks,
            existingChunks: Array.from(existingChunkIndices)
              .sort((a, b) => a - b)
              .map((i) => i + 1)
          }
        )
        memoryService.updateState({ logs: [...memoryService.getState().logs, log] })
      }
    } catch (error) {
      logger.warn('多模型阅读检测分块文件失败，从头开始阅读', error as Error)
    }
  }

  memoryService.updateState({
    progress: {
      current: 0,
      total: totalChunks,
      percentage: calculatePercentage(0, totalChunks),
      stage: 'initializing'
    },
    logs: [
      ...memoryService.getState().logs,
      createLogEntry('info', '已生成小说分块', {
        totalChunks,
        chunkSize: normalizedChunkSize,
        overlap: normalizedOverlap,
        ratio: normalizedRatio,
        modelCount: models.length
      })
    ],
    chunkSummaries: Array.from({ length: totalChunks }, (_, index) => ({
      index,
      status: 'pending',
      inputLength: chunks[index]?.text.length ?? 0,
      targetLength: chunks[index]?.targetLength ?? 0
    }))
  })

  try {
    // 清理所有已注册的 provider，确保状态一致性
    clearAllProviders()
    const modelExecutors: ModelExecutor[] = []
    // 使用索引匹配，因为 models 和 providerConfigs 是对应的数组
    for (let i = 0; i < providerConfigs.length; i++) {
      const config = providerConfigs[i]
      const model = models[i]

      if (!model) {
        logger.warn(`模型索引越界`, { index: i, configCount: providerConfigs.length, modelCount: models.length })
        continue
      }

      // 注册 provider
      await createAndRegisterProvider(config.providerId, config.options)
      const executor = createExecutor(config.providerId, { ...config.options, mode: 'chat' })

      modelExecutors.push({
        model,
        provider: null as any, // Provider object is no longer needed here
        executor,
        providerId: config.providerId,
        providerOptions: config.options,
        index: i  // 存储索引用于健康度追踪
      })
    }

    if (modelExecutors.length === 0) {
      throw new NovelCompressionError('没有可用的模型执行器')
    }
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '多模型执行器已准备完成', {
          executorCount: modelExecutors.length,
          models: modelExecutors.map((e) => ({ modelId: e.model.id, providerId: e.providerId }))
        })
      ]
    })

    const compressedChunks: CompressionChunk[] = []
    const startFromChunk = options.resumeFromChunk ?? 0

    if (startFromChunk > 0) {
      memoryService.updateState({
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('info', `断点续传：从第 ${startFromChunk + 1} 段开始多模型阅读`, {
            startFromChunk,
            totalChunks,
            modelCount: modelExecutors.length
          })
        ]
      })
    }

    // --- 改进的多模型并发处理逻辑（参考NovelCharacterService）---

    const existingChunkIndices = await detectExistingChunks(outputDir, totalChunks)
    const pendingChunkIndexes: number[] = []
    for (let i = 0; i < totalChunks; i++) {
      if (!existingChunkIndices.has(i)) {
        pendingChunkIndexes.push(i)
      }
    }

    logger.info('[MultiModel] 并发配置', {
      maxConcurrentPerModel: maxConcurrentPerModel,
      modelCount: modelExecutors.length,
      totalPendingChunks: pendingChunkIndexes.length,
      totalChunks
    })

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `【模型池】初始化 ${modelExecutors.length} 个模型（并发限制：${maxConcurrentPerModel}）`, {
          models: modelExecutors.map((e) => ({ id: e.model.id, name: e.model.name })),
          maxConcurrency: maxConcurrentPerModel
        })
      ]
    })

    // 初始化模型健康度追踪（使用索引作为唯一标识）
    const modelHealthMap = new Map<string, ModelHealth>()
    models.forEach((_, index) => {
      const healthKey = `${index}`
      modelHealthMap.set(healthKey, {
        modelId: healthKey,  // 存储索引
        successCount: 0,
        failureCount: 0,
        totalAttempts: 0,
        successRate: 1.0,
        isHealthy: true
      })
      logger.info(`初始化健康度追踪 #${index}`, {
        healthKey,
        modelId: models[index].id,
        modelName: models[index].name
      })
    })

    // 辅助函数：生成模型健康度统计数据
    const generateModelHealthStats = () => {
      return Array.from(modelHealthMap.entries()).map(([healthKey, health]) => {
        const executorIndex = parseInt(healthKey, 10)
        const executor = modelExecutors[executorIndex]
        return {
          index: executorIndex,
          model: executor?.model.name || health.modelId,
          provider: executor?.providerId || 'unknown',
          baseUrl: executor?.providerOptions?.baseURL?.slice(0, 30) || 'N/A',
          successRate: `${Math.round(health.successRate * 100)}%`,
          successes: health.successCount,
          failures: health.failureCount,
          total: health.totalAttempts,
          healthy: health.isHealthy,
          lastError: health.lastError
        }
      })
    }

    // 初始化模型健康度统计状态
    const initialHealthStats = generateModelHealthStats()
    memoryService.updateState({
      modelHealthStats: initialHealthStats
    })

    // 3. 均匀分配待处理任务给每个模型
    const tasksPerModel = Math.ceil(pendingChunkIndexes.length / modelExecutors.length)
    const initialTasksPerModel: number[][] = modelExecutors.map((_, idx) => {
      const start = idx * tasksPerModel
      const end = Math.min(start + tasksPerModel, pendingChunkIndexes.length)
      return pendingChunkIndexes.slice(start, end)
    })

    // 4. 创建共享失败任务队列
    const sharedQueue: number[] = []

    // 分块全局重试计数（跨所有模型）
    const chunkRetryCount = new Map<number, number>()

    logger.info('【模型池】Per-Model Worker架构启动 - 均匀分配', {
      modelCount: modelExecutors.length,
      perModelConcurrency: maxConcurrentPerModel,
      totalConcurrency: modelExecutors.length * maxConcurrentPerModel,
      totalPendingChunks: pendingChunkIndexes.length,
      tasksPerModel,
      distribution: initialTasksPerModel.map((tasks, idx) => ({
        modelIndex: idx,
        modelName: modelExecutors[idx].model.name,
        assignedTasks: tasks.length
      }))
    })

    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', `【模型池】Per-Model Worker架构启动 - 均匀分配`, {
          modelCount: modelExecutors.length,
          perModelConcurrency: maxConcurrentPerModel,
          totalConcurrency: modelExecutors.length * maxConcurrentPerModel,
          totalPendingChunks: pendingChunkIndexes.length,
          tasksPerModel,
          distribution: initialTasksPerModel.map((tasks, idx) => ({
            modelIndex: idx,
            modelName: modelExecutors[idx].model.name,
            assignedTasks: tasks.length
          }))
        })
      ]
    })

    // 使用原子计数器
    let completedCount = existingChunkIndices.size
    const completedMutex = new AsyncMutex()  // 保护 completedCount

    // 创建原子递增函数（异步，使用互斥锁）
    const incrementCompleted = async (): Promise<number> => {
      return await completedMutex.runExclusive(async () => {
        completedCount++
        return completedCount
      })
    }

    // 队列互斥锁和任务锁
    const queueMutex = new AsyncMutex()  // 保护 sharedQueue
    const initialTasksMutexes = modelExecutors.map(() => new AsyncMutex())  // 每个模型一个锁保护其 initialTasks
    const modelHealthMutexes = modelExecutors.map(() => new AsyncMutex())  // 每个模型一个锁保护其健康度对象

    // 为每个模型创建独立的worker，并发运行
    const workerPromises = modelExecutors.map((executor, idx) =>
      runModelWorker(
        executor,
        initialTasksPerModel[idx],  // 专属初始任务
        sharedQueue,                // 共享失败任务队列
        queueMutex,                 // 共享队列互斥锁
        initialTasksMutexes[idx],   // 该模型的 initialTasks 互斥锁
        modelHealthMutexes[idx],    // 该模型的健康度互斥锁
        chunks,
        normalizedRatio,
        normalizedTemperature,
        totalChunks,
        outputDir,
        baseName,
        options,
        modelHealthMap,
        compressedChunks,
        incrementCompleted,
        chunkRetryCount,
        MAX_CHUNK_RETRIES,
        maxConcurrentPerModel,      // 每个模型的最大并发数
        signal,
        memoryService,
        generateModelHealthStats,
        useChapterMode              // 是否使用章节模式 Prompt
      )
    )

    // 并发运行所有worker
    await Promise.all(workerPromises)

    // 记录模型性能统计
    const modelStats = Array.from(modelHealthMap.values()).map((health) => {
      const index = parseInt(health.modelId, 10)
      const model = models[index]
      const executor = modelExecutors[index]
      return {
        index: index,
        model: model?.name || `未知模型 #${index}`,
        modelId: model?.id || 'unknown',
        provider: executor?.providerId || 'unknown',
        successRate: `${Math.round(health.successRate * 100)}%`,
        successes: health.successCount,
        failures: health.failureCount,
        total: health.totalAttempts,
        healthy: health.isHealthy
      }
    })

    logger.info('模型池性能统计', { models: modelStats })
    memoryService.updateState({
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '【模型池】性能统计', {
          models: modelStats
        })
      ]
    })

    // 检查是否所有分块都成功（参考NovelCharacterService的失败检查）
    const currentChunkSummaries = memoryService.getState().chunkSummaries
    const failedChunks = currentChunkSummaries.filter(cs => cs.status === 'error')
    const successfulChunks = currentChunkSummaries.filter(cs => cs.status === 'completed')

    if (failedChunks.length > 0) {
      const failedIndexes = failedChunks.map(cs => cs.index + 1)
      const failureDetails = failedChunks
        .filter(cs => cs.errorMessage)
        .map(cs => `第${cs.index + 1}节: ${cs.errorMessage}`)

      memoryService.updateState({
        progress: {
          current: successfulChunks.length,
          total: totalChunks,
          percentage: calculatePercentage(successfulChunks.length, totalChunks),
          stage: 'failed'
        },
        isProcessing: false,
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', `任务失败：有 ${failedChunks.length} 个分块未能生成，请使用断点续传重新运行`, {
            successfulChunks: successfulChunks.length,
            failedChunks: failedChunks.length,
            totalChunks,
            failedIndexes,
            failures: failureDetails,
            modelStats
          })
        ]
      })

      // 发送失败通知
      try {
        new Notification({
          title: '多模型阅读失败',
          body: `${failedChunks.length} 个分块失败，请重新运行以续传`,
          silent: false
        }).show()
      } catch (notifError) {
        logger.warn('Failed to show failure notification', notifError as Error)
      }

      throw new NovelCompressionError(
        `多模型阅读未完成：${failedChunks.length}/${totalChunks} 个分块失败。已生成的分块已保存，请重新运行任务以断点续传。`,
        {
          successfulChunks: successfulChunks.length,
          failedChunks: failedChunks.length,
          totalChunks,
          failedIndexes,
          failureDetails,
          canResume: true,
          outputDir,
          modelStats
        }
      )
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'finalizing' },
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '所有分段多模型阅读完成', {
          totalChunks,
          modelCount: modelExecutors.length
        })
      ]
    })

    const sortedChunks = compressedChunks.sort((a, b) => a.index - b.index)

    let finalOutput = ''
    if (outputDir && baseName && outputPath) {
      try {
        finalOutput = await mergeChunkFiles(outputDir, baseName, totalChunks, outputPath)
        memoryService.updateState({
          logs: [
            ...memoryService.getState().logs,
            createLogEntry('info', '多模型阅读：所有块文件已合并到最终输出文件', {
              outputPath,
              totalChunks,
              outputLength: finalOutput.length,
              modelCount: modelExecutors.length
            })
          ]
        })
      } catch (mergeError) {
        logger.warn('多模型压缩：合并块文件失败，使用内存中的结果', mergeError as Error)
        finalOutput = sortedChunks
          .map((chunk) => chunk.compressed)
          .filter(Boolean)
          .join('\n\n')
        if (outputPath) {
          try {
            // 确保输出文件的父目录存在
            await fs.mkdir(path.dirname(outputPath), { recursive: true })
            await fs.writeFile(outputPath, finalOutput, 'utf-8')
          } catch (writeError) {
            logger.error('多模型阅读：写入最终输出文件失败', writeError as Error)
          }
        }
      }
    } else {
      finalOutput = sortedChunks
        .map((chunk) => chunk.compressed)
        .filter(Boolean)
        .join('\n\n')
    }

    memoryService.updateState({
      progress: { current: totalChunks, total: totalChunks, percentage: 100, stage: 'completed' },
      result: { merged: finalOutput, chunks: sortedChunks },
      outputPath: outputDir,  // 更新为实际的任务目录路径（带时间戳）
      logs: [
        ...memoryService.getState().logs,
        createLogEntry('info', '多模型小说阅读任务完成', {
          outputLength: finalOutput.length,
          totalChunks: sortedChunks.length,
          modelCount: modelExecutors.length
        })
      ]
    })

    return { merged: finalOutput, chunks: sortedChunks }
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('Multi-model compression task was cancelled.')
      const currentState = memoryService.getState()
      memoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? totalChunks,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
      return { merged: 'Operation Cancelled', chunks: [] }
    } else {
      logger.error('Multi-model novel compression failed', error as Error)
      const currentState = memoryService.getState()
      memoryService.updateState({
        progress: {
          current: currentState.progress?.current ?? 0,
          total: totalChunks,
          percentage: calculatePercentage(currentState.progress?.current ?? 0, totalChunks),
          stage: 'failed'
        },
        logs: [
          ...memoryService.getState().logs,
          createLogEntry('error', '多模型小说阅读任务失败', { message: (error as Error).message })
        ]
      })
      throw error instanceof NovelCompressionError
        ? error
        : new NovelCompressionError('多模型阅读过程中出现错误', error)
    }
  }
}

ipcMain.on(IpcChannel.NovelCompress_Cancel, () => {
  logger.info('Cancellation request received, aborting current compression task.')
  abortController.abort()
})

// 章节识别 IPC 处理程序
ipcMain.handle(IpcChannel.NovelCompress_ParseChapters, async (_, text: string) => {
  logger.info('Chapter parsing request received', { textLength: text.length })
  try {
    const result = parseChapters(text)
    logger.info('Chapter parsing completed', {
      success: result.success,
      totalChapters: result.totalChapters,
      usedRule: result.usedRule
    })
    return result
  } catch (error) {
    logger.error('Chapter parsing failed', error as Error)
    return {
      success: false,
      totalChapters: 0,
      chapters: [],
      usedRule: '',
      error: (error as Error).message
    }
  }
})

// 最大自动重试次数
const MAX_AUTO_RESUME_ATTEMPTS = 10

// 内部压缩执行函数（支持自动重试）
async function executeCompression(
  providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
  customPrompt?: string,
  startOptions?: StartOptions
): Promise<void> {
  currentStartOptions = startOptions ?? {}

  const state = novelCompressionMemoryService.getState()
  if (!state.selectedFile && !state.inputText) {
    logger.warn('Compression start requested but no file or input text is available.')
    return
  }
  if (!providerConfigs || providerConfigs.length === 0) {
    logger.error('Compression start requested but no provider configs were provided.')
    return
  }

  try {
      const startTime = Date.now()
      novelCompressionMemoryService.updateState({ isProcessing: true, result: null, debugInfo: null })

      // 性能优化：避免重复读取文件，缓存读取结果
      let content: string
      if (state.inputText) {
        content = state.inputText
      } else {
        const fileReadResult = await readTextFileWithAutoEncoding(state.selectedFile!.path)
        content = fileReadResult.content
        logger.info(`File read with detected encoding: ${fileReadResult.encoding}`)
      }

      const options: NovelCompressionOptions = {
        ratio: state.ratioPercent / 100,
        chunkSize: state.chunkSize,
        overlap: state.overlap,
        temperature: state.temperature,
        maxConcurrency: state.maxConcurrency,
        customPrompt
      }

      let result: NovelCompressionResult
      if (state.enableMultiModel && state.selectedModels.length > 0) {
        result = await compressNovelWithMultipleModels(
          state.selectedModels,
          providerConfigs,
          content,
          options,
          state.outputPath
        )
      } else if (state.selectedModel) {
        const config = providerConfigs.find((c) => c.modelId === state.selectedModel!.id)
        if (!config) {
          throw new Error(`无法找到模型 ${state.selectedModel.name} 对应的提供商配置。`)
        }
        result = await compressNovelWithModel(
          state.selectedModel,
          config,
          content,
          options,
          state.outputPath
        )
      } else {
        throw new Error('未选择任何模型用于阅读。')
      }

      const endTime = Date.now()
      const totalDuration = endTime - startTime
      const finalState = novelCompressionMemoryService.getState()

      novelCompressionMemoryService.updateState({
        result,
        debugInfo: {
          totalDuration,
          model: state.selectedModel?.name,
          models: state.selectedModels.map((m) => m.name),
          provider: providerConfigs[0]?.providerId,
          chunkSize: options.chunkSize,
          overlap: options.overlap,
          ratio: options.ratio,
          temperature: options.temperature,
          totalChunks: finalState.chunkSummaries.length,
          completedChunks: finalState.chunkSummaries.filter((c) => c.status === 'completed').length
        }
      })
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).message.includes('用户取消')) {
      logger.info('Compression task aborted by user.')
      const currentState = novelCompressionMemoryService.getState()
      novelCompressionMemoryService.updateState({
        isProcessing: false,
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? 0,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'cancelled'
        }
      })
    } else {
      logger.error('Compression task failed', { error })
      const logEntry = createLogEntry('error', '阅读任务失败', {
        message: (error as Error).message,
        stack: (error as Error).stack
      })
      const currentState = novelCompressionMemoryService.getState()
      novelCompressionMemoryService.updateState({
        progress: {
          current: currentState.progress?.current ?? 0,
          total: currentState.progress?.total ?? 0,
          percentage: currentState.progress?.percentage ?? 0,
          stage: 'failed'
        },
        logs: [...novelCompressionMemoryService.getState().logs, logEntry]
      })

      // 检查是否需要失败自动重试
      const stateAfterFailure = novelCompressionMemoryService.getState()
      if (stateAfterFailure.enableAutoResume && stateAfterFailure.autoResumeAttempts < MAX_AUTO_RESUME_ATTEMPTS) {
        const nextAttempt = stateAfterFailure.autoResumeAttempts + 1
        logger.info(`失败自动重试已启用，将通知前端进行第${nextAttempt}次重试...`)

        novelCompressionMemoryService.updateState({
          autoResumeAttempts: nextAttempt,
          logs: [
            ...novelCompressionMemoryService.getState().logs,
            createLogEntry('info', `失败自动重试：将在3秒后进行第${nextAttempt}次重试...`, {
              attempt: nextAttempt,
              maxAttempts: MAX_AUTO_RESUME_ATTEMPTS
            })
          ]
        })

        // 通知前端触发失败自动重试
        const allWindows = BrowserWindow.getAllWindows()
        allWindows.forEach((window) => {
          window.webContents.send(IpcChannel.NovelCompress_AutoResumeTriggered, {
            attempt: nextAttempt,
            maxAttempts: MAX_AUTO_RESUME_ATTEMPTS
          })
        })
      } else if (stateAfterFailure.enableAutoResume) {
        logger.warn(`已达到最大失败自动重试次数限制（${MAX_AUTO_RESUME_ATTEMPTS}次）`)
        novelCompressionMemoryService.updateState({
          logs: [
            ...novelCompressionMemoryService.getState().logs,
            createLogEntry('warning', `已达到最大失败自动重试次数限制（${MAX_AUTO_RESUME_ATTEMPTS}次），自动重试停止`, {
              attempts: stateAfterFailure.autoResumeAttempts
            })
          ]
        })
      }
    }
  } finally {
    currentStartOptions = {}
    novelCompressionMemoryService.updateState({ isProcessing: false })
  }
}

ipcMain.handle(
  IpcChannel.NovelCompress_Start,
  async (
    _,
    providerConfigs: { modelId: string; providerId: ProviderId; options: any }[],
    customPrompt?: string,
    startOptions?: StartOptions
  ): Promise<void> => {
    // 如果之前的任务已被取消，则创建一个新的 AbortController
    if (abortController.signal.aborted) {
      abortController = new AbortController()
    }

    // 重置失败自动重试计数器
    const currentState = novelCompressionMemoryService.getState()
    if (currentState.progress?.stage !== 'failed') {
      novelCompressionMemoryService.updateState({ autoResumeAttempts: 0 })
      // 清除任务目录缓存，确保新任务创建新的带时间戳目录
      // 只有在非失败重试场景下清除，autoRetry 失败重试时需要复用目录
      compressionRunDirByTaskKey.clear()
    }

    // 性能优化：使用即时返回+异步处理模式，避免阻塞渲染进程
    // 立即设置处理状态，让前端知道任务已开始
    novelCompressionMemoryService.updateState({ isProcessing: true })

    // 异步执行压缩任务，不等待完成
    executeCompression(providerConfigs, customPrompt, startOptions).catch((error) => {
      logger.error('Compression task failed:', error)
    })

    // 立即返回，渲染进程不会阻塞
    return
  }
)

function createCancellablePromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return reject(new NovelCompressionError('用户取消了阅读任务'))
    }

    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new NovelCompressionError('用户取消了阅读任务'))
    }

    signal.addEventListener('abort', onAbort)

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}
