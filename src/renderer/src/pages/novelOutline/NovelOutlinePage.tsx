import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { IndeterminateProgress } from '@renderer/components/IndeterminateProgress'
import ModelSelectButton from '@renderer/components/ModelSelectButton'
import SelectModelPopup from '@renderer/components/Popups/SelectModelPopup'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import { useNovelOutline } from '@renderer/hooks/useNovelOutline'
import { useAppSelector } from '@renderer/store'
import type {
  CompressionUsageMetrics,
  Model,
  NovelOutlineState
} from '@shared/types'
import type { TabsProps } from 'antd'
import {
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Flex,
  Input,
  InputNumber,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import dayjs from 'dayjs'
import { FileText, Minus, Plus, Upload, XCircle } from 'lucide-react'
import React, { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

// 这些函数已经移动到 CharacterInput 组件中，不再需要在这里定义

const chunkStatusColor: Record<NovelOutlineState['chunkSummaries'][number]['status'], string> = {
  pending: 'default',
  processing: 'processing',
  completed: 'success',
  error: 'error'
}

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const formatDuration = (ms?: number) => {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

const formatUsage = (usage?: CompressionUsageMetrics) => {
  if (!usage) return ''
  const entries = Object.entries(usage).filter(([, value]) => typeof value === 'number')
  if (entries.length === 0) return ''
  return entries.map(([key, value]) => `${key}: ${value}`).join(' · ')
}

// region Sub-components

const LogView: React.FC<{ logs: NovelOutlineState['logs'] }> = ({ logs }) => {
  const { t } = useTranslation()
  if (!logs.length) {
    return <Typography.Text type="secondary">{t('novel.logs.placeholder')}</Typography.Text>
  }
  return (
    <LogContainer>
      {logs.map((log) => (
        <LogItem key={log.id}>
          <Flex align="center" gap={8} wrap>
            <Tag
              color={log.level === 'error' ? 'error' : log.level === 'warning' ? 'warning' : 'default'}
            >
              {log.level.toUpperCase()}
            </Tag>
            <Typography.Text strong>{dayjs(log.timestamp).format('HH:mm:ss')}</Typography.Text>
          </Flex>
          <Typography.Text style={{ marginTop: 4 }}>{log.message}</Typography.Text>
          {log.data && (
            <Typography.Text style={{ marginTop: 4 }} type="secondary">
              {JSON.stringify(log.data)}
            </Typography.Text>
          )}
        </LogItem>
      ))}
    </LogContainer>
  )
}

const ModelPoolHealthView: React.FC<{ modelHealthStats: NovelOutlineState['modelHealthStats'] }> = ({
  modelHealthStats
}) => {
  if (!modelHealthStats || modelHealthStats.length === 0) {
    return <Typography.Text type="secondary">等待模型池初始化...</Typography.Text>
  }

  return (
    <Flex vertical gap={12}>
      {modelHealthStats.map((stat) => (
        <Card
          key={stat.index}
          size="small"
          style={{
            borderLeft: stat.healthy ? '3px solid #52c41a' : '3px solid #ff4d4f'
          }}
        >
          <Flex vertical gap={8}>
            {/* 模型名称和状态 */}
            <Flex align="center" justify="space-between">
              <Space size={8}>
                <Typography.Text strong style={{ fontSize: 16 }}>
                  #{stat.index} {stat.model}
                </Typography.Text>
                <Tag color={stat.healthy ? 'success' : 'error'}>
                  {stat.healthy ? '✓ 健康' : '✗ 不健康'}
                </Tag>
              </Space>
              <Typography.Text strong style={{ fontSize: 18, color: stat.healthy ? '#52c41a' : '#ff4d4f' }}>
                {stat.successRate}
              </Typography.Text>
            </Flex>

            {/* 提供商信息 */}
            <Flex gap={16} wrap="wrap">
              <Space size={4}>
                <Typography.Text type="secondary">提供商:</Typography.Text>
                <Typography.Text>{stat.provider}</Typography.Text>
              </Space>
              <Space size={4}>
                <Typography.Text type="secondary">端点:</Typography.Text>
                <Typography.Text code style={{ fontSize: 12 }}>{stat.baseUrl}</Typography.Text>
              </Space>
            </Flex>

            {/* 统计信息 */}
            <Flex gap={24}>
              <Space size={4}>
                <Typography.Text type="secondary">成功:</Typography.Text>
                <Typography.Text strong style={{ color: '#52c41a' }}>{stat.successes}</Typography.Text>
              </Space>
              <Space size={4}>
                <Typography.Text type="secondary">失败:</Typography.Text>
                <Typography.Text strong style={{ color: '#ff4d4f' }}>{stat.failures}</Typography.Text>
              </Space>
              <Space size={4}>
                <Typography.Text type="secondary">总计:</Typography.Text>
                <Typography.Text strong>{stat.total}</Typography.Text>
              </Space>
            </Flex>

            {/* 错误信息显示 */}
            {stat.lastError && stat.failures > 0 && (
              <Flex
                style={{
                  marginTop: 8,
                  padding: '8px 12px',
                  background: '#fff2f0',
                  border: '1px solid #ffccc7',
                  borderRadius: 4
                }}
                vertical
                gap={4}
              >
                <Flex align="center" gap={6}>
                  <Typography.Text strong style={{ color: '#ff4d4f', fontSize: 12 }}>
                    ⚠️ 最近失败原因:
                  </Typography.Text>
                </Flex>
                <Typography.Text
                  style={{
                    fontSize: 12,
                    color: '#595959',
                    wordBreak: 'break-word',
                    lineHeight: 1.5
                  }}
                >
                  {stat.lastError}
                </Typography.Text>
              </Flex>
            )}
          </Flex>
        </Card>
      ))}
    </Flex>
  )
}

const ChunkStatusView: React.FC<{ chunkSummaries: NovelOutlineState['chunkSummaries'] }> = ({
  chunkSummaries
}) => {
  const { t } = useTranslation()
  if (!chunkSummaries.length) return null
  return (
    <ChunkList>
      {chunkSummaries.map((chunk) => (
        <div key={chunk.index}>
          <Flex align="center" justify="space-between">
            <Space size={8}>
              <Typography.Text strong>
                {t('novel.result.chunk_title', { index: chunk.index + 1 })}
              </Typography.Text>
              <Tag color={chunkStatusColor[chunk.status]}>
                {t(`novel.status.${chunk.status}` as any)}
              </Tag>
            </Space>
            <Typography.Text type="secondary">{formatDuration(chunk.durationMs)}</Typography.Text>
          </Flex>
          <Flex vertical gap={4} style={{ marginTop: 4 }}>
            <Typography.Text type="secondary">
              {t('novel.result.chunk_stats', {
                inputLength: chunk.inputLength,
                targetLength: chunk.targetLength
              })}
            </Typography.Text>
            {chunk.outputLength !== undefined && (
              <Typography.Text type="secondary">
                {t('novel.result.chunk_output_length', { outputLength: chunk.outputLength })}
              </Typography.Text>
            )}
            {chunk.usage && (
              <Typography.Text type="secondary">{formatUsage(chunk.usage)}</Typography.Text>
            )}
            {chunk.errorMessage && (
              <Typography.Text type="danger">{chunk.errorMessage}</Typography.Text>
            )}
          </Flex>
          <Divider style={{ margin: '8px 0' }} />
        </div>
      ))}
    </ChunkList>
  )
}

/**
 * 交互式人物剧情查看器
 * 可以选择特定人物和章节，查看对应的剧情内容
 * 支持加载已保存的 JSON 矩阵文件
 * 支持在生成过程中动态更新（自动加载新生成的JSON文件）
 */
interface SettingsPanelProps {
  state: NovelOutlineState
  actions: ReturnType<typeof useNovelOutline>['actions']
  modelFilter: (model: Model) => boolean
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ state, actions, modelFilter }) => {
  const { t } = useTranslation()
  const {
    selectedModel,
    selectedModels,
    enableMultiModel,
    chunkSize,
    overlap,
    maxConcurrency,
    continueLatestTask,
    enableAutoResume
  } = state

  // 这些状态变量已经不再需要，因为使用了新的 CharacterInput 组件

  const handleUpdateOptions = useCallback(
    (settings: Partial<NovelOutlineState>) => actions.updateSettings(settings),
    [actions]
  )

  const handleModelSelect = useCallback(
    (model: Model) => actions.updateSettings({ selectedModel: model }),
    [actions]
  )

  const handleOpenModelPicker = useCallback(async () => {
    const model = await SelectModelPopup.show({
      model: state?.selectedModel ?? undefined,
      filter: modelFilter
    })
    if (model) actions.updateSettings({ selectedModel: model })
  }, [modelFilter, state?.selectedModel, actions])

  const handleAddModel = useCallback(async () => {
    const model = await SelectModelPopup.show({ filter: modelFilter })
    if (
      model &&
      !state?.selectedModels.find((m) => m.id === model.id && m.provider === model.provider)
    ) {
      actions.updateSettings({ selectedModels: [...(state?.selectedModels ?? []), model] })
    }
  }, [modelFilter, state?.selectedModels, actions])

  const handleRemoveModel = useCallback(
    (modelId: string) => {
      actions.updateSettings({
        selectedModels: state?.selectedModels.filter((m) => m.id !== modelId)
      })
    },
    [state?.selectedModels, actions]
  )

  const handleToggleMultiModel = useCallback(
    (enabled: boolean) => {
      actions.updateSettings({
        enableMultiModel: enabled,
        selectedModels: enabled ? state?.selectedModels : []
      })
    },
    [actions, state?.selectedModels]
  )

  return (
    <Flex vertical gap={20}>
      {/* 大纲提取不需要输出格式选项，固定输出为 Markdown */}
      {/* 大纲提取不需要指定人物模式，自动提取所有大纲要素 */}

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex justify="space-between" align="center">
          <Typography.Text>{t('novel.settings.model')}</Typography.Text>
          <Checkbox
            checked={enableMultiModel}
            onChange={(e) => handleToggleMultiModel(e.target.checked)}
          >
            {t('novel.settings.multi_model_poll')}
          </Checkbox>
        </Flex>
        {!enableMultiModel ? (
          selectedModel ? (
            <ModelSelectButton
              model={selectedModel}
              onSelectModel={handleModelSelect}
              modelFilter={modelFilter}
            />
          ) : (
            <Button type="dashed" onClick={handleOpenModelPicker} block>
              {t('novel.settings.model_placeholder')}
            </Button>
          )
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Flex justify="space-between" align="center">
              <Typography.Text type="secondary">
                {t('novel.settings.models_selected', {
                  count: selectedModels.length
                })}
              </Typography.Text>
              <Button
                type="dashed"
                size="small"
                icon={<Plus size={14} />}
                onClick={handleAddModel}
              >
                {t('novel.settings.add_model')}
              </Button>
            </Flex>

            {selectedModels.length > 0 && (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {selectedModels.map((model, index) => (
                  <Flex
                    key={`${model.id}-${model.provider}`}
                    justify="space-between"
                    align="center"
                    style={{
                      padding: '8px 12px',
                      border: '1px solid var(--color-border)',
                      borderRadius: '6px',
                      backgroundColor: 'var(--color-background-soft)'
                    }}
                  >
                    <Flex align="center" gap={8}>
                      <Typography.Text strong>#{index + 1}</Typography.Text>
                      <ModelSelectButton
                        model={model}
                        onSelectModel={(newModel) => {
                          handleUpdateOptions({
                            selectedModels: selectedModels.map((m) =>
                              m.id === model.id && m.provider === model.provider ? newModel : m
                            )
                          })
                        }}
                        modelFilter={modelFilter}
                        noTooltip
                      />
                      <Typography.Text>{model.name}</Typography.Text>
                    </Flex>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<Minus size={14} />}
                      onClick={() => handleRemoveModel(model.id)}
                    />
                  </Flex>
                ))}
              </Space>
            )}

            {selectedModels.length === 0 && (
              <Typography.Text
                type="secondary"
                style={{ textAlign: 'center', display: 'block', padding: '16px' }}
              >
                {t('novel.settings.add_one_model_tip')}
              </Typography.Text>
            )}
          </Space>
        )}
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text>{t('novel.settings.chunk_size')}</Typography.Text>
        <InputNumber
          min={600}
          step={200}
          value={chunkSize}
          onChange={(value) =>
            actions.updateSettings({
              chunkSize: typeof value === 'number' ? value : chunkSize
            })
          }
          style={{ width: '100%' }}
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text>{t('novel.settings.overlap')}</Typography.Text>
        <InputNumber
          min={0}
          max={Math.max(0, chunkSize - 1)}
          step={50}
          value={overlap}
          onChange={(value) =>
            actions.updateSettings({
              overlap: typeof value === 'number' ? value : overlap
            })
          }
          style={{ width: '100%' }}
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text>并发数（每个模型）</Typography.Text>
        <InputNumber
          min={1}
          max={50}
          step={1}
          value={maxConcurrency}
          onChange={(value) =>
            actions.updateSettings({
              maxConcurrency: typeof value === 'number' ? value : maxConcurrency
            })
          }
          style={{ width: '100%' }}
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex justify="space-between" align="center">
          <Space direction="vertical" size={0}>
            <Typography.Text>继续最近任务（目录续用）</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: '12px' }}>
              继续写入最近一次任务目录，并跳过已完成的分块
            </Typography.Text>
          </Space>
          <Switch
            checked={continueLatestTask}
            onChange={(checked) =>
              actions.updateSettings({
                continueLatestTask: checked
              })
            }
          />
        </Flex>
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex justify="space-between" align="center">
          <Space direction="vertical" size={0}>
            <Typography.Text>失败自动重试</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: '12px' }}>
              失败时自动重试，直到任务成功完成
            </Typography.Text>
          </Space>
          <Switch
            checked={enableAutoResume}
            onChange={(checked) =>
              actions.updateSettings({
                enableAutoResume: checked
              })
            }
          />
        </Flex>
      </Space>
    </Flex>
  )
}

