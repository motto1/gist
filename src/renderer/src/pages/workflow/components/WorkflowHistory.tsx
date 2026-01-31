import { Accordion, AccordionItem, Button, Chip } from '@heroui/react'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { modalConfirm } from '@renderer/utils'
import { clearActiveSession, completeSession, updateSessionOutputDir, WorkflowSession, WorkflowType } from '@renderer/store/workflow'
import { BookOpen, ChevronRight, Clock, FileText, FolderOpen, RefreshCw, Trash2, Users, X } from 'lucide-react'
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

const WORKFLOW_CONFIG: Record<WorkflowType, { icon: typeof BookOpen; color: string; route: string }> = {
  'speed-read': { icon: BookOpen, color: 'primary', route: '/workflow/speed-read' },
  'character': { icon: Users, color: 'secondary', route: '/workflow/character' },
  'outline': { icon: FileText, color: 'success', route: '/workflow/outline' }
}

const formatDate = (iso: string) => {
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  } catch {
    return iso
  }
}

interface HistoryRowProps {
  session: WorkflowSession
  onOpenDir?: () => void
  onDelete?: () => void
  onViewResult?: () => void
}

/**
 * 单行历史记录项 - 紧凑的一行布局
 */
const HistoryRow: FC<HistoryRowProps> = ({ session, onOpenDir, onDelete, onViewResult }) => {
  const { t } = useTranslation()
  const config = WORKFLOW_CONFIG[session.type]
  const Icon = config.icon

  const workflowLabel = useMemo(() => {
    switch (session.type) {
      case 'speed-read':
        return t('workflow.speedRead.title', '速读')
      case 'character':
        return t('workflow.character.title', '人物志')
      case 'outline':
        return t('workflow.outline.title', '大纲')
      default:
        return session.type
    }
  }, [session.type, t])

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-foreground/5 transition-colors cursor-pointer group"
      onClick={onViewResult}
    >
      {/* Icon */}
      <div
        className="p-1.5 rounded-md flex-shrink-0"
        style={{ background: `hsl(var(--heroui-${config.color}) / 0.15)` }}
      >
        <Icon size={14} className={`text-${config.color}`} />
      </div>

      {/* Type chip */}
      <Chip
        size="sm"
        variant="flat"
        color={config.color as 'primary' | 'secondary' | 'success'}
        className="flex-shrink-0 min-w-[52px] text-center"
      >
        {workflowLabel}
      </Chip>

      {/* Book title + character label (character workflow only) */}
      <div className="flex-1 min-w-0 flex items-center gap-2" title={session.bookTitle}>
        <span className="text-sm truncate text-foreground/80">{session.bookTitle}</span>
        {session.type === 'character' && session.ttsCharacterLabel ? (
          <Chip
            size="sm"
            variant="flat"
            className="flex-shrink-0 max-w-[120px] truncate"
            title={session.ttsCharacterLabel}
          >
            {session.ttsCharacterLabel}
          </Chip>
        ) : null}
      </div>

      {/* Time */}
      <span className="flex items-center gap-1 text-xs text-foreground/40 flex-shrink-0">
        <Clock size={12} />
        {formatDate(session.completedAt || session.startedAt)}
      </span>

      {/* Model name */}
      {session.modelName && (
        <span className="text-xs text-foreground/40 flex-shrink-0 max-w-[100px] truncate hidden sm:block">
          {session.modelName}
        </span>
      )}

      {/* Open folder button */}
      {session.outputDir && onOpenDir && (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation()
          }}
          onPress={() => {
            onOpenDir()
          }}
          title={t('workflow.complete.openTaskDir', '打开任务目录')}
        >
          <FolderOpen size={14} />
        </Button>
      )}

      {/* Delete button */}
      {session.outputDir && onDelete && (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          color="danger"
          className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation()
          }}
          onPress={() => {
            onDelete()
          }}
          title={t('workflow.history.delete', '删除')}
        >
          <Trash2 size={14} />
        </Button>
      )}

      {/* Arrow indicator */}
      <ChevronRight size={14} className="text-foreground/30 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  )
}

interface ActiveSessionRowProps {
  type: WorkflowType
  session: WorkflowSession
  onContinue: () => void
  onCancel: () => void
}

/**
 * 进行中的任务行
 */
