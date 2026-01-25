import { Tooltip } from '@heroui/react'
import { FileMetadata, KnowledgeSearchResult } from '@renderer/types'
import { Copy } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { useCopyText, useKnowledgeItemMetadata } from './hooks'

interface KnowledgeItemMetadataProps {
  item: KnowledgeSearchResult & {
    file: FileMetadata | null
  }
}

export const KnowledgeItemMetadata: React.FC<KnowledgeItemMetadataProps> = ({ item }) => {
  const { getSourceLink } = useKnowledgeItemMetadata()
  const { t } = useTranslation()

  const sourceLink = getSourceLink(item)

  return (
    <div className="flex justify-between items-center gap-4 mb-2 pb-2 border-b border-[var(--color-border)] select-text">
      <span className="text-sm text-default-500">
        {t('knowledge.source')}:{' '}
        <a href={sourceLink.href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          {sourceLink.text}
        </a>
      </span>
      {item.score !== 0 && (
        <div className="px-2 py-0.5 bg-primary text-white rounded text-xs flex-shrink-0">
          Score: {(item.score * 100).toFixed(1)}%
        </div>
      )}
    </div>
  )
}

interface CopyButtonContainerProps {
  textToCopy: string
  tooltipTitle?: string
}

export const CopyButtonContainer: React.FC<CopyButtonContainerProps> = ({ textToCopy, tooltipTitle = 'Copy' }) => {
  const { handleCopy } = useCopyText()

  return (
    <div className="absolute top-[58px] right-4 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
      <Tooltip content={tooltipTitle}>
        <button
          onClick={() => handleCopy(textToCopy)}
          className="flex items-center justify-center w-6 h-6 bg-[var(--color-background-mute)] text-[var(--color-text)] rounded cursor-pointer transition-all hover:bg-primary hover:text-white">
          <Copy size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
