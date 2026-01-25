import { FC, useMemo } from 'react'

interface ChapterFormattedTextProps {
  content: string
  className?: string
}

// 章节标题匹配正则 - 匹配常见的章节格式
const CHAPTER_PATTERNS = [
  // 【章节标题】格式 - 压缩输出的主要格式
  /^(【[^】]+】)$/gm,
  // 第X章、第X节、第X回、第X卷 等
  /^(第[零一二三四五六七八九十百千万\d]+[章节回卷部篇集].*?)$/gm,
  // Chapter X, CHAPTER X
  /^(Chapter\s+\d+.*)$/gim,
]

/**
 * 章节格式化文本组件
 * 将文本中的章节标题高亮显示
 */
const ChapterFormattedText: FC<ChapterFormattedTextProps> = ({
  content,
  className = ''
}) => {
  const formattedContent = useMemo(() => {
    if (!content) return null

    // 收集所有章节标题的位置
    const matches: { start: number; end: number; text: string }[] = []

    for (const pattern of CHAPTER_PATTERNS) {
      // 重置正则的 lastIndex
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(content)) !== null) {
        matches.push({
          start: match.index,
          end: match.index + match[1].length,
          text: match[1]
        })
      }
    }

    if (matches.length === 0) {
      return <span>{content}</span>
    }

    // 按位置排序并去除重叠
    matches.sort((a, b) => a.start - b.start)
    const nonOverlapping: typeof matches = []
    let lastEnd = -1
    for (const m of matches) {
      if (m.start < lastEnd) continue
      nonOverlapping.push(m)
      lastEnd = m.end
    }

    // 构建渲染元素
    const elements: React.ReactNode[] = []
    let cursor = 0

    for (const m of nonOverlapping) {
      // 添加章节标题前的普通文本
      if (m.start > cursor) {
        elements.push(<span key={`t-${cursor}`}>{content.slice(cursor, m.start)}</span>)
      }
      // 添加高亮的章节标题
      elements.push(
        <span
          key={`c-${m.start}`}
          className="text-primary font-semibold"
        >
          {m.text}
        </span>
      )
      cursor = m.end
    }

    // 添加剩余文本
    if (cursor < content.length) {
      elements.push(<span key="t-end">{content.slice(cursor)}</span>)
    }

    return elements
  }, [content])

  return (
    <pre className={`whitespace-pre-wrap break-words m-0 font-[inherit] leading-relaxed text-sm text-foreground/80 ${className}`}>
      {formattedContent}
    </pre>
  )
}

export default ChapterFormattedText
