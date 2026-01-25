import { Divider, Popover, PopoverContent, PopoverTrigger } from '@heroui/react'
import MaxContextCount from '@renderer/components/MaxContextCount'
import { useSettings } from '@renderer/hooks/useSettings'
import { ArrowUp, MenuIcon } from 'lucide-react'
import { FC } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  estimateTokenCount: number
  inputTokenCount: number
  contextCount: { current: number; max: number }
} & React.HTMLAttributes<HTMLDivElement>

const TokenCount: FC<Props> = ({ estimateTokenCount, inputTokenCount, contextCount }) => {
  const { t } = useTranslation()
  const { showInputEstimatedTokens } = useSettings()

  if (!showInputEstimatedTokens) {
    return null
  }

  return (
    <div className="z-10 flex cursor-pointer select-none items-center rounded-[20px] px-[10px] py-[3px] text-[11px] leading-4 text-[var(--color-text-2)] max-[800px]:hidden">
      <Popover showArrow={false} placement="top">
        <PopoverTrigger>
          <div className="flex items-center gap-0">
            <div className="flex items-center">
              <MenuIcon size={12} className="mr-[3px]" />
              {contextCount.current}
              <span className="mx-[2px]">/</span>
              <MaxContextCount maxContext={contextCount.max} />
            </div>
            <Divider orientation="vertical" className="mx-[3px] mt-[3px] ml-[5px] mr-[3px] h-3" />
            <div className="flex items-center">
              <ArrowUp size={12} className="mr-[3px]" />
              {inputTokenCount}
              <span className="mx-[2px]">/</span>
              {estimateTokenCount}
            </div>
          </div>
        </PopoverTrigger>
        <PopoverContent>
          <div className="flex w-[185px] flex-col">
            <div className="flex w-full flex-row justify-between">
              <div className="text-xs text-[var(--color-text-1)]">{t('chat.input.context_count.tip')}</div>
              <div className="text-xs text-[var(--color-text-1)]">
                <div className="flex items-center">
                  {contextCount.current}
                  <span className="mx-[2px]">/</span>
                  <MaxContextCount maxContext={contextCount.max} />
                </div>
              </div>
            </div>
            <Divider className="my-[5px]" />
            <div className="flex w-full flex-row justify-between">
              <div className="text-xs text-[var(--color-text-1)]">{t('chat.input.estimated_tokens.tip')}</div>
              <div className="text-xs text-[var(--color-text-1)]">{estimateTokenCount}</div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export default TokenCount