interface PromptSettingsPanelProps {
  state: NovelOutlineState
  actions: ReturnType<typeof useNovelOutline>['actions']
}

const PromptSettingsPanel: React.FC<PromptSettingsPanelProps> = ({ state, actions }) => {
  const { t } = useTranslation()
  const {
    useCustomPrompts,
    customExtractionPrompt,
    customSynthesisPrompt,
    customWorldviewPrompt,
    customProtagonistPrompt,
    customTechniquesPrompt,
    customFactionsPrompt,
    customCharactersPrompt
  } = state

  return (
    <Flex vertical gap={16}>
      <Flex
        vertical
        gap={4}
        style={{
          padding: '8px 12px',
          backgroundColor: '#fffbe6',
          border: '1px solid #ffe58f',
          borderRadius: 4
        }}
      >
        <Typography.Text strong style={{ color: '#d48806' }}>
          ⚠️ {t('novel.prompts.warning.title')}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('novel.prompts.warning.description')}
        </Typography.Text>
      </Flex>

      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Flex justify="space-between" align="center">
          <Typography.Text>{t('novel.prompts.enable')}</Typography.Text>
          <Switch
            checked={useCustomPrompts}
            onChange={(checked) => actions.updateSettings({ useCustomPrompts: checked })}
          />
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('novel.prompts.enable_hint')}
        </Typography.Text>
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex align="center" gap={4}>
          <Typography.Text>{t('novel.prompts.extraction')}</Typography.Text>
          <Tooltip title={t('novel.prompts.extraction_placeholder')}>
            <Typography.Text type="secondary" style={{ cursor: 'help' }}>
              !
            </Typography.Text>
          </Tooltip>
        </Flex>
        <Input.TextArea
          rows={8}
          value={customExtractionPrompt}
          onChange={(e) =>
            actions.updateSettings({ customExtractionPrompt: e.target.value })
          }
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex align="center" gap={4}>
          <Typography.Text>{t('novel.prompts.synthesis')}</Typography.Text>
          <Tooltip title={t('novel.prompts.synthesis_placeholder')}>
            <Typography.Text type="secondary" style={{ cursor: 'help' }}>
              !
            </Typography.Text>
          </Tooltip>
        </Flex>
        <Input.TextArea
          rows={8}
          value={customSynthesisPrompt}
          onChange={(e) =>
            actions.updateSettings({ customSynthesisPrompt: e.target.value })
          }
        />
      </Space>

      <Divider style={{ margin: '8px 0' }} />

      <Typography.Text strong>{t('novel.prompts.section_prompts_title')}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
        {t('novel.prompts.section_prompts_hint')}
      </Typography.Text>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex align="center" gap={4}>
          <Typography.Text>{t('novel.prompts.worldview')}</Typography.Text>
          <Tooltip title={t('novel.prompts.worldview_placeholder')}>
            <Typography.Text type="secondary" style={{ cursor: 'help' }}>
              !
            </Typography.Text>
          </Tooltip>
        </Flex>
        <Input.TextArea
          rows={6}
          value={customWorldviewPrompt}
          onChange={(e) =>
            actions.updateSettings({ customWorldviewPrompt: e.target.value })
          }
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex align="center" gap={4}>
          <Typography.Text>{t('novel.prompts.protagonist')}</Typography.Text>
          <Tooltip title={t('novel.prompts.protagonist_placeholder')}>
            <Typography.Text type="secondary" style={{ cursor: 'help' }}>
              !
            </Typography.Text>
          </Tooltip>
        </Flex>
        <Input.TextArea
          rows={6}
          value={customProtagonistPrompt}
          onChange={(e) =>
            actions.updateSettings({ customProtagonistPrompt: e.target.value })
          }
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex align="center" gap={4}>
          <Typography.Text>{t('novel.prompts.techniques')}</Typography.Text>
          <Tooltip title={t('novel.prompts.techniques_placeholder')}>
            <Typography.Text type="secondary" style={{ cursor: 'help' }}>
              !
            </Typography.Text>
          </Tooltip>
        </Flex>
        <Input.TextArea
          rows={6}
          value={customTechniquesPrompt}
          onChange={(e) =>
            actions.updateSettings({ customTechniquesPrompt: e.target.value })
          }
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex align="center" gap={4}>
          <Typography.Text>{t('novel.prompts.factions')}</Typography.Text>
          <Tooltip title={t('novel.prompts.factions_placeholder')}>
            <Typography.Text type="secondary" style={{ cursor: 'help' }}>
              !
            </Typography.Text>
          </Tooltip>
        </Flex>
        <Input.TextArea
          rows={6}
          value={customFactionsPrompt}
          onChange={(e) =>
            actions.updateSettings({ customFactionsPrompt: e.target.value })
          }
        />
      </Space>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex align="center" gap={4}>
          <Typography.Text>{t('novel.prompts.characters')}</Typography.Text>
          <Tooltip title={t('novel.prompts.characters_placeholder')}>
            <Typography.Text type="secondary" style={{ cursor: 'help' }}>
              !
            </Typography.Text>
          </Tooltip>
        </Flex>
        <Input.TextArea
          rows={6}
          value={customCharactersPrompt}
          onChange={(e) =>
            actions.updateSettings({ customCharactersPrompt: e.target.value })
          }
        />
      </Space>

      <Flex justify="flex-end">
        <Button
          size="small"
          onClick={() =>
            actions.updateSettings({
              // 使用特殊标记让主进程恢复默认 Prompt，而不是简单清空
              // 类型上以 any 绕过，仅在 NovelOutlineMemoryService 中识别 resetPrompts
              ...( { resetPrompts: true } as any )
            })
          }
        >
          {t('novel.prompts.reset_to_default')}
        </Button>
      </Flex>
    </Flex>
  )
}

