import { CircularProgress, Tooltip } from '@heroui/react'
import { loggerService } from '@logger'
import { KnowledgeBase, ProcessingStatus } from '@renderer/types'
import { CheckCircle, XCircle } from 'lucide-react'
import React, { FC, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('StatusIcon')
interface StatusIconProps {
  sourceId: string
  base: KnowledgeBase
  getProcessingStatus: (sourceId: string) => ProcessingStatus | undefined
  type: string
  progress?: number
  isPreprocessed?: boolean
}

const StatusIcon: FC<StatusIconProps> = ({
  sourceId,
  base,
  getProcessingStatus,
  type,
  progress = 0,
  isPreprocessed
}) => {
  const { t } = useTranslation()
  const status = getProcessingStatus(sourceId)
  const item = base.items.find((item) => item.id === sourceId)
  const errorText = item?.processingError
  logger.debug(`[StatusIcon] Rendering for item: ${item?.id} Status: ${status} Progress: ${progress}`)

  return useMemo(() => {
    if (!status) {
      if (item?.uniqueId) {
        if (isPreprocessed && item.type === 'file') {
          return (
            <Tooltip content={t('knowledge.status_preprocess_completed')} placement="left">
              <CheckCircle className="w-4 h-4 text-success cursor-pointer" />
            </Tooltip>
          )
        }
        return (
          <Tooltip content={t('knowledge.status_embedding_completed')} placement="left">
            <CheckCircle className="w-4 h-4 text-success cursor-pointer" />
          </Tooltip>
        )
      }
      return (
        <Tooltip content={t('knowledge.status_new')} placement="left">
          <div className="w-2.5 h-2.5 rounded-full bg-default-400 cursor-pointer" />
        </Tooltip>
      )
    }

    switch (status) {
      case 'pending':
        return (
          <Tooltip content={t('knowledge.status_pending')} placement="left">
            <div className="w-2.5 h-2.5 rounded-full bg-warning cursor-pointer" />
          </Tooltip>
        )

      case 'processing': {
        return type === 'directory' || type === 'file' ? (
          <CircularProgress
            size="sm"
            value={Number(progress?.toFixed(0))}
            color="primary"
            showValueLabel={false}
            classNames={{
              svg: 'w-3.5 h-3.5'
            }}
          />
        ) : (
          <Tooltip content={t('knowledge.status_processing')} placement="left">
            <div className="w-2.5 h-2.5 rounded-full bg-primary cursor-pointer animate-pulse" />
          </Tooltip>
        )
      }
      case 'completed':
        return (
          <Tooltip content={t('knowledge.status_completed')} placement="left">
            <CheckCircle className="w-4 h-4 text-success cursor-pointer" />
          </Tooltip>
        )
      case 'failed':
        return (
          <Tooltip content={errorText || t('knowledge.status_failed')} placement="left">
            <XCircle className="w-4 h-4 text-danger cursor-pointer" />
          </Tooltip>
        )
      default:
        return null
    }
  }, [status, item?.uniqueId, item?.type, t, isPreprocessed, errorText, type, progress])
}

export default React.memo(StatusIcon, (prevProps, nextProps) => {
  return (
    prevProps.sourceId === nextProps.sourceId &&
    prevProps.type === nextProps.type &&
    prevProps.base.id === nextProps.base.id &&
    prevProps.progress === nextProps.progress &&
    prevProps.getProcessingStatus(prevProps.sourceId) === nextProps.getProcessingStatus(nextProps.sourceId) &&
    prevProps.base.items.find((item) => item.id === prevProps.sourceId)?.processingError ===
      nextProps.base.items.find((item) => item.id === nextProps.sourceId)?.processingError
  )
})
