import { Button } from '@heroui/react'
import { ArrowLeft } from 'lucide-react'
import type { CSSProperties, FC, ReactNode } from 'react'

interface Props {
  title: ReactNode
  /**
   * 默认提供「返回」按钮；如果不传则不渲染。
   * （保持与现有 workflow 子页一致：navigate(-1)）
   */
  onBack?: () => void
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}

const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

/**
 * Workflow 体系的标准顶部栏：
 * - header 本身可拖拽窗口（Electron）
 * - 交互控件区域设置 no-drag
 */
const WorkflowAppHeader: FC<Props> = ({ title, onBack, meta, actions, className }) => {
  return (
    <div
      className={`relative z-10 flex items-center justify-between gap-4 border-foreground/10 border-b px-6 py-4 ${
        className || ''
      }`}
      style={dragStyle}
    >
      <div className="flex items-center gap-3">
        {onBack ? (
          <Button
            isIconOnly
            radius="full"
            variant="light"
            onPress={onBack}
            aria-label="返回"
            style={noDragStyle}
          >
            <ArrowLeft size={18} />
          </Button>
        ) : null}

        <h1 className="font-semibold text-xl">{title}</h1>

        {meta ? <div style={noDragStyle}>{meta}</div> : null}
      </div>

      {actions ? (
        <div className="flex items-center gap-2" style={noDragStyle}>
          {actions}
        </div>
      ) : null}
    </div>
  )
}

export default WorkflowAppHeader