const ActiveSessionRow: FC<ActiveSessionRowProps> = ({ type, session, onContinue, onCancel }) => {
  const { t } = useTranslation()
  const config = WORKFLOW_CONFIG[type]
  const Icon = config.icon

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-warning/10 border border-warning/20 hover:bg-warning/15 transition-colors cursor-pointer"
      onClick={onContinue}
    >
      {/* Pulsing icon */}
      <div className="p-1.5 rounded-md bg-warning/20 flex-shrink-0">
        <Icon size={14} className="text-warning" />
      </div>

      {/* Status indicator */}
      <span className="w-2 h-2 rounded-full bg-warning animate-pulse flex-shrink-0" />

      {/* Book title */}
      <span className="flex-1 text-sm font-medium truncate" title={session.bookTitle}>
        {session.bookTitle}
      </span>

      {/* Progress */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <Chip size="sm" variant="flat" color="warning">
          {session.progress?.stage || t('workflow.status.processing', '处理中')}
        </Chip>
        {session.progress?.percentage !== undefined && (
          <span className="text-xs text-foreground/60 min-w-[36px] text-right">
            {Math.round(session.progress.percentage)}%
          </span>
        )}
      </div>

      {/* Cancel button */}
      <Button
        isIconOnly
        size="sm"
        variant="light"
        color="danger"
        className="flex-shrink-0"
        onClick={(e) => {
          e.stopPropagation()
        }}
        onPress={() => onCancel()}
        title={t('workflow.processing.cancel', '取消任务')}
      >
        <X size={14} />
      </Button>

      {/* Continue button */}
      <Button
        size="sm"
        color="warning"
        variant="flat"
        className="flex-shrink-0"
        onClick={(e) => {
          e.stopPropagation()
        }}
        onPress={onContinue}
      >
        {t('workflow.history.continue', '继续')}
      </Button>
    </div>
  )
}

interface WorkflowHistoryProps {
  maxItems?: number
  showEmpty?: boolean
}

