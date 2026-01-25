import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { CharacterInput } from '@renderer/components/CharacterInput'
import { IndeterminateProgress } from '@renderer/components/IndeterminateProgress'
import ModelSelectButton from '@renderer/components/ModelSelectButton'
import SelectModelPopup from '@renderer/components/Popups/SelectModelPopup'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import { useNovelCharacter } from '@renderer/hooks/useNovelCharacter'
import { useAppSelector } from '@renderer/store'
import type {
  CompressionUsageMetrics,
  Model,
  NovelCompressionState
} from '@shared/types'
import type { TabsProps } from 'antd'
import {
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Flex,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import TextArea from 'antd/es/input/TextArea'
import dayjs from 'dayjs'
import { FileText, Info,Minus, Plus, Save, Upload, XCircle } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactJson from 'react-json-view'
import styled from 'styled-components'

// 这些函数已经移动到 CharacterInput 组件中，不再需要在这里定义

const chunkStatusColor: Record<NovelCompressionState['chunkSummaries'][number]['status'], string> = {
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

const LogView: React.FC<{ logs: NovelCompressionState['logs'] }> = ({ logs }) => {
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

const ModelPoolHealthView: React.FC<{ modelHealthStats: NovelCompressionState['modelHealthStats'] }> = ({
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

const ChunkStatusView: React.FC<{ chunkSummaries: NovelCompressionState['chunkSummaries'] }> = ({
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

// CharacterPlotViewer 组件已废弃 - 该组件体积过大（约900行），已从页面中移除
// 如需恢复，请参考 git 历史记录

interface SettingsPanelProps {
  state: NovelCompressionState
  actions: ReturnType<typeof useNovelCharacter>['actions']
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
    characterOutputFormat = 'csv',
    continueLatestTask,
    enableAutoResume
  } = state

  // 这些状态变量已经不再需要，因为使用了新的 CharacterInput 组件

  const handleUpdateOptions = useCallback(
    (settings: Partial<NovelCompressionState>) => actions.updateSettings(settings),
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
      {/* 输出格式选择 */}
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text strong>{t('novelCharacter.matrix.outputFormat')}</Typography.Text>
        <Select
          value={characterOutputFormat}
          onChange={(value) => handleUpdateOptions({ characterOutputFormat: value })}
          style={{ width: '100%' }}
          options={[
            { value: 'csv', label: 'CSV (.csv) - 推荐' },
            { value: 'markdown', label: 'Markdown (.md)' },
            { value: 'html', label: 'HTML (.html)' }
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: '12px' }}>
          选择矩阵导出格式（JSON文件会自动生成，用于人物剧情查看器）
        </Typography.Text>
      </Space>

      {/* 指定人物配置 */}
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex justify="space-between" align="center">
          <Typography.Text>
            🎭 指定人物模式
            <Tooltip title="开启后只生成指定人物的剧情，否则自动识别所有角色">
              <Info size={14} style={{ marginLeft: 4, color: '#1890ff' }} />
            </Tooltip>
          </Typography.Text>
          <Switch
            checked={state.targetCharacterConfig?.enabled || false}
            onChange={(checked) => handleUpdateOptions({ 
              targetCharacterConfig: { 
                enabled: checked, 
                characters: state.targetCharacterConfig?.characters || [] 
              } 
            })}
          />
        </Flex>

        {state.targetCharacterConfig?.enabled && (
          <>
            <CharacterInput
              value={state.targetCharacterConfig?.characters || []}
              onChange={(characters) => handleUpdateOptions({
                targetCharacterConfig: {
                  enabled: true,
                  characters
                }
              })}
              placeholder="输入人物名称，按回车添加（支持别名：张三(小张)）"
              maxCharacters={20}
              showQuickAdd={true}
              suggestions={[
                '主角', '男主', '女主', '反派', '配角',
                '师父', '师兄', '师姐', '师弟', '师妹',
                '父亲', '母亲', '兄长', '姐姐', '弟弟', '妹妹',
                '朋友', '敌人', '盟友', '导师', '弟子',
                '皇帝', '皇后', '太子', '公主', '将军',
                '丞相', '大臣', '侍卫', '宫女', '太监'
              ]}
            />
            <Typography.Text type="warning" style={{ fontSize: '12px' }}>
              💡 提示：AI将只分析这些人物的剧情，其他角色将被忽略
            </Typography.Text>
          </>
        )}
      </Space>

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

      {/* 分块模式选择 - 任务 8.1 */}
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Flex justify="space-between" align="center">
          <Typography.Text>
            📚 分块模式
            <Tooltip title="按字数分块：固定字数切分；按章节分块：自动识别章节标题进行切分">
              <Info size={14} style={{ marginLeft: 4, color: '#1890ff' }} />
            </Tooltip>
          </Typography.Text>
        </Flex>
        <Select
          value={state.chunkMode || 'bySize'}
          onChange={(value) => actions.setChunkMode(value as 'bySize' | 'byChapter')}
          style={{ width: '100%' }}
          options={[
            { value: 'bySize', label: '📏 按字数分块' },
            { value: 'byChapter', label: '📖 按章节分块' }
          ]}
        />
        
        {/* 章节模式设置 - 任务 8.2 */}
        {state.chunkMode === 'byChapter' && (
          <Card size="small" style={{ marginTop: 8 }}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {state.chapterParseResult?.success ? (
                <>
                  <Flex justify="space-between" align="center">
                    <Typography.Text type="success">
                      ✅ 识别到 {state.chapterParseResult.totalChapters} 个章节
                    </Typography.Text>
                    <Tag color="blue">{state.chapterParseResult.usedRule}</Tag>
                  </Flex>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Typography.Text>每块章节数</Typography.Text>
                    <InputNumber
                      min={1}
                      max={Math.max(1, state.chapterParseResult.totalChapters)}
                      step={1}
                      value={state.chaptersPerChunk || 3}
                      onChange={(value) => actions.setChaptersPerChunk(typeof value === 'number' ? value : 3)}
                      style={{ width: '100%' }}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: '12px' }}>
                      预计分块数：{Math.ceil((state.chapterParseResult?.totalChapters || 0) / (state.chaptersPerChunk || 3))} 块
                    </Typography.Text>
                  </Space>
                </>
              ) : state.chapterParseResult?.error ? (
                <Typography.Text type="danger">
                  ❌ {state.chapterParseResult.error}
                </Typography.Text>
              ) : state.selectedFile ? (
                <Flex align="center" gap={8}>
                  <Spin size="small" />
                  <Typography.Text type="secondary">正在解析章节...</Typography.Text>
                </Flex>
              ) : (
                <Typography.Text type="secondary">
                  请先选择文件以解析章节
                </Typography.Text>
              )}
            </Space>
          </Card>
        )}
      </Space>

      {/* 按字数分块设置 - 任务 8.3 */}
      {(state.chunkMode || 'bySize') === 'bySize' && (
        <>
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
        </>
      )}

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

interface ResultViewProps {
  state: NovelCompressionState
  actions: ReturnType<typeof useNovelCharacter>['actions']
}

const ResultView: React.FC<ResultViewProps> = ({ state, actions }) => {
  const { t } = useTranslation()
  const theme = useAppSelector((s) => s.settings.theme)
  const { selectedFile, result, chunkSummaries, logs, debugInfo, outputPath } = state
  const totalLength =
    state.inputText?.length ?? state.selectedFile?.charLength ?? state.selectedFile?.size ?? 0
  const finalLength = result?.merged.length ?? 0

  const handleCopyResult = useCallback(async () => {
    if (!result?.merged) return
    try {
      await navigator.clipboard.writeText(result.merged)
      window.toast.success(t('novel.actions.copy_success'))
    } catch {
      window.toast.error(t('novel.error.copy_failed'))
    }
  }, [result?.merged, t])

  const handleSaveResult = useCallback(async () => {
    if (!result?.merged) return
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
      const suggested = `${baseName}.compressed.txt`
      await window.api.file.save(suggested, result.merged)
      window.toast.success(t('novel.actions.save_success'))
    } catch (error: any) {
      window.toast.error(t('novel.error.save_failed', { message: error?.message ?? '' }))
    }
  }, [result?.merged, selectedFile, t])

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
    
    // 如果有角色人物志，为每个角色添加独立标签页
    if (result?.characterProfiles && Object.keys(result.characterProfiles).length > 0) {
      Object.entries(result.characterProfiles).forEach(([character, profile]) => {
        // 安全检查：确保角色名和内容都有效
        if (!character || typeof character !== 'string' || !profile || typeof profile !== 'string') {
          console.warn('Invalid character profile', { character, hasProfile: !!profile })
          return
        }
        
        // 生成安全的key（避免特殊字符）
        const safeKey = `character-${encodeURIComponent(character)}`
        
        items.push({
          key: safeKey,
          label: `👤 ${character}`,
          children: (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                {character} 的人物志
              </Typography.Text>
              <FullResultTextArea
                value={profile || ''}
                readOnly
                autoSize={{ minRows: 10 }}
                placeholder={t('novel.result.placeholder')}
              />
              <Space>
                <Button
                  icon={<Save size={16} />}
                  onClick={async () => {
                    try {
                      // 文件名安全处理：移除非法字符
                      const safeFileName = character.replace(/[<>:"/\\|?*]/g, '_')
                      await window.api.file.save(`${safeFileName}-人物志.txt`, profile)
                      window.toast.success(t('novel.actions.save_success'))
                    } catch (error: any) {
                      window.toast.error(t('novel.error.save_failed', { message: error?.message ?? '' }))
                    }
                  }}
                >
                  {t('novel.actions.save')}
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(profile)
                      window.toast.success(t('novel.actions.copy_success'))
                    } catch {
                      window.toast.error(t('novel.error.copy_failed'))
                    }
                  }}
                >
                  {t('novel.actions.copy')}
                </Button>
              </Space>
            </Space>
          )
        })
      })
    }

    items.push(
      {
        key: 'chunks',
        label: t('novel.result.details'),
        children:
          chunkItems ?? <Typography.Text type="secondary">{t('novel.debug.placeholder')}</Typography.Text>
      },
      { key: 'logs', label: t('novel.section.logs'), children: logList },
      {
        key: 'debug',
        label: t('novel.section.debug'),
        children: debugInfo ? (
          <ReactJson
            src={debugInfo}
            name={false}
            collapsed={2}
            displayDataTypes={false}
            enableClipboard={false}
            theme={theme === 'dark' ? 'monokai' : 'rjv-default'}
          />
        ) : (
          <Typography.Text type="secondary">{t('novel.debug.placeholder')}</Typography.Text>
        )
      }
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
    debugInfo,
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
  state: NovelCompressionState
  actions: ReturnType<typeof useNovelCharacter>['actions']
  modelFilter: (model: Model) => boolean
  confirmModalVisible: boolean
  setConfirmModalVisible: (visible: boolean) => void
  pendingTargetCharacters: string[]
  setPendingTargetCharacters: (characters: string[]) => void
}

const MainView: React.FC<MainViewProps> = ({
  state,
  actions,
  modelFilter,
  confirmModalVisible,
  setConfirmModalVisible,
  pendingTargetCharacters,
  setPendingTargetCharacters
}) => {
  // Mark as used (these are used in JSX below)
  void confirmModalVisible
  void pendingTargetCharacters

  const { t } = useTranslation()
  const {
    selectedFile,
    isProcessing,
    progress,
    canResume,
    chunkInfo: chunkDetectionResult,
    selectedModel,
    selectedModels,
    enableMultiModel,
    result,
    logs,
    chunkSummaries,
    mergedContent,
    modelHealthStats
  } = state

  // 使用 ref 跟踪上一次的处理状态
  const prevIsProcessingRef = React.useRef(isProcessing)
  const [collapseKey, setCollapseKey] = React.useState(0) // 用于强制重新渲染 Collapse

  // 当处理状态改变时，强制重置 Collapse 组件
  React.useEffect(() => {
    if (prevIsProcessingRef.current !== isProcessing) {
      prevIsProcessingRef.current = isProcessing
      setCollapseKey(prev => prev + 1) // 改变 key 强制重新挂载
    }
  }, [isProcessing])

  // 根据处理状态动态设置默认展开的面板
  const defaultActiveKeys = useMemo(() => {
    if (isProcessing || (progress && progress.stage === 'failed')) {
      // 处理中或失败：只展开监控面板
      return ['monitoring']
    }
    // 未处理：展开设置和查看器
    return ['settings', 'character-viewer']
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
            </Flex>
          )
        },
        {
          key: 'settings',
          header: t('novel.section.settings'),
          content: <SettingsPanel state={state} actions={actions} modelFilter={modelFilter} />
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
  }, [isProcessing, progress, mergedContent, chunkSummaries, logs, modelHealthStats, result, state, actions, modelFilter, t])

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
              onClick={() => {
                // 检查是否启用了指定人物模式
                if (state.targetCharacterConfig?.enabled && state.targetCharacterConfig.characters.length > 0) {
                  // 显示确认弹窗
                  setPendingTargetCharacters(state.targetCharacterConfig.characters)
                  setConfirmModalVisible(true)
                } else {
                  // 未启用指定人物模式，直接开始
                  actions.startCompression()
                }
              }}
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
            {canResume && (
              <Button size="large" onClick={() => actions.startCompression()} disabled={isProcessing}>
                {chunkDetectionResult && chunkDetectionResult.hasChunks
                  ? chunkDetectionResult.missingChunks.length > 0
                    ? t('novel.actions.resume_missing', {
                        count: chunkDetectionResult.missingChunks.length
                      })
                    : t('novel.actions.merge_chunks', { count: chunkDetectionResult.chunkCount })
                  : t('novel.actions.resume_smart')}
              </Button>
            )}
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

const NovelCharacterPage = () => {
  const { t } = useTranslation()
  const { state, actions } = useNovelCharacter()
  const providers = useAppSelector((s) => s.llm.providers)
  const models = useMemo(() => providers.flatMap((p) => p.models), [providers])

  // 指定人物确认弹窗状态
  const [confirmModalVisible, setConfirmModalVisible] = useState(false)
  const [pendingTargetCharacters, setPendingTargetCharacters] = useState<string[]>([])

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
    const unsubscribe = window.api.novelCharacter.onAutoResumeTriggered((data) => {
      console.log(`[失败自动重试] 收到第${data.attempt}次重试通知（最大${data.maxAttempts}次）`)
      
      // 等待3秒后自动点击续传按钮
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
          <NavbarCenter title={t('novelCharacter.title')} />
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
        <NavbarCenter style={{ borderRight: 'none' }}>{t('novelCharacter.title')}</NavbarCenter>
      </Navbar>
      <MainContent>
        <CenterWrapper>
          <Header>
            <Title>{t('novelCharacter.title')}</Title>
            <Subtitle>{t('novelCharacter.subtitle')}</Subtitle>
          </Header>

          {state.result?.merged ? (
            <ResultView state={state} actions={actions} />
          ) : (
            <MainView
              state={state}
              actions={actions}
              modelFilter={modelFilter}
              confirmModalVisible={confirmModalVisible}
              setConfirmModalVisible={setConfirmModalVisible}
              pendingTargetCharacters={pendingTargetCharacters}
              setPendingTargetCharacters={setPendingTargetCharacters}
            />
          )}
        </CenterWrapper>
      </MainContent>

      {/* 指定人物确认弹窗 */}
      <Modal
        open={confirmModalVisible}
        onCancel={() => setConfirmModalVisible(false)}
        onOk={() => {
          setConfirmModalVisible(false)
          actions.startCompression()
        }}
        title="🎭 确认指定人物"
        okText="确认开始"
        cancelText="取消"
        width={500}
      >
        <div>
          <p>将只分析以下 <strong>{pendingTargetCharacters.length}</strong> 个人物：</p>
          <ul style={{ 
            maxHeight: '300px', 
            overflowY: 'auto', 
            paddingLeft: '20px',
            margin: '10px 0'
          }}>
            {pendingTargetCharacters.map((char, index) => (
              <li key={index}><strong>{char}</strong></li>
            ))}
          </ul>
          <p style={{ color: '#ff4d4f', fontSize: '14px', marginTop: '16px' }}>
            ⚠️ 其他角色将被完全忽略，确认继续吗？
          </p>
        </div>
      </Modal>
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

const FullResultTextArea = styled(TextArea)`
  width: 100%;
  border: 1px solid var(--color-border) !important;
  border-radius: 12px !important;
  background: var(--color-background) !important;
  padding: 20px !important;
  font-size: 14px;
  line-height: 1.6;
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

export default NovelCharacterPage