interface ResultViewProps {
  state: NovelOutlineState
  actions: ReturnType<typeof useNovelOutline>['actions']
}

const ResultView: React.FC<ResultViewProps> = ({ state, actions }) => {
  const { t } = useTranslation()
  const theme = useAppSelector((s) => s.settings.theme)
  const { selectedFile, result, chunkSummaries, logs, outputPath } = state
  const totalLength =
    state.inputText?.length ?? state.selectedFile?.charLength ?? state.selectedFile?.size ?? 0
  const finalLength = result?.final.length ?? 0

  const handleCopyResult = useCallback(async () => {
    if (!result?.final) return
    try {
      await navigator.clipboard.writeText(result.final)
      window.toast.success(t('novel.actions.copy_success'))
    } catch {
      window.toast.error(t('novel.error.copy_failed'))
    }
  }, [result?.final, t])

  const handleSaveResult = useCallback(async () => {
    if (!result?.final) return
    try {
      let baseName = `novel-${dayjs().format('YYYYMMDD-HHmm')}`
      if (selectedFile) {
        const { path } = selectedFile
        const lastDotIndex = path.lastIndexOf('.')
        const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        baseName =
          lastDotIndex > lastSlashIndex
            ? path.substring(lastSlashIndex + 1, lastDotIndex)
            : path.substring(lastSlashIndex + 1)
      }
      const suggested = `${baseName}.outline.md`
      await window.api.file.save(suggested, result.final)
      window.toast.success(t('novel.actions.save_success'))
    } catch (error: any) {
      window.toast.error(t('novel.error.save_failed', { message: error?.message ?? '' }))
    }
  }, [result?.final, selectedFile, t])

  const handleOpenOutput = useCallback(() => {
    if (outputPath) window.api.file.openPath(outputPath)
  }, [outputPath])

  const chunkItems = useMemo(() => {
    if (!chunkSummaries.length) return null
    return (
      <ChunkList>
        {chunkSummaries.map((chunk) => (
          <div key={chunk.index}>
            <Flex align="center" justify="space-between">
              <Space size={8}>
                <Typography.Text strong>
                  {t('novel.result.chunk_title', { index: chunk.index + 1 })}
                </Typography.Text>
                <Tag color={chunkStatusColor[chunk.status]}>
                  {t(`novel.status.${chunk.status}` as any)}
                </Tag>
              </Space>
              <Typography.Text type="secondary">{formatDuration(chunk.durationMs)}</Typography.Text>
            </Flex>
            <Flex vertical gap={4} style={{ marginTop: 4 }}>
              <Typography.Text type="secondary">
                {t('novel.result.chunk_stats', {
                  inputLength: chunk.inputLength,
                  targetLength: chunk.targetLength
                })}
              </Typography.Text>
              {chunk.outputLength !== undefined && (
                <Typography.Text type="secondary">
                  {t('novel.result.chunk_output_length', { outputLength: chunk.outputLength })}
                </Typography.Text>
              )}
              {chunk.usage && (
                <Typography.Text type="secondary">{formatUsage(chunk.usage)}</Typography.Text>
              )}
              {chunk.errorMessage && (
                <Typography.Text type="danger">{chunk.errorMessage}</Typography.Text>
              )}
            </Flex>
            <Divider style={{ margin: '8px 0' }} />
          </div>
        ))}
      </ChunkList>
    )
  }, [chunkSummaries, t])

  const logList = useMemo(() => <LogView logs={logs} />, [logs])

  const tabsItems = useMemo<TabsProps['items']>(() => {
    const items: TabsProps['items'] = []
    
    items.push(
      {
        key: 'chunks',
        label: t('novel.result.details'),
        children:
          chunkItems ?? <Typography.Text type="secondary">{t('novel.debug.placeholder')}</Typography.Text>
      },
      { key: 'logs', label: t('novel.section.logs'), children: logList }
    )
    
    return items
  }, [
    result,
    chunkItems,
    handleCopyResult,
    handleSaveResult,
    handleOpenOutput,
    logList,
    t,
    theme,
    outputPath
  ])

  return (
    <ResultSection>
      <DetailedStatsGrid>
        <StatCard>
          <StatNumber>{totalLength.toLocaleString()}</StatNumber>
          <StatLabel>
            {t('novel.stats.original_length')}
          </StatLabel>
        </StatCard>
        <StatCard>
          <StatNumber>{finalLength.toLocaleString()}</StatNumber>
          <StatLabel>
            {t('novel.stats.actual_length')}
          </StatLabel>
        </StatCard>
        <StatCard>
          <StatNumber>{totalLength > 0 ? Math.round((finalLength / totalLength) * 100) : 0}%</StatNumber>
          <StatLabel>{t('novel.settings.ratio')}</StatLabel>
        </StatCard>
        <StatCard>
          <StatNumber>
            {totalLength > 0 ? `${Math.round((1 - finalLength / totalLength) * 100)}%` : '--'}
          </StatNumber>
          <StatLabel>{t('novel.stats.compression_effect')}</StatLabel>
        </StatCard>
      </DetailedStatsGrid>
      <TabsWrapper>
        <Tabs defaultActiveKey="result" items={tabsItems} />
      </TabsWrapper>
      <ResultViewActions>
        <Button onClick={actions.resetState} size="large" type="primary">
          {t('novel.actions.new_compression')}
        </Button>
      </ResultViewActions>
    </ResultSection>
  )
}

