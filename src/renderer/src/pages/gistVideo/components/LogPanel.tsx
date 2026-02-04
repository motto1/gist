import type { CSSProperties } from 'react'

export default function LogPanel(props: { lines: string[]; style?: CSSProperties }) {
  const text = (props.lines || []).join('\n')
  return (
    <pre
      style={{
        margin: 0,
        fontSize: 12,
        lineHeight: 1.45,
        maxHeight: 340,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        ...props.style
      }}
      className="rounded-xl border border-divider bg-content2/40 p-3 text-foreground/80"
    >
      {text || <span className="text-foreground/40">暂无日志</span>}
    </pre>
  )
}
