import { Dispatch, SetStateAction, useEffect, useState } from 'react'

type ValidateFn<T> = (value: unknown) => value is T

/**
 * 在 renderer 侧用 localStorage 持久化 UI 选择（下拉框等）。
 * - 默认使用 JSON 序列化
 * - 读取失败/校验失败时回退到 initialValue
 */
export function useLocalStorageState<T>(
  key: string,
  initialValue: T,
  validate?: ValidateFn<T>
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initialValue
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return initialValue
      const parsed = JSON.parse(raw) as unknown
      if (validate && !validate(parsed)) return initialValue
      return parsed as T
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore storage failures
    }
  }, [key, value])

  return [value, setValue]
}

