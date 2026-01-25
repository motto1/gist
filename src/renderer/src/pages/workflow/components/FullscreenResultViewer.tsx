import { Button } from '@heroui/react'
import { TextReaderMarkdown } from '@renderer/pages/textReader/components/TextReaderMarkdown'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { FC, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import ChapterFormattedText from './ChapterFormattedText'

interface FullscreenResultViewerProps {
  content: string
  kind: 'text' | 'markdown'
  title?: string
}

/**
 * 全屏结果查看器
 * 作为容器的子元素使用，在容器右下角显示一个渐显的放大按钮
 * 父容器需要添加 "relative group" 类名
 */
const FullscreenResultViewer: FC<FullscreenResultViewerProps> = ({
  content,
  kind,
  title
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false)

  const renderContent = () => {
    if (kind === 'markdown') {
      return (
        <TextReaderMarkdown className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </TextReaderMarkdown>
      )
    }
    // 使用章节格式化组件渲染纯文本
    return <ChapterFormattedText content={content} />
  }

  const fullscreenOverlay = isFullscreen
    ? createPortal(
        <div className="fixed inset-0 z-[9999] flex flex-col bg-background">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-foreground/10 flex-shrink-0">
            <h2 className="text-lg font-semibold text-foreground">
              {title || '查看内容'}
            </h2>
            <Button
              isIconOnly
              variant="light"
              onPress={() => setIsFullscreen(false)}
            >
              <X size={20} />
            </Button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            <div className="max-w-4xl mx-auto">
              {renderContent()}
            </div>
          </div>

          {/* Footer with minimize button */}
          <div className="flex justify-end px-6 py-3 border-t border-foreground/10 flex-shrink-0">
            <Button
              variant="bordered"
              size="sm"
              startContent={<Minimize2 size={16} />}
              onPress={() => setIsFullscreen(false)}
            >
              退出全屏
            </Button>
          </div>
        </div>,
        document.body
      )
    : null

  return (
    <>
      {/* Fullscreen button - fixed at container's bottom right, appears on hover */}
      <Button
        isIconOnly
        size="sm"
        variant="flat"
        className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-foreground/10 hover:bg-foreground/20 z-10"
        onPress={() => setIsFullscreen(true)}
      >
        <Maximize2 size={16} />
      </Button>

      {/* Fullscreen overlay */}
      {fullscreenOverlay}
    </>
  )
}

export default FullscreenResultViewer
