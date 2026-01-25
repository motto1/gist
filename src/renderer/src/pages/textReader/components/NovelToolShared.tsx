/**
 * 小说工具面板共用组件
 * 提取三个工具共同使用的 UI 组件，减少代码重复
 */

import { Button, Input, Progress, Select, SelectItem, Switch, Tooltip } from '@heroui/react'
import type { ReaderChapter } from '@shared/types'
import { Info } from 'lucide-react'
import { FC } from 'react'

// ==================== 进度显示组件 ====================
type ProgressSectionProps = {
  progress: { percentage: number; current: number; total: number } | null
}

export const ProgressSection: FC<ProgressSectionProps> = ({ progress }) => {
  if (!progress) return null

  return (
    <div className="flex flex-col gap-1 px-3 py-3 border-t border-divider">
      <Progress
        value={Math.round(progress.percentage)}
        size="sm"
        classNames={{ base: 'max-w-full' }}
      />
      <span className="text-xs text-default-500">
        {progress.current}/{progress.total} 分块
      </span>
    </div>
  )
}

// ==================== 操作按钮组件 ====================
type ActionButtonsProps = {
  isProcessing: boolean
  canStart: boolean
  startLabel: string
  processingLabel: string
  onStart: () => void
  onCancel: () => void
}

export const ActionButtons: FC<ActionButtonsProps> = ({
  isProcessing,
  canStart,
  startLabel,
  processingLabel,
  onStart,
  onCancel
}) => (
  <div className="flex flex-col gap-2 px-3 py-3 border-t border-divider">
    <Button
      color="primary"
      size="sm"
      onPress={onStart}
      isLoading={isProcessing}
      isDisabled={!canStart || isProcessing}
      fullWidth
    >
      {isProcessing ? processingLabel : startLabel}
    </Button>
    {isProcessing && (
      <Button size="sm" onPress={onCancel} fullWidth>
        取消
      </Button>
    )}
  </div>
)

// ==================== 高级设置组件 ====================
type AdvancedSettingsProps = {
  maxConcurrency: number
  continueLatestTask: boolean
  enableAutoResume: boolean
  showTemperature?: boolean
  temperature?: number
  onMaxConcurrencyChange: (value: number) => void
  onContinueLatestTaskChange: (value: boolean) => void
  onEnableAutoResumeChange: (value: boolean) => void
  onTemperatureChange?: (value: number) => void
}

export const AdvancedSettings: FC<AdvancedSettingsProps> = ({
  maxConcurrency,
  continueLatestTask,
  enableAutoResume,
  showTemperature = false,
  temperature = 0.7,
  onMaxConcurrencyChange,
  onContinueLatestTaskChange,
  onEnableAutoResumeChange,
  onTemperatureChange
}) => (
  <>
    <div className="h-px bg-divider my-1" />
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-default-500">高级设置</span>
    </div>

    {showTemperature && onTemperatureChange && (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm">温度</span>
        <Input
          type="number"
          size="sm"
          min={0}
          max={1.5}
          step={0.1}
          value={String(temperature)}
          onValueChange={(value) => onTemperatureChange(Number(value) || 0.7)}
          classNames={{ inputWrapper: 'h-8' }}
        />
      </div>
    )}

    <div className="flex flex-col gap-1.5">
      <span className="text-sm">并发数</span>
      <Input
        type="number"
        size="sm"
        min={1}
        max={50}
        value={String(maxConcurrency)}
        onValueChange={(value) => onMaxConcurrencyChange(Number(value) || 3)}
        classNames={{ inputWrapper: 'h-8' }}
      />
    </div>

    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">继续最近任务（目录续用）</span>
      <Switch size="sm" isSelected={continueLatestTask} onValueChange={onContinueLatestTaskChange} />
    </div>

    <div className="flex items-center justify-between gap-2">
      <span className="text-sm">失败自动重试</span>
      <Switch size="sm" isSelected={enableAutoResume} onValueChange={onEnableAutoResumeChange} />
    </div>
  </>
)

