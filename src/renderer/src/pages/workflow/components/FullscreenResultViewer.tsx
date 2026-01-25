import { Button, Textarea } from '@heroui/react'
import { TextReaderMarkdown } from '@renderer/pages/textReader/components/TextReaderMarkdown'
import { Edit2, Maximize2, Minimize2, Save, X } from 'lucide-react'
import { FC, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import ChapterFormattedText from './ChapterFormattedText'

interface FullscreenResultViewerProps {
  content: string
  kind: 'text' | 'markdown'
  title?: string
  onSave?: (newContent: string) => void
}

/**
 * 全屏结果查看器
 * 作为容器的子元素使用，在容器右下角显示一个渐显的放大按钮
 * 父容器需要添加 "relative group" 类名
 */
const FullscreenResultViewer: FC<FullscreenResultViewerProps> = ({
  content,
  kind,
  title,
  onSave
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(content)

  // Reset edit content when content prop changes or when entering fullscreen
  useEffect(() => {
    setEditContent(content)
  }, [content, isFullscreen])

  const handleSave = () => {
    if (onSave) {
      onSave(editContent)
      setIsEditing(false)
    }
  }

  const handleCancelEdit = () => {
    setEditContent(content)
    setIsEditing(false)
  }

  const renderContent = () => {
    if (isEditing) {
      return (
        <Textarea
          value={editContent}
          onValueChange={setEditContent}
          minRows={20}
          maxRows={100}
          classNames={{
            base: "w-full h-full min-h-[500px]",
            inputWrapper: "h-full !bg-transparent !shadow-none !rounded-none !outline-none !ring-0 !border-none p-4 hover:!bg-transparent focus-within:!bg-transparent",
            input: "text-base leading-[1.75] font-normal !pr-2 h-full !outline-none !ring-0 focus:!ring-0 caret-primary"
          }}
          autoFocus
        />
      )
    }

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
            <div className="flex items-center gap-2">
              {onSave && !isEditing && (
                <Button
                  isIconOnly
                  variant="light"
                  onPress={() => setIsEditing(true)}
                  title="编辑"
                >
                  <Edit2 size={20} />
                </Button>
              )}
              <Button
                isIconOnly
                variant="light"
                onPress={() => {
                  setIsFullscreen(false)
                  setIsEditing(false)
                }}
              >
                <X size={20} />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6 bg-content1/20">
            <div className={`mx-auto ${isEditing ? 'max-w-4xl h-full' : 'max-w-4xl'}`}>
              {renderContent()}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center px-6 py-3 border-t border-foreground/10 flex-shrink-0 bg-background">
            <div className="text-sm text-foreground/40">
              {isEditing ? `${editContent.length} 字` : `${content.length} 字`}
            </div>

            <div className="flex gap-2">
              {isEditing ? (
                <>
                  <Button
                    variant="flat"
                    size="sm"
                    onPress={handleCancelEdit}
                  >
                    取消
                  </Button>
                  <Button
                    color="primary"
                    size="sm"
                    startContent={<Save size={16} />}
                    onPress={handleSave}
                  >
                    保存修改
                  </Button>
                </>
              ) : (
                <Button
                  variant="bordered"
                  size="sm"
                  startContent={<Minimize2 size={16} />}
                  onPress={() => setIsFullscreen(false)}
                >
                  退出全屏
                </Button>
              )}
            </div>
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
