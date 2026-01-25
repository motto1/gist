/**
 * 阅读器右侧工具区/全屏查看器使用的 Markdown 容器样式。
 * 目标：比全局 `.markdown` 更适合"窄栏阅读"，字号、加粗、列表与段落间距更接近工业阅读器体验。
 *
 * 使用 Tailwind CSS 实现，保持原有的样式效果
 */

import { CSSProperties, FC, ReactNode } from 'react'

export interface TextReaderMarkdownProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export const TextReaderMarkdown: FC<TextReaderMarkdownProps> = ({ children, className = '', style }) => {
  return (
    <div
      className={`
        text-sm leading-[1.75]

        [&_h1]:mt-4 [&_h1]:mb-2.5 [&_h1]:leading-[1.25] [&_h1]:font-semibold
        [&_h1]:text-lg [&_h1]:border-b [&_h1]:border-[var(--color-border)] [&_h1]:pb-1.5

        [&_h2]:mt-4 [&_h2]:mb-2.5 [&_h2]:leading-[1.25] [&_h2]:font-semibold
        [&_h2]:text-base [&_h2]:border-b [&_h2]:border-[var(--color-border)] [&_h2]:pb-1

        [&_h3]:mt-4 [&_h3]:mb-2.5 [&_h3]:leading-[1.25] [&_h3]:font-semibold [&_h3]:text-[15px]
        [&_h4]:mt-4 [&_h4]:mb-2.5 [&_h4]:leading-[1.25] [&_h4]:font-semibold [&_h4]:text-sm
        [&_h5]:mt-4 [&_h5]:mb-2.5 [&_h5]:leading-[1.25] [&_h5]:font-semibold [&_h5]:text-[13px]
        [&_h6]:mt-4 [&_h6]:mb-2.5 [&_h6]:leading-[1.25] [&_h6]:font-semibold [&_h6]:text-xs [&_h6]:text-[var(--color-text-2)]

        [&_p]:my-3.5 [&_p]:leading-[1.75]
        [&_p:has(+ul)]:mb-1 [&_p:has(+ol)]:mb-1

        [&_strong]:font-[650] [&_b]:font-[650]

        [&_ul]:list-disc [&_ol]:list-decimal
        [&_ul]:pl-7 [&_ul]:my-3 [&_ol]:pl-7 [&_ol]:my-3

        [&_li]:my-1.5
        [&_li::marker]:text-[var(--color-text-3)]
        [&_li>ul]:my-1.5 [&_li>ol]:my-1.5

        [&_blockquote]:my-3.5 [&_blockquote]:px-3 [&_blockquote]:py-2.5
        [&_blockquote]:bg-[var(--color-background-soft)]
        [&_blockquote]:border-l-[3px] [&_blockquote]:border-[var(--color-primary)]
        [&_blockquote]:rounded-r-lg [&_blockquote]:text-[var(--color-text-2)]
        [&_blockquote]:not-italic

        [&_pre]:my-3.5 [&_pre]:px-3 [&_pre]:py-2.5
        [&_pre]:rounded-lg [&_pre]:bg-[var(--color-background-mute)]
        [&_pre]:overflow-auto

        [&_p_code]:bg-[var(--color-background-mute)] [&_p_code]:px-1.5 [&_p_code]:py-0.5 [&_p_code]:rounded
        [&_li_code]:bg-[var(--color-background-mute)] [&_li_code]:px-1.5 [&_li_code]:py-0.5 [&_li_code]:rounded

        [&_table]:my-4

        [&_a]:text-[var(--color-link)] [&_a]:no-underline
        [&_a:hover]:underline

        [&_.contains-task-list]:pl-5
        [&_.task-list-item]:list-none
        [&_.task-list-item>input[type='checkbox']]:mr-2 [&_.task-list-item>input[type='checkbox']]:translate-y-px

        ${className}
      `.trim()}
      style={style}
    >
      {children}
    </div>
  )
}