const WorkflowHistory: FC<WorkflowHistoryProps> = ({ maxItems = 10, showEmpty = true }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const activeSessions = useAppSelector((state) => state.workflow.activeSessions)

  const handleCancelSession = useCallback(
    async (type: WorkflowType) => {
      const ok = await modalConfirm({
        title: t('workflow.processing.cancel', '取消任务'),
        content: t(
          'workflow.processing.cancelConfirm',
          '取消后将丢弃该任务的所有进度（不会删除已写入磁盘的文件）。确定要取消吗？'
        ),
        okType: 'danger',
        okText: t('common.confirm', '确认'),
        cancelText: t('common.cancel', '取消')
      })

      if (!ok) return

      try {
        if (type === 'speed-read') {
          window.api.novelCompress.cancel()
          window.api.novelCompress.resetState()
        } else if (type === 'outline') {
          window.api.novelOutline.cancel()
          window.api.novelOutline.resetState()
        } else if (type === 'character') {
          window.api.novelCharacter.cancel()
          window.api.novelCharacter.resetState()
        }
      } finally {
        dispatch(clearActiveSession(type))
        window.toast?.success?.(t('workflow.processing.canceled', '已取消任务'))
      }
    },
    [dispatch, t]
  )

  // History is derived from filesystem output, not Redux cache.
  const [fileHistory, setFileHistory] = useState<WorkflowSession[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(true)
  const [isReloading, setIsReloading] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)

  useEffect(() => {
    let isMounted = true

    const loadHistoryFromDisk = async () => {
      setIsLoadingHistory(true)
      try {
        const textBooksDir = (await window.api.textBooks.getTextBooksDir()) as string
        type FsEntry = {
          name: string
          path: string
          isDirectory: boolean
          isFile: boolean
          mtimeMs: number
          size: number
        }

        const bookDirs = ((await window.api.fs.readdir(textBooksDir)) as FsEntry[]).filter((e) => e.isDirectory)

        type DiskHistoryEntry = WorkflowSession & { _mtimeMs: number }
        const results: DiskHistoryEntry[] = []

        const tryReadDir = async (dirPath: string): Promise<FsEntry[] | null> => {
          try {
            return (await window.api.fs.readdir(dirPath)) as FsEntry[]
          } catch {
            return null
          }
        }

        const getCharacterTtsLabelFromAudioEntries = (audioEntries: FsEntry[] | null): string | undefined => {
          if (!audioEntries || audioEntries.length === 0) return undefined

          const files = audioEntries
            .filter((e) => {
              const name = e.name?.toLowerCase()
              return e.isFile && (name?.endsWith('.mp3') || name?.endsWith('.wav'))
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)

          const stems: string[] = []
          const seen = new Set<string>()

          for (const f of files) {
            const raw = (f.name || '').replace(/\.(mp3|wav)$/i, '')
            const stem = raw.replace(/_(bio|monologue)$/i, '').trim()
            if (!stem) continue
            if (seen.has(stem)) continue
            seen.add(stem)
            stems.push(stem)
          }

          if (stems.length === 0) return undefined
          if (stems.length === 1) return stems[0]
          return `${stems[0]}等`
        }

        const pickLatestResultsFile = async (dirPath: string, priorities: string[]): Promise<string | null> => {
          const entries = await tryReadDir(dirPath)
          if (!entries) return null
          const files = entries.filter((e) => e.isFile)

          const byName = new Map(files.map((f) => [f.name?.toLowerCase(), f.path] as const))
          for (const p of priorities) {
            const hit = byName.get(p.toLowerCase())
            if (hit) return hit
          }

          const md = files.find((f) => f.name?.toLowerCase().endsWith('.md'))
          if (md) return md.path
          const txt = files.find((f) => f.name?.toLowerCase().endsWith('.txt'))
          if (txt) return txt.path
          const json = files.find((f) => f.name?.toLowerCase().endsWith('.json'))
          if (json) return json.path
          return files[0]?.path ?? null
        }

        for (const bookDir of bookDirs) {
          const bookTitle = bookDir.name || '未命名'
          const bookPath = bookDir.path
          const bookId = bookDir.name || bookDir.path

          // speed-read: {book}/compression/{base}_chunks_{timestamp}/compressed.txt
          const compressionDir = await window.api.path.join(bookDir.path, 'compression')
          const compressionEntries = await tryReadDir(compressionDir)
          if (compressionEntries) {
            const candidates = compressionEntries
              .filter((e) => e.isDirectory && (e.name?.includes('_chunks') || e.name?.endsWith('_chunks') || e.name?.includes('chunks')))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)

            for (const dir of candidates) {
              const resultFile = await pickLatestResultsFile(dir.path, ['compressed.txt'])
              if (!resultFile) continue
              results.push({
                id: dir.path,
                type: 'speed-read',
                status: 'complete',
                bookId,
                bookTitle,
                bookPath,
                outputDir: dir.path,
                resultFilePath: resultFile,
                startedAt: new Date(dir.mtimeMs).toISOString(),
                completedAt: new Date(dir.mtimeMs).toISOString(),
                _mtimeMs: dir.mtimeMs
              })
            }
          }

          // character: {book}/character/{base}_人物志结果_{timestamp}/最终结果/*
          const characterDir = await window.api.path.join(bookDir.path, 'character')
          const characterEntries = await tryReadDir(characterDir)
          if (characterEntries) {
            const candidates = characterEntries
              .filter((e) => e.isDirectory && (e.name?.includes('人物志结果') || e.name?.includes('character')))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)

            for (const dir of candidates) {
              // 新流程以音频落盘为完成标志：没有 audio/*.mp3|*.wav 的任务不进入“已完成”历史列表
              const audioDir = await window.api.path.join(dir.path, 'audio')
              const audioEntries = await tryReadDir(audioDir)
              const hasAudio = !!audioEntries?.some((e) => {
                const name = e.name?.toLowerCase()
                return e.isFile && (name?.endsWith('.mp3') || name?.endsWith('.wav'))
              })
              if (!hasAudio) continue

              const finalResultsDir = await window.api.path.join(dir.path, '最终结果')
              const resultFile = await pickLatestResultsFile(finalResultsDir, ['latest.md', 'latest.txt', 'latest.json'])
              if (!resultFile) continue
              const ttsCharacterLabel = getCharacterTtsLabelFromAudioEntries(audioEntries)
              results.push({
                id: dir.path,
                type: 'character',
                status: 'complete',
                bookId,
                bookTitle,
                bookPath,
                outputDir: dir.path,
                resultFilePath: resultFile,
                ttsCharacterLabel,
                startedAt: new Date(dir.mtimeMs).toISOString(),
                completedAt: new Date(dir.mtimeMs).toISOString(),
                _mtimeMs: dir.mtimeMs
              })
            }
          }

          // outline: {book}/outline/novel_outline_{hash}_{timestamp}/merged_outline.md
          const outlineDir = await window.api.path.join(bookDir.path, 'outline')
          const outlineEntries = await tryReadDir(outlineDir)
          if (outlineEntries) {
            const candidates = outlineEntries
              .filter((e) => e.isDirectory && e.name?.startsWith('novel_outline_') && /_\d{13}/.test(e.name))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)

            for (const dir of candidates) {
              const resultFile = await pickLatestResultsFile(dir.path, ['merged_outline.md', 'final.md'])
              if (!resultFile) continue
              results.push({
                id: dir.path,
                type: 'outline',
                status: 'complete',
                bookId,
                bookTitle,
                bookPath,
                outputDir: dir.path,
                resultFilePath: resultFile,
                startedAt: new Date(dir.mtimeMs).toISOString(),
                completedAt: new Date(dir.mtimeMs).toISOString(),
                _mtimeMs: dir.mtimeMs
              })
            }
          }
        }

        const sorted = results.sort((a, b) => b._mtimeMs - a._mtimeMs).slice(0, maxItems)
        const cleaned = sorted.map(({ _mtimeMs, ...rest }) => rest)
        if (!isMounted) return
        setFileHistory(cleaned)
      } finally {
        if (!isMounted) return
        setIsLoadingHistory(false)
        setIsReloading(false)
      }
    }

    loadHistoryFromDisk()

    return () => {
      isMounted = false
    }
  }, [maxItems, reloadSeq])

  // Check for any active/processing sessions
  const activeSessionsList = useMemo(() => {
    return Object.entries(activeSessions)
      .filter(([, session]) => session !== null)
      .map(([type, session]) => ({ type: type as WorkflowType, session: session! }))
  }, [activeSessions])

  // Track which sessions we've already tried to complete (prevent duplicate attempts)
  const completedSessionsRef = useRef<Set<string>>(new Set())

  // Subscribe to main process state to detect and complete stuck tasks
  // This handles the case where user navigates away before task completes
  useEffect(() => {
    if (activeSessionsList.length === 0) return

    const checkAndCompleteStuckTasks = async () => {
      const resolveDir = async (maybePath?: string): Promise<string | null> => {
        if (!maybePath) return null
        const looksLikeFile = /\.[a-z0-9]+$/i.test(maybePath)
        return looksLikeFile ? await window.api.path.dirname(maybePath) : maybePath
      }

      const hasAnyAudio = async (taskDir: string): Promise<boolean> => {
        try {
          const audioDir = await window.api.path.join(taskDir, 'audio')
          const entries = (await window.api.fs.readdir(audioDir)) as Array<{ name?: string; isFile?: boolean }>
          return entries.some((e) => {
            const name = e.name?.toLowerCase()
            return e.isFile && (name?.endsWith('.mp3') || name?.endsWith('.wav'))
          })
        } catch {
          return false
        }
      }

      for (const { type, session } of activeSessionsList) {
        // Skip if we've already attempted to complete this session
        if (completedSessionsRef.current.has(session.id)) continue

        try {
          let mainState:
            | { isProcessing?: boolean; progress?: { stage: string; percentage: number } | null; outputPath?: string }
            | null = null

          // Get main process state based on workflow type
          if (type === 'speed-read') {
            mainState = await window.api.novelCompress.getState()
          } else if (type === 'character') {
            mainState = await window.api.novelCharacter.getState()
          } else if (type === 'outline') {
            mainState = await window.api.novelOutline.getState()
          }

          if (!mainState) continue

          // Use actual outputPath from main process if available (normalize to directory)
          const actualOutputDir = await resolveDir(mainState.outputPath || session.outputDir)
          if (actualOutputDir && actualOutputDir !== session.outputDir) {
            dispatch(updateSessionOutputDir({ type, outputDir: actualOutputDir }))
          }

          // Character workflow: 音频落盘才算完成（主进程 completed 仅代表提取完成）
          if (type === 'character') {
            if (!actualOutputDir) continue
            const completedByAudio = await hasAnyAudio(actualOutputDir)
            if (!completedByAudio) continue

            console.log('[WorkflowHistory] Detected character workflow audio, completing session:', session.id, type)
            completedSessionsRef.current.add(session.id)
            dispatch(completeSession({ type, outputDir: actualOutputDir }))
            continue
          }

          // Other workflows: completed in main process means done
          const isCompleted = mainState.progress?.stage === 'completed' ||
            (mainState.progress?.percentage === 100 && !mainState.isProcessing)

          if (isCompleted) {
            console.log('[WorkflowHistory] Detected stuck completed task, completing session:', session.id, type)
            completedSessionsRef.current.add(session.id)
            dispatch(completeSession({ type, outputDir: actualOutputDir || session.outputDir }))
          }
        } catch (error) {
          console.warn('[WorkflowHistory] Error checking main process state for stuck task:', error)
        }
      }
    }

    // Check immediately
    checkAndCompleteStuckTasks()

    // Also set up periodic check every 2 seconds for tasks that complete while on this page
    const intervalId = setInterval(checkAndCompleteStuckTasks, 2000)

    return () => {
      clearInterval(intervalId)
    }
  }, [activeSessionsList, dispatch])

  const handleOpenDir = useCallback((outputDir: string) => {
    window.api.file.openPath(outputDir)
  }, [])

  const handleDeleteHistoryDir = useCallback(
    async (outputDir: string) => {
      const ok = await modalConfirm({
        title: t('workflow.history.delete', '删除'),
        content: t(
          'workflow.history.deleteConfirm',
          '将永久删除该任务的目录及其全部文件，且无法恢复。确定要删除吗？'
        ),
        okType: 'danger',
        okText: t('common.delete', '删除'),
        cancelText: t('common.cancel', '取消')
      })

      if (!ok) return

      try {
        setIsReloading(true)
        await window.api.file.deleteExternalDir(outputDir)
        window.toast?.success?.(t('workflow.history.deleted', '已删除'))
      } catch (error) {
        console.error('Failed to delete workflow dir:', error)
        window.toast?.error?.(t('workflow.history.deleteFailed', '删除失败'))
      } finally {
        setReloadSeq((v) => v + 1)
      }
    },
    [t]
  )

  // Reload history from filesystem
  const handleReload = useCallback(() => {
    setIsReloading(true)
    setReloadSeq((v) => v + 1)
  }, [])

  const handleViewResult = useCallback(
    (session: WorkflowSession) => {
      const config = WORKFLOW_CONFIG[session.type]
      const outputDir = session.outputDir
      if (outputDir) {
        navigate(`${config.route}?outputDir=${encodeURIComponent(outputDir)}`)
        return
      }
      navigate(config.route)
    },
    [navigate]
  )

  const handleContinueSession = useCallback(
    (type: WorkflowType) => {
      const config = WORKFLOW_CONFIG[type]
      navigate(config.route)
    },
    [navigate]
  )

  if (!showEmpty && fileHistory.length === 0 && activeSessionsList.length === 0 && !isLoadingHistory) {
    return null
  }

  return (
    <div className="w-full">
      <Accordion
        selectionMode="multiple"
        defaultExpandedKeys={activeSessionsList.length > 0 ? ['active', 'history'] : ['history']}
        className="px-0"
        itemClasses={{
          base: 'py-0',
          title: 'text-sm font-medium text-foreground/70',
          trigger: 'py-2 px-0 data-[hover=true]:bg-transparent',
          content: 'pt-0 pb-2 px-0'
        }}
      >
        {/* Active Sessions */}
        {activeSessionsList.length > 0 ? (
          <AccordionItem
            key="active"
            aria-label="Active sessions"
            title={
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
                <span>{t('workflow.history.active', '进行中')}</span>
                <Chip size="sm" variant="flat" color="warning" className="ml-1">
                  {activeSessionsList.length}
                </Chip>
              </div>
            }
          >
            <div className="flex flex-col gap-1">
              {activeSessionsList.map(({ type, session }) => (
                <ActiveSessionRow
                  key={session.id}
                  type={type}
                  session={session}
                  onContinue={() => handleContinueSession(type)}
                  onCancel={() => void handleCancelSession(type)}
                />
              ))}
            </div>
          </AccordionItem>
        ) : null}

        {/* History */}
        <AccordionItem
          key="history"
          aria-label="History"
          title={
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-foreground/50" />
              <span>{t('workflow.history.title', '历史记录')}</span>
              {fileHistory.length > 0 && (
                <Chip size="sm" variant="flat" className="ml-1">
                  {fileHistory.length}
                </Chip>
              )}
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="ml-auto"
                isLoading={isReloading || isLoadingHistory}
                onClick={(e) => {
                  e.stopPropagation()
                }}
                onPress={() => {
                  handleReload()
                }}
                title={t('workflow.history.reload', '刷新历史记录')}
              >
                <RefreshCw size={14} />
              </Button>
            </div>
          }
        >
          {isLoadingHistory ? (
            <div className="text-center py-6 text-foreground/40">
              <p className="text-sm">{t('workflow.history.loading', '正在加载...')}</p>
            </div>
          ) : fileHistory.length === 0 ? (
            <div className="text-center py-6 text-foreground/40">
              <Clock size={20} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">{t('workflow.history.empty', '暂无历史记录')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {fileHistory.map((session) => (
                <HistoryRow
                  key={session.id}
                  session={session}
                  onOpenDir={session.outputDir ? () => handleOpenDir(session.outputDir!) : undefined}
                  onDelete={session.outputDir ? () => void handleDeleteHistoryDir(session.outputDir!) : undefined}
                  onViewResult={() => handleViewResult(session)}
                />
              ))}
            </div>
          )}
        </AccordionItem>
      </Accordion>
    </div>
  )
}

export default WorkflowHistory
