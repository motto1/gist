import { isLinux,isWin } from '@renderer/config/constant'
import { FC } from 'react'

/**
 * 窗口拖动条组件
 * 用于在没有 Navbar 的页面提供窗口拖动功能
 *
 * 原理：
 * - pointer-events: none 让 CSS 层面的点击事件穿透到下层元素
 * - -webkit-app-region: drag 在 Electron 原生层面处理拖动，不受 pointer-events 影响
 */
const DragBar: FC = () => {
  return (
    <div
      className="fixed top-0 left-0 right-0 h-[var(--navbar-height)] z-[9999] pointer-events-none"
      style={{
        WebkitAppRegion: 'drag',
        // 为窗口控制按钮留出空间
        paddingRight: isWin ? 140 : isLinux ? 120 : 0
      } as React.CSSProperties}
    />
  )
}

export default DragBar
