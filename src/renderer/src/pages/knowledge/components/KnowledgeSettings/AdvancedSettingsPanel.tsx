import { Input } from '@heroui/react'
import { InfoTooltip } from '@renderer/components/TooltipIcons'
import { KnowledgeBase } from '@renderer/types'
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface AdvancedSettingsPanelProps {
  newBase: KnowledgeBase
  handlers: {
    handleChunkSizeChange: (value: number | null) => void
    handleChunkOverlapChange: (value: number | null) => void
    handleThresholdChange: (value: number | null) => void
  }
}

const AdvancedSettingsPanel: React.FC<AdvancedSettingsPanelProps> = ({ newBase, handlers }) => {
  const { t } = useTranslation()
  const { handleChunkSizeChange, handleChunkOverlapChange, handleThresholdChange } = handlers

  return (
    <div className="px-4">
      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('knowledge.chunk_size')}
          <InfoTooltip title={t('knowledge.chunk_size_tooltip')} placement="right" />
        </div>
        <Input
          type="number"
          size="sm"
          min={100}
          value={newBase.chunkSize?.toString() || ''}
          placeholder={t('knowledge.chunk_size_placeholder')}
          onChange={(e) => handleChunkSizeChange(e.target.value ? Number(e.target.value) : null)}
          aria-label={t('knowledge.chunk_size')}
          classNames={{
            input: 'bg-transparent'
          }}
        />
      </div>

      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('knowledge.chunk_overlap')}
          <InfoTooltip title={t('knowledge.chunk_overlap_tooltip')} placement="right" />
        </div>
        <Input
          type="number"
          size="sm"
          min={0}
          value={newBase.chunkOverlap?.toString() || ''}
          placeholder={t('knowledge.chunk_overlap_placeholder')}
          onChange={(e) => handleChunkOverlapChange(e.target.value ? Number(e.target.value) : null)}
          aria-label={t('knowledge.chunk_overlap')}
          classNames={{
            input: 'bg-transparent'
          }}
        />
      </div>

      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('knowledge.threshold')}
          <InfoTooltip title={t('knowledge.threshold_tooltip')} placement="right" />
        </div>
        <Input
          type="number"
          size="sm"
          step={0.1}
          min={0}
          max={1}
          value={newBase.threshold?.toString() || ''}
          placeholder={t('knowledge.threshold_placeholder')}
          onChange={(e) => handleThresholdChange(e.target.value ? Number(e.target.value) : null)}
          aria-label={t('knowledge.threshold')}
          classNames={{
            input: 'bg-transparent'
          }}
        />
      </div>

      <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-50/50 border border-warning-200">
        <TriangleAlert size={16} className="text-warning-600 mt-0.5 flex-shrink-0" />
        <span className="text-sm text-warning-800">{t('knowledge.chunk_size_change_warning')}</span>
      </div>
    </div>
  )
}

export default AdvancedSettingsPanel