interface MainViewProps {
  state: NovelOutlineState
  actions: ReturnType<typeof useNovelOutline>['actions']
  modelFilter: (model: Model) => boolean
}

const MainView: React.FC<MainViewProps> = ({
  state,
  actions,
  modelFilter
}) => {

  const { t } = useTranslation()
  const {
    selectedFile,
    isProcessing,
    progress,
    selectedModel,
    selectedModels,
    enableMultiModel,
    result,
    logs,
    chunkSummaries,
    modelHealthStats
  } = state

  // 使用 ref 跟踪上一次的处理状态
  const prevIsProcessingRef = React.useRef(isProcessing)
  const [collapseKey, setCollapseKey] = React.useState(0) // 用于强制重新渲染 Collapse

  // 仅在开始处理时重置 Collapse 组件（避免失败时重置导致监控面板关闭）
  React.useEffect(() => {
    if (!prevIsProcessingRef.current && isProcessing) {
      // 从未处理 -> 处理中：重置 Collapse
      setCollapseKey(prev => prev + 1)
    }
    prevIsProcessingRef.current = isProcessing
  }, [isProcessing])

  // 根据处理状态动态设置默认展开的面板
  const defaultActiveKeys = useMemo(() => {
    if (isProcessing) {
      // 处理中：只展开监控面板
      return ['monitoring']
    }
    if (progress && progress.stage === 'failed') {
      // 失败：保持监控面板展开，不自动收起
      return ['monitoring']
    }
    // 未处理：只展开设置
    return ['settings']
  }, [isProcessing, progress])

  // 根据处理状态动态排序面板
  const panelOrder = useMemo(() => {
    if (isProcessing || (progress && progress.stage === 'failed')) {
      // 处理中：监控在前，设置在后
      return [
        {
          key: 'monitoring',
          header: t('novel.section.monitoring'),
          content: (
            <Flex vertical gap={16}>
              {isProcessing || (progress && progress.stage === 'failed') ? (
                <>
                  {isProcessing && <IndeterminateProgress />}
                  <ProgressText>
                    {progress ? (
                      <>
                        {t(`novel.stage.${progress.stage}` as any)}... {Math.round(progress.percentage)}% ({progress.total ? `${progress.current}/${progress.total}` : progress.current})
                      </>
                    ) : (
                      <>正在处理中... 0%</>
                    )}
                  </ProgressText>
                  <Tabs
                    size="small"
                    defaultActiveKey={(progress && progress.stage === 'failed') ? 'chunks' : 'health'}
                    items={[
                      {
                        key: 'health',
                        label: '🏥 模型池健康度',
                        children: <ModelPoolHealthView modelHealthStats={modelHealthStats} />
                      },
                      {
                        key: 'chunks',
                        label: t('novel.result.details'),
                        children: <ChunkStatusView chunkSummaries={chunkSummaries} />
                      },
                      { key: 'logs', label: t('novel.section.logs'), children: <LogView logs={logs} /> }
                    ]}
                  />
                </>
              ) : (
                <Typography.Text type="secondary">
                  {t('novel.monitoring.placeholder')}
                </Typography.Text>
              )}
            </Flex>
          )
        },
        {
          key: 'settings',
          header: t('novel.section.settings'),
          content: <SettingsPanel state={state} actions={actions} modelFilter={modelFilter} />
        },
        {
          key: 'prompts',
          header: t('novel.section.prompts'),
          content: <PromptSettingsPanel state={state} actions={actions} />
        }
      ]
    }
    // 未处理：设置在前，监控在后
    return [
      {
        key: 'settings',
        header: t('novel.section.settings'),
        content: <SettingsPanel state={state} actions={actions} modelFilter={modelFilter} />
      },
      {
        key: 'prompts',
        header: t('novel.section.prompts'),
        content: <PromptSettingsPanel state={state} actions={actions} />
      },
      {
        key: 'monitoring',
        header: t('novel.section.monitoring'),
        content: (
          <Flex vertical gap={16}>
            {isProcessing || (progress && progress.stage === 'failed') ? (
              <>
                {isProcessing && <IndeterminateProgress />}
                <ProgressText>
                  {progress ? (
                    <>
                      {t(`novel.stage.${progress.stage}` as any)}... {Math.round(progress.percentage)}% ({progress.total ? `${progress.current}/${progress.total}` : progress.current})
                    </>
                  ) : (
                    <>正在处理中... 0%</>
                  )}
                </ProgressText>
                <Tabs
                  size="small"
                  defaultActiveKey={(progress && progress.stage === 'failed') ? 'chunks' : 'health'}
                  items={[
                    {
                      key: 'health',
                      label: '🏥 模型池健康度',
                      children: <ModelPoolHealthView modelHealthStats={modelHealthStats} />
                    },
                    {
                      key: 'chunks',
                      label: t('novel.result.details'),
                      children: <ChunkStatusView chunkSummaries={chunkSummaries} />
                    },
                    { key: 'logs', label: t('novel.section.logs'), children: <LogView logs={logs} /> }
                  ]}
                />
              </>
            ) : (
              <Typography.Text type="secondary">
                {t('novel.monitoring.placeholder')}
              </Typography.Text>
            )}
          </Flex>
        )
      }
    ]
  }, [isProcessing, progress, chunkSummaries, logs, modelHealthStats, result, state, actions, modelFilter, t])

  return (
    <>
      {!selectedFile ? (
        <FileDropzone onClick={actions.selectFile}>
          <DropzoneContent>
            <Upload size={48} strokeWidth={1.5} />
            <Typography.Text strong style={{ fontSize: 16 }}>
              {t('novel.placeholder')}
            </Typography.Text>
            <Typography.Text type="secondary">{t('novel.file.supported_formats')}</Typography.Text>
          </DropzoneContent>
        </FileDropzone>
      ) : (
        <FileInfoContainer>
          <Flex align="center" gap={12} style={{ flex: 1 }}>
            <FileText size={32} />
            <Flex vertical>
              <Typography.Text strong>{selectedFile.origin_name}</Typography.Text>
              <Typography.Text type="secondary">
                {t('novel.file.size', { size: formatFileSize(selectedFile.size) })} ·{' '}
                {t('novel.file.updated_at', {
                  time: dayjs(selectedFile.mtime).format('YYYY-MM-DD HH:mm')
                })}
              </Typography.Text>
            </Flex>
          </Flex>
          <Button
            icon={<XCircle size={16} />}
            onClick={actions.resetState}
            disabled={isProcessing}
          >
            {t('novel.actions.clear_file')}
          </Button>
        </FileInfoContainer>
      )}

      {selectedFile && (!result?.merged || progress?.stage === 'failed') && (
        <>
          {/* 失败状态提示 */}
          {progress?.stage === 'failed' && (
            <Flex
              vertical
              gap={8}
              style={{
                padding: '12px 16px',
                backgroundColor: '#fff2e8',
                border: '1px solid #ffbb96',
                borderRadius: '4px',
                width: '100%',
                maxWidth: '680px',
                marginBottom: '12px'
              }}
            >
              <Typography.Text strong style={{ color: '#d4380d' }}>
                ⚠️ 任务失败：部分分块未能生成
              </Typography.Text>
              <Typography.Text type="secondary">
                已成功处理 {progress.current}/{progress.total} 个分块。
                {state.continueLatestTask ? (
                  <>失败的分块已保存，请点击下方“重新开始”继续处理剩余分块（将自动跳过已完成分块）。</>
                ) : (
                  <>失败的分块已保存。建议开启“继续最近任务（目录续用）”后点击下方“重新开始”，以跳过已完成分块继续处理剩余分块。</>
                )}
              </Typography.Text>
              {chunkSummaries.filter(c => c.status === 'error').length > 0 && (
                <Typography.Text type="secondary">
                  失败分块编号：{chunkSummaries.filter(c => c.status === 'error').map(c => c.index + 1).join(', ')}
                </Typography.Text>
              )}
            </Flex>
          )}

          <ActionGroup>
            <StartButton
              type="primary"
              onClick={() => actions.startCompression()}
              loading={isProcessing}
              disabled={
                isProcessing ||
                !selectedFile ||
                (!enableMultiModel && !selectedModel) ||
                (enableMultiModel && selectedModels.length === 0)
              }
            >
              {progress?.stage === 'failed' ? '重新开始' : t('novel.actions.start')}
            </StartButton>
            {isProcessing && (
              <Button size="large" icon={<XCircle size={16} />} onClick={actions.cancelCompression}>
                {t('novel.actions.cancel')}
              </Button>
            )}
          </ActionGroup>
        </>
      )}

      <SettingsWrapper>
        <Collapse ghost key={collapseKey} defaultActiveKey={defaultActiveKeys}>
          {panelOrder.map(panel => (
            <Collapse.Panel header={panel.header} key={panel.key}>
              {panel.content}
            </Collapse.Panel>
          ))}
        </Collapse>
      </SettingsWrapper>
    </>
  )
}
// endregion

