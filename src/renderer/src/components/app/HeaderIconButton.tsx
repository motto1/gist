import { type CSSProperties, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: ReactNode
}

/**
 * 顶部标题栏用的“圆形图标按钮”，视觉风格与书库页标题区的圆形图标保持一致。
 * - 默认带 no-drag，适配 Electron 顶栏拖拽区域
 */
export default function HeaderIconButton({ icon, className, ...props }: Props) {
  return (
    <button
      type="button"
      {...props}
      className={`flex h-10 w-10 items-center justify-center rounded-full bg-content2 text-foreground/60 transition-colors hover:bg-content2/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] ${
        className ?? ''
      }`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      {icon}
    </button>
  )
}
