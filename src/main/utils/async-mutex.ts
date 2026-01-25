/**
 * 简单的异步互斥锁实现，用于保护共享资源访问
 *
 * @example
 * const mutex = new AsyncMutex()
 * await mutex.runExclusive(async () => {
 *   // 临界区代码
 * })
 */
export class AsyncMutex {
  private _queue: Array<() => void> = []
  private _locked = false

  async lock(): Promise<void> {
    if (!this._locked) {
      this._locked = true
      return
    }

    return new Promise<void>((resolve) => {
      this._queue.push(resolve)
    })
  }

  unlock(): void {
    if (this._queue.length > 0) {
      const resolve = this._queue.shift()!
      resolve()
    } else {
      this._locked = false
    }
  }

  /**
   * 在锁保护下执行异步函数
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.lock()
    try {
      return await fn()
    } finally {
      this.unlock()
    }
  }
}

/**
 * 并发控制执行：限制同时运行的任务数量，保持结果顺序与 tasks 一致
 * 用于避免 Promise.all 造成请求洪峰
 *
 * @param tasks - 任务工厂函数数组
 * @param maxConcurrency - 最大并发数
 * @returns 按原顺序返回的结果数组
 */
export async function processConcurrently<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency: number
): Promise<T[]> {
  const safeMaxConcurrency = Math.max(1, Math.floor(maxConcurrency))
  const results: T[] = []
  const executing: Set<Promise<void>> = new Set()

  for (const [index, task] of tasks.entries()) {
    const wrappedPromise = (async () => {
      results[index] = await task()
    })()

    const cleanupPromise = wrappedPromise.finally(() => {
      executing.delete(cleanupPromise)
    })

    executing.add(cleanupPromise)

    if (executing.size >= safeMaxConcurrency) {
      await Promise.race(executing)
    }
  }

  await Promise.all(Array.from(executing))
  return results
}