const NovelOutlinePage = () => {
  const { t } = useTranslation()
  const { state, actions } = useNovelOutline()
  const providers = useAppSelector((s) => s.llm.providers)
  const models = useMemo(() => providers.flatMap((p) => p.models), [providers])

  const modelFilter = useCallback((model: Model) => {
    return !isEmbeddingModel(model) && !isRerankModel(model) && !isTextToImageModel(model)
  }, [])

  // Set default model to fast-read-experience's deepseek-v3.1
  useEffect(() => {
    if (!state) return
    
    const deepseekModel = models.find(m => m.provider === 'fast-read-experience' && m.id === 'deepseek-v3.1')
    
    if (deepseekModel && !state.selectedModel) {
      actions.updateSettings({ selectedModel: deepseekModel })
    }
  }, [models, state, actions])

  // 监听失败自动重试触发事件
  useEffect(() => {
    if (!state) return

    const unsubscribe = window.api.novelOutline.onAutoResumeTriggered((data) => {
      console.log(`[失败自动重试] 收到第${data.attempt}次重试通知（最大${data.maxAttempts}次）`)

      setTimeout(() => {
        const currentState = state
        if (currentState && currentState.enableAutoResume && !currentState.isProcessing) {
          console.log(`[失败自动重试] 开始第${data.attempt}次重试...`)
          window.toast.info(`失败自动重试：第${data.attempt}次重试`)
          actions.startCompression(undefined, { autoRetry: true })
        }
      }, 3000)
    })

    return () => {
      unsubscribe()
    }
  }, [state, actions])

  if (!state) {
    return (
      <PageContainer>
        <Navbar>
          <NavbarCenter title={t('novelOutline.title')} />
        </Navbar>
        <Flex align="center" justify="center" style={{ flex: 1 }}>
          <Spin size="large" />
        </Flex>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('novelOutline.title')}</NavbarCenter>
      </Navbar>
      <MainContent>
        <CenterWrapper>
          <Header>
            <Title>{t('novelOutline.title')}</Title>
            <Subtitle>{t('novelOutline.subtitle')}</Subtitle>
          </Header>

          {state.result?.merged ? (
            <ResultView state={state} actions={actions} />
          ) : (
            <MainView
              state={state}
              actions={actions}
              modelFilter={modelFilter}
            />
          )}
        </CenterWrapper>
      </MainContent>
    </PageContainer>
  )
}

