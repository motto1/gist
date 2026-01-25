import { Button, Tooltip } from '@heroui/react'
import { ArrowLeft, FolderOpen, Maximize2, Minimize2 } from 'lucide-react'
import { memo, type ReactNode,useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { TextReaderMarkdown } from './TextReaderMarkdown'

type ViewerKind = 'text' | 'markdown'

/**
 * 全屏模式类型
 * - 'panel': 右侧面板内全屏（仅覆盖工具栏区域）
 * - 'app': 主内容区全屏（覆盖阅读区+工具栏，保留顶部导航栏）
 */
type FullscreenMode = 'panel' | 'app'

type Props = {
  title: string
  kind: ViewerKind
  content: string
  rendered?: ReactNode
  openDirPath?: string
  onBack: () => void
  fontSize?: number
  onFontSizeChange?: (delta: number) => void
}

function RightPanelResultViewer({ title, kind, content, rendered, openDirPath, onBack, fontSize = 13, onFontSizeChange }: Props) {
  const [fullscreenMode, setFullscreenMode] = useState<FullscreenMode>('panel')

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && onFontSizeChange) {
      e.preventDefault()
      const delta = e.deltaY < 0 ? 1 : -1
      onFontSizeChange(delta)
    }
  }

  const toggleFullscreen = () => {
    setFullscreenMode((prev) => (prev === 'panel' ? 'app' : 'panel'))
  }

  const viewerContent = (
    <div
      className={
        fullscreenMode === 'app'
          ? 'absolute inset-0 z-[90] flex flex-col bg-[var(--color-background)]'
          : 'absolute inset-0 z-[80] flex flex-col bg-[var(--color-background)]'
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-[var(--color-border)] [&_button]:[-webkit-app-region:no-drag]">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="flat"
            startContent={<ArrowLeft size={14} />}
            onPress={() => {
              setFullscreenMode('panel')
              onBack()
            }}
            className="min-w-unit-16"
          >
            返回
          </Button>
          <span className="text-xs font-semibold">{title}</span>
        </div>

        <div className="flex items-center gap-2">
          <Tooltip content={fullscreenMode === 'panel' ? '扩展到阅读区' : '仅工具栏内显示'}>
            <Button size="sm" variant="flat" isIconOnly onPress={toggleFullscreen}>
              {fullscreenMode === 'panel' ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </Button>
          </Tooltip>
          <Button
            size="sm"
            variant="flat"
            startContent={<FolderOpen size={14} />}
            isDisabled={!openDirPath}
            onPress={() => {
              if (openDirPath) window.api.file.openPath(openDirPath)
            }}
            className="min-w-unit-20"
          >
            打开目录
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-3 [-webkit-app-region:no-drag] novel-tools-scrollbar" onWheel={handleWheel}>
        {rendered ? (
          rendered
        ) : kind === 'markdown' ? (
          <TextReaderMarkdown className="markdown" style={{ fontSize: `${fontSize}px` }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </TextReaderMarkdown>
        ) : (
          <pre className="whitespace-pre-wrap break-words m-0 font-[inherit] leading-[1.6]" style={{ fontSize: `${fontSize}px` }}>{content}</pre>
        )}
      </div>
    </div>
  )

  // 整体全屏模式：通过 portal 渲染到主内容区容器
  if (fullscreenMode === 'app') {
    // 查找主内容区容器（TextReaderPage 中的 mainContentRef）
    const mainContentContainer = document.querySelector('[data-main-content]')
    if (mainContentContainer) {
      return createPortal(viewerContent, mainContentContainer)
    }
  }

  // 面板全屏模式：直接渲染在当前位置
  return viewerContent
}

export default memo(RightPanelResultViewer)
