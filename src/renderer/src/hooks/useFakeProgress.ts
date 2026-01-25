import { useEffect, useRef, useState } from 'react'

interface UseFakeProgressOptions {
  isActive: boolean
  realProgress?: number
  minProgress?: number
  maxProgress?: number
  speed?: number
}

/**
 * 假进度条 Hook
 * 在处理过程中提供平滑的动画进度，当真实进度到达时自动切换
 */
export function useFakeProgress({
  isActive,
  realProgress,
  minProgress = 0,
  maxProgress = 95,
  speed = 1
}: UseFakeProgressOptions) {
  const [displayProgress, setDisplayProgress] = useState(minProgress)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastUpdateRef = useRef<number>(Date.now())

  useEffect(() => {
    // 如果有真实进度且大于显示进度，立即更新
    if (realProgress !== undefined && realProgress > displayProgress) {
      setDisplayProgress(realProgress)
      return
    }

    // 如果不活跃，清除定时器并重置
    if (!isActive) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      setDisplayProgress(minProgress)
      return
    }

    // 启动假进度动画
    if (!intervalRef.current) {
      intervalRef.current = setInterval(() => {
        setDisplayProgress((prev) => {
          // 如果已经有真实进度，不再增加假进度
          if (realProgress !== undefined && realProgress > prev) {
            return realProgress
          }

          // 计算增量：越接近最大值，增长越慢
          const now = Date.now()
          const timeDelta = (now - lastUpdateRef.current) / 1000 // 转换为秒
          lastUpdateRef.current = now

          const remaining = maxProgress - prev
          const increment = Math.max(0.1, remaining * 0.01 * speed) * timeDelta

          const next = Math.min(prev + increment, maxProgress)
          return next
        })
      }, 100) // 每100ms更新一次
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [isActive, realProgress, displayProgress, minProgress, maxProgress, speed])

  // 重置进度
  const reset = () => {
    setDisplayProgress(minProgress)
    lastUpdateRef.current = Date.now()
  }

  return {
    progress: displayProgress,
    reset
  }
}