import { Button, Card, CardBody, Chip, Spinner } from '@heroui/react'
import { isEmbeddingModel, isRerankModel, isTextToImageModel, isVisionModel } from '@renderer/config/models'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@shared/types'
import type { ProviderType } from '@renderer/types'
import { ChevronDown, Cpu } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface Props {
  selectedModel: Model | null
  onModelSelect: (model: Model) => void
  storageKey?: string
  label?: string
  /**
   * 可选：限制展示哪些 provider 类型。
   * - 不传：展示所有启用 provider（与工作流一致）
   */
  allowedProviderTypes?: ProviderType[]
}

const DEFAULT_STORAGE_KEY = 'gist-video.visionModelSelector.last.v1'

const isSelectableModel = (m: Model) => !isEmbeddingModel(m) && !isRerankModel(m) && !isTextToImageModel(m)

const VisionModelSelector: FC<Props> = ({
  selectedModel,
  onModelSelect,
  storageKey,
  label = '选择模型',
  allowedProviderTypes
}) => {
  const providers = useAppSelector((s) => s.llm.providers)
  const [isOpen, setIsOpen] = useState(false)
  const resolvedStorageKey = storageKey || DEFAULT_STORAGE_KEY

  const enabledProviders = useMemo(() => {
    return providers.filter((p) => p.enabled !== false)
  }, [providers])

  const filteredProviders = useMemo(() => {
    return enabledProviders
      .filter((p) => (allowedProviderTypes && allowedProviderTypes.length ? allowedProviderTypes.includes(p.type as ProviderType) : true))
      .map((p) => ({
        ...p,
        // 默认展示所有可对话模型（与工作流 ModelSelector 一致），避免只出现一个分组。
        // 同时我们仍然会在 UI 上标记是否为 Vision 模型。
        models: (p.models || []).filter((m) => isSelectableModel(m))
      }))
      .filter((p) => p.models.length > 0)
  }, [allowedProviderTypes, enabledProviders])

  // restore last selection
  useEffect(() => {
    if (selectedModel) return
    if (!filteredProviders.length) return
    if (typeof window === 'undefined') return

    try {
      const raw = window.localStorage.getItem(resolvedStorageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as any).provider !== 'string' ||
        typeof (parsed as any).id !== 'string'
      ) {
        return
      }
      const providerId = (parsed as any).provider as string
      const modelId = (parsed as any).id as string

      const match =
        filteredProviders
          .flatMap((p) => p.models)
          .find((m) => m.provider === providerId && m.id === modelId) ?? null

      if (match) onModelSelect(match)
    } catch {
      // ignore
    }
  }, [filteredProviders, onModelSelect, resolvedStorageKey, selectedModel])

  const handleSelect = useCallback(
    (model: Model) => {
      try {
        window.localStorage.setItem(resolvedStorageKey, JSON.stringify({ provider: model.provider, id: model.id }))
      } catch {
        // ignore
      }
      onModelSelect(model)
      setIsOpen(false)
    },
    [onModelSelect, resolvedStorageKey]
  )

  if (!filteredProviders.length) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="w-full">
      <label className="mb-2 block text-sm font-medium text-foreground/70">{label}</label>

      <Button
        variant="flat"
        className="h-14 w-full justify-between bg-content2/50 transition-colors hover:bg-content2/80"
        onPress={() => setIsOpen(!isOpen)}
        endContent={<ChevronDown size={20} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
      >
        {selectedModel ? (
          <div className="flex items-center gap-3">
            <Cpu size={20} className="text-primary" />
            <div className="text-left">
              <div className="font-medium">{selectedModel.name}</div>
              <div className="text-foreground/50 text-xs">{selectedModel.provider}</div>
            </div>
          </div>
        ) : (
          <span className="text-foreground/50">请选择一个 Vision 模型</span>
        )}
      </Button>

      {isOpen ? (
        <Card className="mt-2 max-h-80 overflow-y-auto">
          <CardBody className="p-2">
            {filteredProviders.map((provider) => (
              <div key={provider.id} className="mb-3 last:mb-0">
                <div className="px-2 py-1 text-foreground/50 text-xs font-semibold uppercase tracking-wide">
                  {provider.name}
                </div>
                {provider.models.map((model) => {
                  const isSelected = selectedModel?.id === model.id && selectedModel?.provider === model.provider
                  return (
                    <Button
                      key={`${model.provider}-${model.id}`}
                      variant={isSelected ? 'flat' : 'light'}
                      className="mb-1 h-12 w-full justify-start"
                      onPress={() => handleSelect(model)}
                    >
                      <div className="flex w-full items-center gap-3">
                        <Cpu size={18} className="text-foreground/50" />
                        <div className="flex-1 text-left">
                          <div className="truncate font-medium">{model.name}</div>
                        </div>
                        {isSelected ? (
                          <Chip size="sm" color="primary" variant="flat">
                            已选
                          </Chip>
                        ) : isVisionModel(model) ? (
                          <Chip size="sm" color="success" variant="flat">
                            Vision
                          </Chip>
                        ) : (
                          <Chip size="sm" color="warning" variant="flat">
                            非Vision
                          </Chip>
                        )}
                      </div>
                    </Button>
                  )
                })}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}

export default VisionModelSelector
