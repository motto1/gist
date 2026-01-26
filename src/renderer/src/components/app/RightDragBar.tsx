import { FC } from 'react'

/**
 * 右侧永久拖拽条（用于窗口拖动）
 * - 仅占用右侧一条窄边，不影响页面布局
 * - 注意：在 Windows 下 `pointer-events: none` 会导致拖拽区域无法接收鼠标按下，进而无法拖动窗口。
 * - 这里使用很窄的宽度（默认 12px），尽量不影响页面交互。
 */
const RightDragBar: FC = () => {
  return (
    <div
      className="fixed right-0 top-[var(--navbar-height)] bottom-0 w-3 z-[9998] pointer-events-auto cursor-grab active:cursor-grabbing border-l border-foreground/10 bg-transparent hover:bg-foreground/5 transition-colors"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    />
  )
}

export default RightDragBar
