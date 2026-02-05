import { Card, CardBody, Input, Select, SelectItem, Slider } from '@heroui/react'
import { useTranslation } from 'react-i18next'

import { getStyleLabelZh } from './ttsLabels'

export type TtsMode = 'normal' | 'advanced'
export type AdvancedTTSProvider = 'microsoft' | 'zai'

export type VoiceItem = {
  shortName: string
  displayName: string
  localName?: string
  gender?: string
  locale?: string
  localeName?: string
  styleList?: string[]
}

export type SelectOption = { value: string; label: string }

const getGenderKey = (gender?: string) => {
  const normalized = gender?.toLowerCase()
  if (normalized?.startsWith('f')) return 'female'
  if (normalized?.startsWith('m')) return 'male'
  return 'unknown'
}

const getGenderLabel = (gender?: string) => {
  const key = getGenderKey(gender)
  if (key === 'female') return '女声'
  if (key === 'male') return '男声'
  return '未知'
}

type Props = {
  isGenerating: boolean

  ttsMode: TtsMode
  advancedProvider: AdvancedTTSProvider
  setAdvancedProvider: (value: AdvancedTTSProvider) => void
  portalContainer?: HTMLElement

  voiceLoadError?: string | null
  isLoadingVoices: boolean

  languageFilter: string
  setLanguageFilter: (value: string) => void
  regionFilter: string
  setRegionFilter: (value: string) => void
  genderFilter: string
  setGenderFilter: (value: string) => void

  languageSelectItems: SelectOption[]
  regionSelectItems: SelectOption[]
  genderSelectItems: SelectOption[]

  filteredVoices: VoiceItem[]
  activeVoice: string
  setActiveVoice: (voice: string) => void

  advancedStyle: string
  setAdvancedStyle: (value: string) => void
  styleOptions: string[]
  isLoadingStyles: boolean

  rateValue: number
  setRateValue: (value: number) => void
  pitchValue: number
  setPitchValue: (value: number) => void
  advancedRateValue: number
  setAdvancedRateValue: (value: number) => void
  advancedPitchValue: number
  setAdvancedPitchValue: (value: number) => void
}

