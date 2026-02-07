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
      className="rounded-2xl border border-white/5 bg-content2/30 backdrop-blur-sm p-3 text-foreground/80"
    >
      {text || <span className="text-foreground/40">暂无日志</span>}
    </pre>
  )
}