// ==================== 分块模式设置组件 ====================
type ChunkModeSettingsProps = {
  chunkMode: 'bySize' | 'byChapter'
  chunkSize: number
  overlap: number
  chaptersPerChunk: number
  chapters: ReaderChapter[]
  onChunkModeChange: (value: 'bySize' | 'byChapter') => void
  onChunkSizeChange: (value: number) => void
  onOverlapChange: (value: number) => void
  onChaptersPerChunkChange: (value: number) => void
  showModeSelect?: boolean
}

const estimateChunkCount = (totalChapters: number, chaptersPerChunk: number) => {
  const total = Number.isFinite(totalChapters) ? Math.max(0, totalChapters) : 0
  const per = Number.isFinite(chaptersPerChunk) ? Math.max(1, chaptersPerChunk) : 1
  if (total === 0) return 0
  return Math.ceil(total / per)
}

export const ChunkModeSettings: FC<ChunkModeSettingsProps> = ({
  chunkMode,
  chunkSize,
  overlap,
  chaptersPerChunk,
  chapters,
  onChunkModeChange,
  onChunkSizeChange,
  onOverlapChange,
  onChaptersPerChunkChange,
  showModeSelect = true
}) => (
  <>
    {showModeSelect && (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <span className="text-sm">分块模式</span>
            <Tooltip content="按字数分块或按章节分块">
              <Info size={12} className="cursor-help" />
            </Tooltip>
          </div>
        </div>
        <Select
          size="sm"
          selectedKeys={[chunkMode]}
          onSelectionChange={(keys) => {
            const value = Array.from(keys)[0] as 'bySize' | 'byChapter'
            onChunkModeChange(value)
          }}
          classNames={{ trigger: 'h-8' }}
        >
          <SelectItem key="bySize">按字数分块</SelectItem>
          <SelectItem key="byChapter">按章节分块</SelectItem>
        </Select>
      </div>
    )}

    {chunkMode === 'bySize' && (
      <>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm">分块大小</span>
          <Input
            type="number"
            size="sm"
            min={600}
            step={200}
            value={String(chunkSize)}
            onValueChange={(value) => onChunkSizeChange(Number(value) || 2000)}
            classNames={{ inputWrapper: 'h-8' }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm">重叠字数</span>
          <Input
            type="number"
            size="sm"
            min={0}
            max={chunkSize - 1}
            step={50}
            value={String(overlap)}
            onValueChange={(value) => onOverlapChange(Number(value) || 0)}
            classNames={{ inputWrapper: 'h-8' }}
          />
        </div>
      </>
    )}

    {chunkMode === 'byChapter' && (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-default-500">
          将使用阅读器识别的 {chapters.length} 个章节进行分块
        </span>
        <div className="flex items-center justify-between gap-2 mt-2">
          <span className="text-sm">每块章节数</span>
          <Input
            type="number"
            size="sm"
            min={1}
            max={chapters.length || 10}
            value={String(chaptersPerChunk)}
            onValueChange={(value) => onChaptersPerChunkChange(Number(value) || 3)}
            className="w-20"
            classNames={{ inputWrapper: 'h-8' }}
          />
        </div>
        <span className="text-xs text-default-500 mt-1.5">
          预计分块数：{estimateChunkCount(chapters.length, chaptersPerChunk)} 块
        </span>
      </div>
    )}
  </>
)

// ==================== 工具头部组件 ====================
type ToolHeaderProps = {
  title: string
  description: string
}

export const ToolHeader: FC<ToolHeaderProps> = ({ title, description }) => (
  <div className="flex flex-col gap-0.5 px-3 py-3 border-b border-divider">
    <span className="font-semibold text-sm">{title}</span>
    <span className="text-xs text-default-500">{description}</span>
  </div>
)

// ==================== 空状态提示组件 ====================
type EmptyStateProps = {
  message: string
}

export const EmptyState: FC<EmptyStateProps> = ({ message }) => (
  <div className="flex flex-col items-center justify-center h-[200px] px-3">
    <span className="text-sm text-default-500">{message}</span>
  </div>
)
