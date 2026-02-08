import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Tooltip } from '@heroui/react'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import type { TextBook } from '@shared/types'
import { BookOpen, Clock, FileText, MoreVertical, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  book: TextBook
  isDragging?: boolean
  onTitleChange: (newTitle: string) => void | Promise<void>
  onDelete: () => void
  onRead: () => void
}

export default function BookCard({ book, isDragging = false, onTitleChange, onDelete, onRead }: Props) {
  const { t, i18n } = useTranslation()
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleteConfirmPending, setIsDeleteConfirmPending] = useState(false)

  const hue = useMemo(() => hashStringToHue(book.id), [book.id])
  const fileSizeLabel = formatBytes(book.fileSize)
  const updatedAtLabel = formatIsoDateTime(book.updatedAt, i18n.language)
  const title = book.title

  const handleRename = async () => {
    const nextTitle = await PromptPopup.show({
      title: t('textEditor.editTitle', '修改标题'),
      message: '',
      defaultValue: title,
      inputPlaceholder: t('textEditor.titlePlaceholder', '请输入标题'),
      inputProps: { rows: 1 }
    })
    const next = (nextTitle ?? '').trim()
    if (!next) {
      if (nextTitle !== null) {
        window.toast?.error?.(t('textEditor.titleRequired', '标题不能为空'))
      }
      return
    }
    if (next === title) return
    await Promise.resolve(onTitleChange(next))
    window.toast?.success?.(t('common.saved', '已保存'))
  }

  const handleDelete = () => {
    setIsDeleteModalOpen(false)
    setIsDeleteConfirmPending(false)
    onDelete()
  }

  // Handle keyboard delete with confirmation
  const handleKeyboardDelete = useCallback(async () => {
    if (isDeleteConfirmPending) return

    setIsDeleteConfirmPending(true)
    try {
      const confirmed = await new Promise<boolean>((resolve) => {
        window.modal?.confirm({
          title: t('textEditor.deleteConfirmTitle', '删除确认'),
          content: t('textEditor.deleteConfirmMessage', '确定要将此图书移入回收站吗？'),
          centered: true,
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })

      if (confirmed) {
        onDelete()
      }
    } finally {
      setIsDeleteConfirmPending(false)
    }
  }, [isDeleteConfirmPending, onDelete, t])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRead()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        void handleKeyboardDelete()
      }
    },
    [onRead, handleKeyboardDelete]
  )

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onRead}
      onKeyDown={handleKeyDown}
      style={{ ['--book-hue' as never]: hue }}
      className={`group w-full max-w-[280px] cursor-pointer overflow-hidden rounded-2xl border border-divider bg-content1 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        isDragging ? 'opacity-60 scale-[1.02] shadow-2xl ring-2 ring-primary' : ''
      }`}
    >
      {/* Cover Area */}
      <div
        className="relative aspect-[3/4] p-[14px_14px_12px_16px] flex flex-col gap-2.5 justify-between text-white/92"
        style={{
          background: `linear-gradient(135deg, hsl(var(--book-hue, 210), 70%, 56%), hsl(calc(var(--book-hue, 210) + 22), 70%, 42%))`
        }}
      >
        {/* Gradient overlays */}
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-white/[0.18] via-transparent to-black/[0.12]" />
        <div className="absolute top-0 bottom-0 left-0 w-3 pointer-events-none bg-gradient-to-r from-black/[0.28] to-transparent opacity-65" />

        {/* Quick Actions */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-2.5 right-2.5 flex gap-1.5 opacity-0 -translate-y-0.5 transition-all duration-150 group-hover:opacity-100 group-hover:translate-y-0 hover:opacity-100 hover:translate-y-0"
        >
          <Tooltip content={t('textEditor.clickToRead', '点击阅读')}>
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              className="text-white/92 bg-black/[0.26] border border-white/[0.14] backdrop-blur-md hover:bg-black/[0.34]"
              aria-label={t('textEditor.clickToRead', '点击阅读')}
              onClick={(e) => {
                e.stopPropagation()
                onRead()
              }}
            >
              <BookOpen size={16} />
            </Button>
          </Tooltip>

          <Tooltip content={t('textEditor.editTitle', '修改标题')}>
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              className="text-white/92 bg-black/[0.26] border border-white/[0.14] backdrop-blur-md hover:bg-black/[0.34]"
              aria-label={t('textEditor.editTitle', '修改标题')}
              onClick={(e) => {
                e.stopPropagation()
                void handleRename()
              }}
            >
              <Pencil size={16} />
            </Button>
          </Tooltip>

          <Dropdown
            closeOnSelect={false}
            onOpenChange={(open) => {
              if (!open) setIsDeleteModalOpen(false)
            }}
          >
            <DropdownTrigger>
              <Button
                isIconOnly
                size="sm"
                variant="flat"
                className="text-white/92 bg-black/[0.26] border border-white/[0.14] backdrop-blur-md hover:bg-black/[0.34]"
                aria-label="More actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical size={16} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label="Book actions">
              {isDeleteModalOpen ? (
                <>
                  <DropdownItem key="confirm-text" className="opacity-70" isReadOnly>
                    {t('textEditor.deleteConfirmMessage', '确定要将此图书移入回收站吗？')}
                  </DropdownItem>
                  <DropdownItem
                    key="confirm-delete"
                    color="danger"
                    className="text-danger"
                    startContent={<Trash2 size={16} />}
                    onPress={handleDelete}
                  >
                    {t('textEditor.delete', '删除')}
                  </DropdownItem>
                  <DropdownItem key="cancel" onPress={() => setIsDeleteModalOpen(false)}>
                    {t('common.cancel', '取消')}
                  </DropdownItem>
                </>
              ) : (
                <DropdownItem
                  key="delete"
                  color="danger"
                  className="text-danger"
                  startContent={<Trash2 size={16} />}
                  onPress={() => setIsDeleteModalOpen(true)}
                >
                  {t('textEditor.delete', '删除')}
                </DropdownItem>
              )}
            </DropdownMenu>
          </Dropdown>
        </div>

        {/* Badge */}
        <span className="absolute top-2.5 left-3 inline-flex items-center justify-center h-5 px-2 rounded-full text-xs font-semibold tracking-wide text-white/92 bg-black/[0.22] border border-white/[0.14]">
          TXT
        </span>

        {/* Title */}
        <div className="relative mt-auto flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
          <p className="m-0 text-white/92 text-base font-semibold leading-tight line-clamp-2" title={title}>
            {title}
          </p>
        </div>
      </div>

      {/* Meta Area */}
      <div className="p-[10px_12px_12px] flex flex-col gap-2">
        {/* Stats Row */}
        <div className="flex items-center gap-3 text-foreground/60 text-xs whitespace-nowrap overflow-hidden">
          <span className="inline-flex items-center gap-1.5 leading-tight" title={fileSizeLabel}>
            <FileText size={13} className="flex-none" />
            <span>{fileSizeLabel}</span>
          </span>

          {typeof book.charCount === 'number' && (
            <span
              className="inline-flex items-center gap-1.5 leading-tight"
              title={`${book.charCount.toLocaleString(i18n.language)} ${t('textEditor.chars', '字')}`}
            >
              <span>{book.charCount.toLocaleString(i18n.language)}</span>
              <span>{t('textEditor.chars', '字')}</span>
            </span>
          )}
        </div>

        {/* Date Row */}
        <div className="flex items-center text-foreground/60 text-xs min-w-0">
          <span className="inline-flex items-center gap-1.5 leading-tight min-w-0" title={updatedAtLabel}>
            <Clock size={13} className="flex-none" />
            <span className="min-w-0 overflow-hidden text-ellipsis">{updatedAtLabel}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

const hashStringToHue = (value: string): number => {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  const precision = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${units[index]}`
}

const formatIsoDateTime = (iso: string, locale: string): string => {
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return new Intl.DateTimeFormat(locale || 'zh-CN', {
      dateStyle: 'medium'
    }).format(date)
  } catch {
    return iso
  }
}
