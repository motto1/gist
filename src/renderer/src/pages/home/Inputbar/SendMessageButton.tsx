import { cn } from '@heroui/react'
import { SendHorizonal } from 'lucide-react'
import { FC } from 'react'

interface Props {
  disabled: boolean
  sendMessage: () => void
}

const SendMessageButton: FC<Props> = ({ disabled, sendMessage }) => {
  return (
    <SendHorizonal
      className={cn(
        'mt-[1px] mr-[2px] h-[22px] w-[22px] transition-all duration-200',
        disabled ? 'cursor-not-allowed text-[var(--color-text-3)]' : 'cursor-pointer text-[var(--color-primary)]'
      )}
      onClick={sendMessage}
    />
  )
}

export default SendMessageButton
