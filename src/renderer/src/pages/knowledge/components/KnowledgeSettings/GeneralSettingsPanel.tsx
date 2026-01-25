import { Input, Select, SelectItem, Slider } from '@heroui/react'
import InputEmbeddingDimension from '@renderer/components/InputEmbeddingDimension'
import ModelSelector from '@renderer/components/ModelSelector'
import { InfoTooltip } from '@renderer/components/TooltipIcons'
import { DEFAULT_KNOWLEDGE_DOCUMENT_COUNT } from '@renderer/config/constant'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { useProviders } from '@renderer/hooks/useProvider'
import { getModelUniqId } from '@renderer/services/ModelService'
import { KnowledgeBase, PreprocessProvider } from '@renderer/types'
import { useTranslation } from 'react-i18next'

interface GeneralSettingsPanelProps {
  newBase: KnowledgeBase
  setNewBase: React.Dispatch<React.SetStateAction<KnowledgeBase>>
  selectedDocPreprocessProvider?: PreprocessProvider
  docPreprocessSelectOptions: Array<{
    label: string
    title: string
    options: Array<{ value: string; label: string }>
  }>
  handlers: {
    handleEmbeddingModelChange: (value: string) => void
    handleDimensionChange: (value: number | null) => void
    handleRerankModelChange: (value: string) => void
    handleDocPreprocessChange: (value: string) => void
  }
}

const GeneralSettingsPanel: React.FC<GeneralSettingsPanelProps> = ({
  newBase,
  setNewBase,
  selectedDocPreprocessProvider,
  docPreprocessSelectOptions,
  handlers
}) => {
  const { t } = useTranslation()
  const { providers } = useProviders()
  const { handleEmbeddingModelChange, handleDimensionChange, handleRerankModelChange, handleDocPreprocessChange } =
    handlers

  return (
    <div className="px-4">
      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">{t('common.name')}</div>
        <Input
          size="sm"
          placeholder={t('common.name')}
          value={newBase.name}
          onChange={(e) => setNewBase((prev) => ({ ...prev, name: e.target.value }))}
          classNames={{
            input: 'bg-transparent'
          }}
        />
      </div>

      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('settings.tool.preprocess.title')}
          <InfoTooltip title={t('settings.tool.preprocess.tooltip')} placement="right" />
        </div>
        <Select
          size="sm"
          selectedKeys={selectedDocPreprocessProvider?.id ? [selectedDocPreprocessProvider.id] : []}
          placeholder={t('settings.tool.preprocess.provider_placeholder')}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string
            handleDocPreprocessChange(selected)
          }}
          classNames={{
            trigger: 'bg-transparent'
          }}>
          {docPreprocessSelectOptions?.flatMap((group) =>
            group.options.map((option) => <SelectItem key={option.value}>{option.label}</SelectItem>)
          ) || []}
        </Select>
      </div>

      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('models.embedding_model')}
          <InfoTooltip title={t('models.embedding_model_tooltip')} placement="right" />
        </div>
        <ModelSelector
          providers={providers}
          predicate={isEmbeddingModel}
          style={{ width: '100%' }}
          placeholder={t('settings.models.empty')}
          value={getModelUniqId(newBase.model)}
          onChange={handleEmbeddingModelChange}
        />
      </div>

      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('knowledge.dimensions')}
          <InfoTooltip title={t('knowledge.dimensions_size_tooltip')} placement="right" />
        </div>
        <InputEmbeddingDimension
          value={newBase.dimensions}
          onChange={handleDimensionChange}
          model={newBase.model}
          disabled={!newBase.model}
        />
      </div>

      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('models.rerank_model')}
          <InfoTooltip title={t('models.rerank_model_tooltip')} placement="right" />
        </div>
        <ModelSelector
          providers={providers}
          predicate={isRerankModel}
          style={{ width: '100%' }}
          value={getModelUniqId(newBase.rerankModel) || undefined}
          placeholder={t('settings.models.empty')}
          onChange={handleRerankModelChange}
          allowClear
        />
      </div>

      <div className="mb-6">
        <div className="text-sm mb-2 flex items-center gap-2">
          {t('knowledge.document_count')}
          <InfoTooltip title={t('knowledge.document_count_help')} placement="right" />
        </div>
        <Slider
          size="sm"
          minValue={1}
          maxValue={50}
          step={1}
          value={newBase.documentCount || DEFAULT_KNOWLEDGE_DOCUMENT_COUNT}
          onChange={(value) => setNewBase((prev) => ({ ...prev, documentCount: value as number }))}
          marks={[
            { value: 1, label: '1' },
            { value: 6, label: t('knowledge.document_count_default') },
            { value: 30, label: '30' },
            { value: 50, label: '50' }
          ]}
          className="max-w-full"
        />
      </div>
    </div>
  )
}

export default GeneralSettingsPanel
