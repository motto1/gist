import { Progress } from '@heroui/react'
import { FC } from 'react'
import { useTranslation } from 'react-i18next'

interface ProgressDisplayProps {
  percentage: number
  stage: string
  current?: number
  total?: number
}

const ProgressDisplay: FC<ProgressDisplayProps> = ({ percentage, stage, current, total }) => {
  const { t } = useTranslation()

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="mb-4">
        <Progress
          aria-label="Processing progress"
          value={percentage}
          color="primary"
          size="lg"
          className="w-full"
          showValueLabel
        />
      </div>

      <div className="text-center">
        <p className="text-lg font-medium text-foreground">
          {t(`workflow.stage.${stage}`, stage)}
        </p>
        {current !== undefined && total !== undefined && (
          <p className="text-sm text-foreground/50 mt-1">
            {t('workflow.progress.chunksProgress', '已处理 {{current}} / {{total}} 个分块', {
              current,
              total
            })}
          </p>
        )}
      </div>
    </div>
  )
}

export default ProgressDisplay
