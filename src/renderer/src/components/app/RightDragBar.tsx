import { FC } from 'react'

/**
 * 右侧永久拖拽条（用于窗口拖动）
 * - 仅占用右侧一条窄边，不影响页面布局
 * - pointer-events: none 让鼠标事件穿透，避免拦截滚轮/点击
 * - -webkit-app-region: drag 在 Electron 原生层面处理拖动
 */
const RightDragBar: FC = () => {
  return (
    <div
      className="fixed right-0 top-[var(--navbar-height)] bottom-0 w-3 z-[9998] pointer-events-none border-l border-foreground/10 bg-foreground/5"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    />
  )
}

export default RightDragBar
