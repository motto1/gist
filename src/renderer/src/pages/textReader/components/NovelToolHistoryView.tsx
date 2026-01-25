import { Button, Select, SelectItem, Spinner } from '@heroui/react'
import type { TextBook } from '@shared/types'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

type ToolType = 'compression' | 'character' | 'outline'

type FsEntry = {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  mtimeMs: number
  size: number
}

type ViewerPayload = {
  title: string
  kind: 'text' | 'markdown'
  content: string
  openDirPath?: string
}

type Props = {
  tool: ToolType
  book: TextBook
  baseName: string
  showRuns?: boolean
  onOpenViewer: (payload: ViewerPayload) => void
}

const formatTime = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

export default function NovelToolHistoryView({ tool, book, baseName, showRuns = true, onOpenViewer }: Props) {
  const rootDir = useMemo(() => {
    const base = book.folderPath || ''
    if (!base) return ''
    if (tool === 'compression') return `${base}/compression`
    if (tool === 'character') return `${base}/character`
    return `${base}/outline`
  }, [book.folderPath, tool])

  const [runs, setRuns] = useState<FsEntry[]>([])
  const [isLoadingRuns, setIsLoadingRuns] = useState(false)
  const [selectedRun, setSelectedRun] = useState<FsEntry | null>(null)

  const [characterFiles, setCharacterFiles] = useState<FsEntry[]>([])
  const [selectedCharacterPath, setSelectedCharacterPath] = useState<string | null>(null)
  const [isLoadingCharacters, setIsLoadingCharacters] = useState(false)

  const filterRuns = useCallback(
    (entries: FsEntry[]) => {
      const dirs = entries.filter((e) => e.isDirectory)

      if (tool === 'compression') {
        const prefix = `${baseName}_chunks_`
        const legacy = `${baseName}_chunks`
        return dirs.filter((d) => d.name.startsWith(prefix) || d.name === legacy)
      }

      if (tool === 'character') {
        return dirs.filter((d) => d.name.includes('_人物志结果'))
      }

      return dirs.filter((d) => d.name.startsWith('novel_outline_'))
    },
    [tool, baseName]
  )

  const loadRuns = useCallback(async () => {
    if (!rootDir) return
    setIsLoadingRuns(true)
    try {
      const entries = (await window.api.fs.readdir(rootDir)) as FsEntry[]
      const filtered = filterRuns(entries).sort((a, b) => b.mtimeMs - a.mtimeMs)
      setRuns(filtered)
      setSelectedRun((prev) => {
        if (prev && filtered.some((r) => r.path === prev.path)) return prev
        return filtered[0] ?? null
      })

      if (filtered.length === 0) {
        setCharacterFiles([])
        setSelectedCharacterPath(null)
      }
    } catch (error) {
      console.error('Failed to load runs:', error)
      setRuns([])
      setSelectedRun(null)
      setCharacterFiles([])
      setSelectedCharacterPath(null)
    } finally {
      setIsLoadingRuns(false)
    }
  }, [rootDir, filterRuns])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  const openRootDir = useCallback(() => {
    if (rootDir) window.api.file.openPath(rootDir)
  }, [rootDir])

  const openSelectedDir = useCallback(() => {
    if (selectedRun) window.api.file.openPath(selectedRun.path)
  }, [selectedRun])

  const openCompressionOrOutlineViewer = useCallback(
    async (run: FsEntry) => {
      try {
        if (tool === 'outline') {
          const mdPath = await window.api.path.join(run.path, 'merged_outline.md')
          const md = await window.api.fs.readText(mdPath)
          onOpenViewer({
            title: run.name,
            kind: 'markdown',
            content: md,
            openDirPath: run.path
          })
          return
        }

        // compression - 直接读取 compressed.txt
        const compressedPath = await window.api.path.join(run.path, 'compressed.txt')
        const content = await window.api.fs.readText(compressedPath)
        onOpenViewer({
          title: run.name,
          kind: 'text',
          content: content,
          openDirPath: run.path
        })
      } catch (error) {
        console.error('Failed to open viewer:', error)
        onOpenViewer({
          title: run.name,
          kind: tool === 'outline' ? 'markdown' : 'text',
          content: '读取失败，请尝试打开目录查看。',
          openDirPath: run.path
        })
      }
    },
    [tool, onOpenViewer]
  )

  const loadCharacterFiles = useCallback(async () => {
    if (tool !== 'character') return
    if (!selectedRun) {
      setCharacterFiles([])
      setSelectedCharacterPath(null)
      return
    }

    setIsLoadingCharacters(true)
    try {
      const characterTextsDir = await window.api.path.join(selectedRun.path, '人物TXT合集')
      const entries = (await window.api.fs.readdir(characterTextsDir)) as FsEntry[]
      const txtFiles = entries
        .filter((e) => e.isFile && e.name.toLowerCase().endsWith('.txt'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

      setCharacterFiles(txtFiles)
      setSelectedCharacterPath((prev) => {
        if (prev && txtFiles.some((f) => f.path === prev)) return prev
        return txtFiles[0]?.path ?? null
      })
    } catch (error) {
      console.error('Failed to load character files:', error)
      setCharacterFiles([])
      setSelectedCharacterPath(null)
    } finally {
      setIsLoadingCharacters(false)
    }
  }, [tool, selectedRun])

  useEffect(() => {
    if (tool !== 'character') return
    loadCharacterFiles()
  }, [tool, selectedRun, loadCharacterFiles])

  const openCharacterViewer = useCallback(async () => {
    if (tool !== 'character') return
    if (!selectedRun || !selectedCharacterPath) return

    try {
      const text = await window.api.fs.readText(selectedCharacterPath)
      const name = selectedCharacterPath.split(/\\|\//).pop() || '人物.txt'
      onOpenViewer({
        title: `${selectedRun.name} / ${name}`,
        kind: 'text',
        content: text,
        openDirPath: selectedRun.path
      })
    } catch (error) {
      console.error('Failed to open character viewer:', error)
      onOpenViewer({
        title: selectedRun.name,
        kind: 'text',
        content: '读取失败，请尝试打开目录查看。',
        openDirPath: selectedRun.path
      })
    }
  }, [tool, selectedRun, selectedCharacterPath, onOpenViewer])

  const title = tool === 'compression' ? '压缩器' : tool === 'character' ? '人物志' : '大纲'

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-h-0">
      <div className="px-3 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between gap-2 w-full">
          <span className="text-xs font-bold">
            {title}{showRuns ? '历史' : '结果'}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />} onPress={loadRuns} isDisabled={!rootDir}>
              刷新
            </Button>
            <Button size="sm" variant="flat" startContent={<FolderOpen size={14} />} onPress={openRootDir} isDisabled={!rootDir}>
              打开根目录
            </Button>
            <Button size="sm" variant="flat" onPress={openSelectedDir} isDisabled={!selectedRun}>
              打开任务目录
            </Button>
          </div>
        </div>
      </div>

      {showRuns ? (
        <div className="flex-1 overflow-auto p-3 [-webkit-app-region:no-drag] novel-tools-scrollbar">
          {isLoadingRuns ? (
            <div className="flex flex-col items-center justify-center gap-2 p-4">
              <Spinner size="sm" />
              <span className="text-xs text-[var(--color-text-3)]">加载历史任务…</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <svg
                className="w-12 h-12 mb-3 text-[var(--color-text-4)] opacity-40"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span className="text-sm text-[var(--color-text-3)]">暂无历史任务</span>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {runs.map((item) => (
                <li
                  key={item.path}
                  className="cursor-pointer p-2 rounded-lg border border-[var(--color-border)] transition-colors"
                  style={{
                    background:
                      selectedRun?.path === item.path ? 'var(--color-background-mute)' : 'var(--color-background)'
                  }}
                  onClick={() => {
                    setSelectedRun(item)
                    if (tool === 'compression' || tool === 'outline') {
                      void openCompressionOrOutlineViewer(item)
                    }
                  }}
                >
                  <div className="text-xs font-medium mb-1">{item.name}</div>
                  <div className="text-[11px] text-[var(--color-text-3)]">
                    {formatTime(item.mtimeMs)}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {tool === 'character' && selectedRun && (
            <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex flex-col gap-2.5">
              <span className="text-xs text-[var(--color-text-3)]">
                请选择人物（任务：{selectedRun.name}）
              </span>
              <Select
                size="sm"
                placeholder="选择人物"
                isLoading={isLoadingCharacters}
                selectedKeys={selectedCharacterPath ? [selectedCharacterPath] : []}
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys)[0] as string | undefined
                  setSelectedCharacterPath(selected ?? null)
                }}
                classNames={{
                  trigger: '[-webkit-app-region:no-drag]'
                }}
              >
                {characterFiles.map((f) => (
                  <SelectItem key={f.path}>
                    {f.name}
                  </SelectItem>
                ))}
              </Select>
              <Button
                color="primary"
                size="sm"
                onPress={() => void openCharacterViewer()}
                isDisabled={!selectedCharacterPath}
              >
                全屏查看
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-3 flex flex-col gap-3 [-webkit-app-region:no-drag] novel-tools-scrollbar">
          <span className="text-xs text-[var(--color-text-3)]">
            当前任务（最新）：{selectedRun?.name || '暂无'}
          </span>

          {tool === 'character' ? (
            <>
              <Select
                size="sm"
                placeholder="选择人物"
                isLoading={isLoadingCharacters}
                selectedKeys={selectedCharacterPath ? [selectedCharacterPath] : []}
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys)[0] as string | undefined
                  setSelectedCharacterPath(selected ?? null)
                }}
                classNames={{
                  trigger: '[-webkit-app-region:no-drag]'
                }}
              >
                {characterFiles.map((f) => (
                  <SelectItem key={f.path}>
                    {f.name}
                  </SelectItem>
                ))}
              </Select>
              <Button
                color="primary"
                size="sm"
                onPress={() => void openCharacterViewer()}
                isDisabled={!selectedCharacterPath}
              >
                全屏查看
              </Button>
            </>
          ) : (
            <span className="text-xs text-[var(--color-text-3)]">
              该工具结果页建议使用上方"全屏显示"按钮。
            </span>
          )}
        </div>
      )}
    </div>
  )
}