// region Styled Components
const PageContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  background: var(--color-background);
`

const MainContent = styled.div`
  flex: 1;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 20px;
  overflow: auto;
  min-height: 0;
`

const CenterWrapper = styled.div`
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 24px 0;
`

const Header = styled.div`
  text-align: center;
  margin-bottom: 24px;
`

const Title = styled.h1`
  font-size: 32px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
  letter-spacing: -0.5px;
`

const Subtitle = styled.div`
  font-size: 14px;
  color: var(--color-text-secondary);
  opacity: 0.6;
  margin-top: 8px;
  font-weight: 400;
`

const FileDropzone = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  border: 2px dashed var(--color-border);
  border-radius: 12px;
  background-color: var(--color-background-soft);
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
  width: 100%;
  max-width: 680px;

  &:hover {
    border-color: var(--color-primary);
    background-color: var(--color-background);
  }
`

const DropzoneContent = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-secondary);
`

const FileInfoContainer = styled(Flex)`
  align-items: center;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background-color: var(--color-background-soft);
  width: 100%;
  max-width: 680px;
`

const StartButton = styled(Button)`
  height: 40px;
  padding: 0 24px;
  border-radius: 8px;
  font-weight: 500;
  font-size: 16px;
  background: #10a37f;
  border-color: #10a37f;

  &:hover {
    background: #0f8567 !important;
    border-color: #0f8567 !important;
  }