export default function TtsVoiceConfigCard(props: Props) {
  const { t } = useTranslation()
  const {
    isGenerating,
    ttsMode,
    advancedProvider,
    setAdvancedProvider,
    portalContainer,
    voiceLoadError,
    isLoadingVoices,
    languageFilter,
    setLanguageFilter,
    regionFilter,
    setRegionFilter,
    genderFilter,
    setGenderFilter,
    languageSelectItems,
    regionSelectItems,
    genderSelectItems,
    filteredVoices,
    activeVoice,
    setActiveVoice,
    advancedStyle,
    setAdvancedStyle,
    styleOptions,
    isLoadingStyles,
    rateValue,
    setRateValue,
    pitchValue,
    setPitchValue,
    advancedRateValue,
    setAdvancedRateValue,
    advancedPitchValue,
    setAdvancedPitchValue
  } = props

  const isAdvanced = ttsMode === 'advanced'
  const isZaiAdvanced = isAdvanced && advancedProvider === 'zai'

  const popoverProps = portalContainer
    ? { portalContainer, classNames: { content: 'z-[200]' } as Record<string, string> }
    : undefined

  return (
    <Card className="w-full max-w-2xl bg-content1/50 border border-white/5 shadow-sm backdrop-blur-md">
      <CardBody className="p-8 space-y-8">
        {!isZaiAdvanced && voiceLoadError && (
          <p className="text-xs text-danger-500">{voiceLoadError}</p>
        )}

        {isAdvanced && (
          <Select
            label={t('workflow.tts.provider', '供应商')}
            selectedKeys={[advancedProvider]}
            onChange={(e) => setAdvancedProvider(e.target.value as AdvancedTTSProvider)}
            variant="flat"
            labelPlacement="outside"
            isDisabled={isGenerating}
            classNames={{
              trigger: "bg-content2/50 hover:bg-content2/80 transition-colors h-12",
              value: "text-base"
            }}
            popoverProps={popoverProps}
          >
            <SelectItem key="microsoft">{t('workflow.tts.provider.microsoft', 'Microsoft')}</SelectItem>
            <SelectItem key="zai">{t('workflow.tts.provider.zai', 'ZAI')}</SelectItem>
          </Select>
        )}

        {isZaiAdvanced ? (
          <div className="space-y-2">
            <Input
              label={t('workflow.tts.voiceId', '音色ID')}
              value={activeVoice}
              onValueChange={setActiveVoice}
              variant="flat"
              labelPlacement="outside"
              placeholder="system_001"
              isDisabled={isGenerating}
              classNames={{
                inputWrapper: 'bg-content2/50 hover:bg-content2/80 transition-colors h-12',
                input: 'text-base'
              }}
            />
            <p className="text-xs text-foreground/50">
              {t('workflow.tts.voiceIdHint', 'ZAI 模式下 voice 为 voice_id（如 system_001 或你的克隆音色 voice_id）')}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Select
                label={t('workflow.tts.language', '语言')}
                selectedKeys={[languageFilter]}
                onChange={(e) => setLanguageFilter(e.target.value)}
                variant="flat"
                labelPlacement="outside"
                isDisabled={isGenerating || isLoadingVoices}
                items={languageSelectItems}
                classNames={{
                  trigger: "bg-content2/50 hover:bg-content2/80 transition-colors h-12",
                  value: "text-base"
                }}
                popoverProps={popoverProps}
              >
                {(item) => <SelectItem key={item.value}>{item.label}</SelectItem>}
              </Select>

              <Select
                label={t('workflow.tts.region', '区域')}
                selectedKeys={[regionFilter]}
                onChange={(e) => setRegionFilter(e.target.value)}
                variant="flat"
                labelPlacement="outside"
                isDisabled={isGenerating || isLoadingVoices || regionSelectItems.length === 0}
                items={regionSelectItems}
                classNames={{
                  trigger: "bg-content2/50 hover:bg-content2/80 transition-colors h-12",
                  value: "text-base"
                }}
                popoverProps={popoverProps}
              >
                {(item) => <SelectItem key={item.value}>{item.label}</SelectItem>}
              </Select>

              <Select
                label={t('workflow.tts.gender', '性别')}
                selectedKeys={[genderFilter]}
                onChange={(e) => setGenderFilter(e.target.value)}
                variant="flat"
                labelPlacement="outside"
                isDisabled={isGenerating || isLoadingVoices || genderSelectItems.length === 0}
                items={genderSelectItems}
                classNames={{
                  trigger: "bg-content2/50 hover:bg-content2/80 transition-colors h-12",
                  value: "text-base"
                }}
                popoverProps={popoverProps}
              >
                {(item) => <SelectItem key={item.value}>{item.label}</SelectItem>}
              </Select>
            </div>

            <Select
              label={t('workflow.tts.voice', '音色')}
              selectedKeys={filteredVoices.some((item) => item.shortName === activeVoice) ? [activeVoice] : []}
              onChange={(e) => setActiveVoice(e.target.value)}
              variant="flat"
              labelPlacement="outside"
              placeholder={t('workflow.tts.voice', '音色')}
              isDisabled={isGenerating || isLoadingVoices || filteredVoices.length === 0}
              classNames={{
                trigger: "bg-content2/50 hover:bg-content2/80 transition-colors h-12",
                value: "text-base"
              }}
              popoverProps={popoverProps}
            >
              {filteredVoices.map((item) => (
                <SelectItem key={item.shortName}>
                  {`${item.localName || item.shortName} - ${getGenderLabel(item.gender)}`}
                </SelectItem>
              ))}
            </Select>

            {ttsMode === 'advanced' && advancedProvider === 'microsoft' && (
              <Select
                label={t('workflow.tts.style', '风格')}
                selectedKeys={[advancedStyle || 'general']}
                onChange={(e) => setAdvancedStyle(e.target.value)}
                variant="flat"
                labelPlacement="outside"
                isDisabled={isGenerating || isLoadingStyles}
                classNames={{
                  trigger: "bg-content2/50 hover:bg-content2/80 transition-colors h-12",
                  value: "text-base"
                }}
                popoverProps={popoverProps}
              >
                {(styleOptions.length > 0 ? styleOptions : ['general']).map((style) => (
                  <SelectItem key={style}>{getStyleLabelZh(style)}</SelectItem>
                ))}
              </Select>
            )}
          </>
        )}

        <div className={`grid grid-cols-1 ${isZaiAdvanced ? 'md:grid-cols-1' : 'md:grid-cols-2'} gap-6`}>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm text-foreground/70">
              <span>{t('workflow.tts.rate', '语速')}</span>
              <span className="px-2 py-0.5 rounded bg-content2/60 text-xs">
                {ttsMode === 'advanced' ? `${advancedRateValue}%` : `${rateValue}%`}
              </span>
            </div>
            <Slider
              size="sm"
              minValue={-100}
              maxValue={100}
              value={ttsMode === 'advanced' ? advancedRateValue : rateValue}
              onChange={(value) => {
                const next = value as number
                if (ttsMode === 'advanced') setAdvancedRateValue(next)
                else setRateValue(next)
              }}
              isDisabled={isGenerating}
            />
          </div>

          {!isZaiAdvanced && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm text-foreground/70">
                <span>{t('workflow.tts.pitch', '语调')}</span>
                <span className="px-2 py-0.5 rounded bg-content2/60 text-xs">
                  {ttsMode === 'advanced' ? `${advancedPitchValue}%` : `${pitchValue}%`}
                </span>
              </div>
              <Slider
                size="sm"
                minValue={-100}
                maxValue={100}
                value={ttsMode === 'advanced' ? advancedPitchValue : pitchValue}
                onChange={(value) => {
                  const next = value as number
                  if (ttsMode === 'advanced') setAdvancedPitchValue(next)
                  else setPitchValue(next)
                }}
                isDisabled={isGenerating}
              />
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
