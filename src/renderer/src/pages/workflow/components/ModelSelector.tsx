import { Button, Card, CardBody, Chip, Spinner } from '@heroui/react'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@shared/types'
import { ChevronDown, Cpu } from 'lucide-react'
import { FC, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ModelSelectorProps {
  selectedModel: Model | null
  onModelSelect: (model: Model) => void
}

const ModelSelector: FC<ModelSelectorProps> = ({ selectedModel, onModelSelect }) => {
  const { t } = useTranslation()
  const providers = useAppSelector((s) => s.llm.providers)
  const [isOpen, setIsOpen] = useState(false)

  // Filter only enabled providers
  const enabledProviders = useMemo(() => {
    return providers.filter((p) => p.enabled !== false)
  }, [providers])

  const handleModelSelect = useCallback(
    (model: Model) => {
      onModelSelect(model)
      setIsOpen(false)
    },
    [onModelSelect]
  )

  if (!enabledProviders.length) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="w-full">
      <label className="text-sm font-medium text-foreground/70 mb-2 block">
        {t('workflow.config.selectModel', '选择模型')}
      </label>

      {/* Selected Model Display / Trigger */}
      <Button
        variant="bordered"
        className="w-full justify-between h-14"
        onPress={() => setIsOpen(!isOpen)}
        endContent={<ChevronDown size={20} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
      >
        {selectedModel ? (
          <div className="flex items-center gap-3">
            <Cpu size={20} className="text-primary" />
            <div className="text-left">
              <div className="font-medium">{selectedModel.name}</div>
              <div className="text-xs text-foreground/50">{selectedModel.provider}</div>
            </div>
          </div>
        ) : (
          <span className="text-foreground/50">{t('workflow.config.selectModelPlaceholder', '请选择一个模型')}</span>
        )}
      </Button>

      {/* Model List Dropdown */}
      {isOpen && (
        <Card className="mt-2 max-h-80 overflow-y-auto">
          <CardBody className="p-2">
            {enabledProviders.map((provider) => {
              const providerModels = provider.models.filter(
                (m) => !isEmbeddingModel(m) && !isRerankModel(m) && !isTextToImageModel(m)
              )
              if (providerModels.length === 0) return null

              return (
                <div key={provider.id} className="mb-3 last:mb-0">
                  <div className="px-2 py-1 text-xs font-semibold text-foreground/50 uppercase tracking-wide">
                    {provider.name}
                  </div>
                  {providerModels.map((model) => (
                    <Button
                      key={`${model.provider}-${model.id}`}
                      variant={selectedModel?.id === model.id && selectedModel?.provider === model.provider ? 'flat' : 'light'}
                      className="w-full justify-start h-12 mb-1"
                      onPress={() => handleModelSelect(model)}
                    >
                      <div className="flex items-center gap-3 w-full">
                        <Cpu size={18} className="text-foreground/50" />
                        <div className="flex-1 text-left">
                          <div className="font-medium truncate">{model.name}</div>
                        </div>
                        {selectedModel?.id === model.id && selectedModel?.provider === model.provider && (
                          <Chip size="sm" color="primary" variant="flat">
                            {t('workflow.config.selected', '已选')}
                          </Chip>
                        )}
                      </div>
                    </Button>
                  ))}
                </div>
              )
            })}
          </CardBody>
        </Card>
      )}
    </div>
  )
}

export default ModelSelector
