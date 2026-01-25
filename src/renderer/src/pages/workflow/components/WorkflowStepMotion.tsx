import type { Variants } from 'motion/react'
import { AnimatePresence, motion } from 'motion/react'
import type { FC, ReactNode } from 'react'

type Direction = -1 | 0 | 1

interface Props {
  motionKey: string
  direction: Direction
  children: ReactNode
  className?: string
}

const variants: Variants = {
  enter: (direction: Direction) => ({
    x: direction > 0 ? 48 : direction < 0 ? -48 : 0,
    opacity: 0
  }),
  center: {
    x: 0,
    opacity: 1,
    pointerEvents: 'auto'
  },
  exit: (direction: Direction) => ({
    x: direction > 0 ? -48 : direction < 0 ? 48 : 0,
    opacity: 0,
    pointerEvents: 'none'
  })
}

/**
 * 工作流内部“页面级”过渡：
 * - 下一步：新页面从右侧滑入
 * - 上一步：新页面从左侧滑入
 */
const WorkflowStepMotion: FC<Props> = ({ motionKey, direction, children, className }) => {
  return (
    <div
      className={
        className
          ? `relative h-full w-full overflow-hidden ${className}`
          : 'relative h-full w-full overflow-hidden'
      }
    >
      <AnimatePresence mode="sync" initial={false} custom={direction}>
        <motion.div
          key={motionKey}
          custom={direction}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.22, ease: 'easeInOut' }}
          className="absolute inset-0 h-full w-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export default WorkflowStepMotion
