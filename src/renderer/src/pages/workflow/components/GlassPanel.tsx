import type { FC, ReactNode } from 'react'

interface Props {
  children: ReactNode
  className?: string
  /**
   * Tailwind radius class.
   * - workflow step 卡片通常用 rounded-3xl
   * - tabs/segmented 控件更适合 rounded-2xl
   */
  radiusClassName?: string
  /** Tailwind padding class, e.g. "p-8" / "p-1.5" */
  paddingClassName?: string
}

/**
 * Workflow 风格的玻璃拟态面板。
 *
 * 目标：在保持现有视觉语言（content2/30 + blur + 细边框）的前提下，
 * 为不同页面提供可复用的统一容器。
 */
const GlassPanel: FC<Props> = ({
  children,
  className,
  radiusClassName = 'rounded-3xl',
  paddingClassName = 'p-8'
}) => {
  return (
    <div
      className={`border border-white/5 bg-content2/30 backdrop-blur-sm ${radiusClassName} ${paddingClassName} ${
        className || ''
      }`}
    >
      {children}
    </div>
  )
}

export default GlassPanel
