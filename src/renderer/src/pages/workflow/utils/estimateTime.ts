export const ESTIMATE_BASE_SECONDS = 90
export const ESTIMATE_BASE_CHARS = 750000 // 75 万字

/**
 * 按 90 秒 / 75 万字线性估算总耗时（秒）。
 * chars 不可用时回退到基准值，避免 UI 停在 0。
 */
export const estimateSecondsFromChars = (chars: number) => {
  if (!Number.isFinite(chars) || chars <= 0) return ESTIMATE_BASE_SECONDS
  return Math.max(1, Math.round((chars * ESTIMATE_BASE_SECONDS) / ESTIMATE_BASE_CHARS))
}

/**
 * 根据已用时/预计总耗时计算进度百分比（0..99）。
 * 99 封顶避免“任务未完成但进度 100%”的错觉；完成时由业务逻辑设置为 100。
 */
export const estimateProgressPercent = (elapsedSeconds: number, totalSeconds: number) => {
  const total = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : ESTIMATE_BASE_SECONDS
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0
  return Math.max(0, Math.min(99, Math.round((elapsed / total) * 100)))
}

