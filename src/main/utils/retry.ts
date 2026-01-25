/**
 * 通用重试工具
 * 从 NovelCompressionService, NovelCharacterService 中提取
 */

import { loggerService } from '@logger'

const logger = loggerService.withContext('RetryUtil')

export interface RetryOptions {
  /** 最大重试次数（不包括首次尝试） */
  maxRetries: number
  /** 基础重试延迟（毫秒） */
  baseDelay: number
  /** 可选的中止信号 */
  signal?: AbortSignal
  /** 是否使用指数退避，默认 true */
  exponentialBackoff?: boolean
  /** 最大延迟时间（毫秒），默认 30000 */
  maxDelay?: number
  /** 重试时的回调 */
  onRetry?: (attempt: number, error: Error, delay: number) => void
  /** 判断是否应该重试的函数，默认总是重试 */
  shouldRetry?: (error: Error) => boolean
}

export class RetryError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: Error
  ) {
    super(message)
    this.name = 'RetryError'
  }
}

export class AbortError extends Error {
  constructor(message = '操作已取消') {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * 使用重试逻辑执行异步函数
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetchData(),
 *   { maxRetries: 3, baseDelay: 1000 }
 * )
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxRetries,
    baseDelay,
    signal,
    exponentialBackoff = true,
    maxDelay = 30000,
    onRetry,
    shouldRetry = () => true
  } = options

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 检查是否已取消
    if (signal?.aborted) {
      throw new AbortError('用户取消了任务')
    }

    try {
      // 重试前等待（首次尝试不等待）
      if (attempt > 0) {
        const delay = exponentialBackoff
          ? Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)
          : baseDelay

        logger.debug(`第 ${attempt} 次重试，等待 ${delay}ms...`)
        onRetry?.(attempt, lastError!, delay)

        await sleep(delay, signal)
      }

      return await fn()
    } catch (error) {
      // 检查是否是取消错误
      if ((error as Error).name === 'AbortError' || signal?.aborted) {
        throw new AbortError('用户取消了任务')
      }

      lastError = error as Error

      // 检查是否应该重试
      if (!shouldRetry(lastError)) {
        throw lastError
      }

      // 如果已达到最大重试次数，抛出错误
      if (attempt >= maxRetries) {
        throw new RetryError(
          `重试 ${maxRetries} 次后仍然失败: ${lastError.message}`,
          attempt + 1,
          lastError
        )
      }

      logger.warn(`尝试 ${attempt + 1}/${maxRetries + 1} 失败: ${lastError.message}`)
    }
  }

  // 不应该到达这里，但为了类型安全
  throw lastError || new Error('未知错误')
}

/**
 * 可取消的 sleep
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError())
      return
    }

    const timer = setTimeout(resolve, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 创建可取消的 Promise 包装器
 * 用于包装不支持 AbortSignal 的 Promise
 */
export function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError())
      return
    }

    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new AbortError())
    }

    signal.addEventListener('abort', onAbort)

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
