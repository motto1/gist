import { Button, ButtonProps, cn } from '@heroui/react'
import React, { memo } from 'react'

interface ActionIconButtonProps extends Omit<ButtonProps, 'children'> {
  children: React.ReactNode
  active?: boolean
}

/**
 * A simple action button rendered as an icon
 */
const ActionIconButton: React.FC<ActionIconButtonProps> = ({ children, active = false, className, ...props }) => {
  return (
    <Button
      variant="light"
      isIconOnly
      radius="full"
      className={cn(
        'h-[30px] w-[30px] min-w-[30px] cursor-pointer border-none p-0 text-base transition-all duration-300 ease-in-out [&_.icon]:text-icon [&_.lucide]:text-icon',
        active && '[&_.icon]:text-primary! [&_.lucide]:text-primary!',
        className
      )}
      {...props}>
      {children}
    </Button>
  )
}

export default memo(ActionIconButton)
