import { useEffect, useRef, useState } from 'react'

export function useAdaptiveScale(designWidth: number, minScale: number = 0.72) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const updateScale = () => {
      const width = host.clientWidth
      if (!width) return
      const nextScale = width >= designWidth ? 1 : Math.max(minScale, width / designWidth)
      setScale(nextScale)
    }

    updateScale()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => updateScale())
      observer.observe(host)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateScale)
    return () => window.removeEventListener('resize', updateScale)
  }, [designWidth, minScale])

  return {
    hostRef,
    scale,
    scaledStyle: {
      transform: `scale(${scale})`,
      transformOrigin: 'top left',
      width: `${100 / scale}%`
    } as const
  }
}
