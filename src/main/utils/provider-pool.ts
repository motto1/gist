import { loggerService } from '@logger'

import {
  clearAllProviders,
  createAndRegisterProvider,
  getInitializedProviders,
  type ProviderId
} from '../../../packages/aiCore/src/core/providers'

const logger = loggerService.withContext('ProviderPool')

/**
 * Provider 配置信息
 */
interface ProviderConfig {
  providerId: ProviderId
  options: Record<string, unknown>
}

/**
 * 生成配置的缓存键
 * 使用 providerId + options 的哈希来标识唯一配置
 */
function generateCacheKey(config: ProviderConfig): string {
  // 提取关键配置项用于生成缓存键
  const { providerId, options } = config
  const keyParts = [
    providerId,
    options.baseURL || '',
    options.apiKey ? 'hasKey' : 'noKey' // 不存储实际密钥，只标记是否有密钥
  ]
  return keyParts.join('|')
}

/**
 * Provider 缓存池
 * 避免重复创建相同配置的 Provider，提高性能
 */
class ProviderPool {
  // 已注册的配置缓存键集合
  private registeredConfigs = new Set<string>()

  /**
   * 确保 Provider 已注册
   * 如果相同配置的 Provider 已存在，直接返回 true
   * 否则创建并注册新的 Provider
   */
  async ensureProvider(config: ProviderConfig): Promise<boolean> {
    const cacheKey = generateCacheKey(config)

    // 检查是否已注册
    if (this.registeredConfigs.has(cacheKey)) {
      logger.debug('Provider 已缓存，跳过注册', {
        providerId: config.providerId,
        cacheKey
      })
      return true
    }

    // 创建并注册新的 Provider
    try {
      const success = await createAndRegisterProvider(config.providerId, config.options)
      if (success) {
        this.registeredConfigs.add(cacheKey)
        logger.info('Provider 注册成功', {
          providerId: config.providerId,
          cacheKey,
          totalCached: this.registeredConfigs.size
        })
      }
      return success
    } catch (error) {
      logger.error('Provider 注册失败', error as Error, {
        providerId: config.providerId
      })
      return false
    }
  }

  /**
   * 批量确保多个 Provider 已注册
   * 只注册尚未缓存的 Provider
   */
  async ensureProviders(configs: ProviderConfig[]): Promise<number> {
    let successCount = 0

    for (const config of configs) {
      const success = await this.ensureProvider(config)
      if (success) {
        successCount++
      }
    }

    logger.info('批量 Provider 注册完成', {
      requested: configs.length,
      success: successCount,
      totalCached: this.registeredConfigs.size
    })

    return successCount
  }

  /**
   * 清除所有缓存和已注册的 Provider
   * 用于需要完全重置的场景
   */
  clearAll(): void {
    clearAllProviders()
    this.registeredConfigs.clear()
    logger.info('Provider 缓存池已清空')
  }

  /**
   * 移除特定配置的缓存（不影响已注册的 Provider）
   * 下次调用 ensureProvider 时会重新注册
   */
  invalidate(config: ProviderConfig): void {
    const cacheKey = generateCacheKey(config)
    this.registeredConfigs.delete(cacheKey)
    logger.debug('Provider 缓存已失效', { cacheKey })
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { cachedCount: number; registeredProviders: string[] } {
    return {
      cachedCount: this.registeredConfigs.size,
      registeredProviders: getInitializedProviders()
    }
  }

  /**
   * 检查特定配置是否已缓存
   */
  isCached(config: ProviderConfig): boolean {
    const cacheKey = generateCacheKey(config)
    return this.registeredConfigs.has(cacheKey)
  }
}

// 导出单例
export const providerPool = new ProviderPool()

// 导出类型供外部使用
export type { ProviderConfig }
