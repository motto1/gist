/**
 * 日志缓冲区管理工具
 * 防止日志条目无限累积导致内存泄漏
 */

import type { CompressionLogEntry } from '@shared/types'

/** 默认最大日志条目数 */
export const DEFAULT_MAX_LOG_ENTRIES = 100

/**
 * 创建日志条目
 */
export function createLogEntry(
  level: CompressionLogEntry['level'],
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

/**
 * 添加日志条目并限制数量
 * 使用循环缓冲区策略：当超过最大数量时，移除最旧的条目
 *
 * @param logs 现有日志数组
 * @param newEntry 新日志条目
 * @param maxEntries 最大条目数，默认 100
 * @returns 新的日志数组
 */
export function appendLog(
  logs: CompressionLogEntry[],
  newEntry: CompressionLogEntry,
  maxEntries: number = DEFAULT_MAX_LOG_ENTRIES
): CompressionLogEntry[] {
  const newLogs = [...logs, newEntry]

  // 如果超过最大数量，移除最旧的条目
  if (newLogs.length > maxEntries) {
    return newLogs.slice(-maxEntries)
  }

  return newLogs
}

/**
 * 批量添加日志条目并限制数量
 *
 * @param logs 现有日志数组
 * @param newEntries 新日志条目数组
 * @param maxEntries 最大条目数，默认 100
 * @returns 新的日志数组
 */
export function appendLogs(
  logs: CompressionLogEntry[],
  newEntries: CompressionLogEntry[],
  maxEntries: number = DEFAULT_MAX_LOG_ENTRIES
): CompressionLogEntry[] {
  const newLogs = [...logs, ...newEntries]

  if (newLogs.length > maxEntries) {
    return newLogs.slice(-maxEntries)
  }

  return newLogs
}

/**
 * 清理已完成任务的旧日志
 * 保留最近的 N 条日志
 *
 * @param logs 日志数组
 * @param keepCount 保留数量
 * @returns 清理后的日志数组
 */
export function trimLogs(
  logs: CompressionLogEntry[],
  keepCount: number = DEFAULT_MAX_LOG_ENTRIES
): CompressionLogEntry[] {
  if (logs.length <= keepCount) {
    return logs
  }
  return logs.slice(-keepCount)
}

/**
 * 获取特定级别的日志
 */
export function filterLogsByLevel(
  logs: CompressionLogEntry[],
  level: CompressionLogEntry['level']
): CompressionLogEntry[] {
  return logs.filter(log => log.level === level)
}

/**
 * 获取最近 N 条错误日志
 */
export function getRecentErrors(
  logs: CompressionLogEntry[],
  count: number = 10
): CompressionLogEntry[] {
  return filterLogsByLevel(logs, 'error').slice(-count)
}