`

const ActionGroup = styled.div`
  display: flex;
  gap: 12px;
  justify-content: center;
  width: 100%;
`

const SettingsWrapper = styled.div`
  width: 100%;
  max-width: 680px;
  margin-top: 16px;
  .ant-collapse {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 12px;
  }
  .ant-collapse-header {
    color: var(--color-text-secondary);
  }
`

const ProgressText = styled.div`
  text-align: center;
  margin-top: 8px;
  color: var(--color-text-secondary);
  font-size: 14px;
`

const ResultSection = styled.div`
  width: 100%;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 20px;
`

const DetailedStatsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
`

const StatCard = styled.div`
  background: var(--color-background-soft);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px 12px;
  text-align: center;
`

const StatNumber = styled.div`
  font-size: 20px;
  font-weight: 700;
  color: var(--color-primary);
  margin-bottom: 6px;
`

const StatLabel = styled.div`
  font-size: 14px;
  color: var(--color-text-secondary);
  font-weight: 500;
`

const ResultViewActions = styled.div`
  display: flex;
  justify-content: center;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
`

const ChunkList = styled.div`
  max-height: 400px;
  overflow-y: auto;
`

const LogContainer = styled.div`
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 12px;
  background: var(--color-background-soft);
`

const LogItem = styled.div`
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
  &:last-child {
    border-bottom: none;
  }
`
const TabsWrapper = styled.div`
  width: 100%;
  max-width: 900px;
  margin-top: 16px;
`
// endregion

export default NovelOutlinePage
