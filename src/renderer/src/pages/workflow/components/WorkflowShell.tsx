import type { FC, ReactNode } from 'react'

interface Props {
  header?: ReactNode
  children: ReactNode
  /** Tailwind max-width class, e.g. "max-w-4xl" / "max-w-6xl" */
  maxWidthClassName?: string
  /** Tailwind padding class for scroll container */
  paddingClassName?: string
  className?: string
  contentClassName?: string
}

/**
 * Workflow / 模块页通用骨架：
 * - 全屏 flex column
 * - header（可选）
 * - body 可滚动
 */
const WorkflowShell: FC<Props> = ({
  header,
  children,
  maxWidthClassName = 'max-w-4xl',
  paddingClassName = 'px-6 py-8',
  className,
  contentClassName
}) => {
  return (
    <div className={`relative flex h-full w-full flex-col bg-background ${className || ''}`}>
      {header}
      <div className={`flex-1 overflow-y-auto ${paddingClassName}`}>
        <div className={`mx-auto w-full ${maxWidthClassName} ${contentClassName || ''}`}>{children}</div>
      </div>
    </div>
  )
}

export default WorkflowShell
