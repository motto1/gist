import type { ReaderChapter, ReaderSidebarMode, TextBook } from '@shared/types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const SIDEBAR_MODE_KEY = 'text-reader-sidebar-mode'

type CacheChapter = ReaderChapter & {
  cachePath?: string
  charLength?: number
  order?: number
}

// 使用 TextBooks 目录结构
const getLibraryFilePath = async () => {
  const textBooksDir = await window.api.textBooks.getTextBooksDir()
  return await window.api.path.join(textBooksDir, 'library.json')
}

const getBookFolderPath = async (folderName: string) => {
  const textBooksDir = await window.api.textBooks.getTextBooksDir()
  return await window.api.path.join(textBooksDir, folderName)
}

const getBookContentPath = async (folderName: string) => {
  const bookFolder = await getBookFolderPath(folderName)
  return await window.api.path.join(bookFolder, 'content.txt')
}

const safeJsonParse = <T,>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const normalizeBooks = (raw: unknown): TextBook[] => {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((b) => typeof b === 'object' && b !== null)
    .map((b) => b as TextBook)
    .filter((b) => typeof b.id === 'string' && typeof b.title === 'string')
}

const resolveBookContentPath = async (
  book: TextBook
): Promise<{ contentPath: string; folderPath?: string }> => {
  const exists = async (targetPath: string) => {
    try {
      return Boolean(await window.api.file.get(targetPath))
    } catch {
      return false
    }
  }

  if (book.relativeFilePath) {
    const textBooksDir = await window.api.textBooks.getTextBooksDir()
    const normalized = book.relativeFilePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '')
    const parts = normalized.split('/').filter(Boolean)
    const absolute = await window.api.path.join(textBooksDir, ...parts)
    if (await exists(absolute)) {
      const folderPath = book.folderName ? await getBookFolderPath(book.folderName) : book.folderPath
      return { contentPath: absolute, folderPath }
    }
  }

  if (book.filePath && (await exists(book.filePath))) {
    return { contentPath: book.filePath }
  }

  if (book.folderName) {
    const folderPath = await getBookFolderPath(book.folderName)
    const derived = await getBookContentPath(book.folderName)
    if (await exists(derived)) {
      return { contentPath: derived, folderPath }
    }
  }

  return { contentPath: book.filePath || '' }
}

export function useTextReader(bookId: string) {
  const navigate = useNavigate()

  const [book, setBook] = useState<TextBook | null>(null)
  const [content, setContent] = useState('')
  const [chapters, setChapters] = useState<CacheChapter[]>([])
  const [currentChapter, setCurrentChapter] = useState<CacheChapter | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isCacheBuilding, setIsCacheBuilding] = useState(false)
  const [sidebarMode, setSidebarModeState] = useState<ReaderSidebarMode>(() => {
    const saved = localStorage.getItem(SIDEBAR_MODE_KEY)
    return saved === 'hover' ? 'hover' : 'fixed'
  })

  const setSidebarMode = useCallback((mode: ReaderSidebarMode) => {
    setSidebarModeState(mode)
    localStorage.setItem(SIDEBAR_MODE_KEY, mode)
  }, [])

  const goBack = useCallback(() => {
    navigate('/text-editor')
  }, [navigate])

  useEffect(() => {
    let isMounted = true
    let disposeListener: (() => void) | null = null

    setIsLoading(true)
    setError(null)

    ;(async () => {
      try {
        const libraryPath = await getLibraryFilePath()
        const raw = await window.api.file.readExternal(libraryPath, false)
        const parsed = typeof raw === 'string' ? safeJsonParse<unknown>(raw) : null
        const books = normalizeBooks(parsed)
        const found = books.find((b) => b.id === bookId) ?? null
        if (!found) {
          throw new Error('未找到图书')
        }

        // 优先使用可读的 filePath；若 library.json 里的绝对路径失效（例如盘符变化），回退到 folderName 推导
        const { contentPath, folderPath } = await resolveBookContentPath(found)
        if (!contentPath) {
          throw new Error('图书路径缺失')
        }

        const opened = await window.api.textReader.openBook(contentPath)
        if (!isMounted) return

        setBook({ ...found, filePath: contentPath, folderPath: folderPath ?? found.folderPath })
        setContent(opened.preview || '')
        setIsCacheBuilding(Boolean(opened.isBuilding) || !opened.cache)

        if (opened.cache?.chapters?.length) {
          const next = [...opened.cache.chapters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          setChapters(next)
          setCurrentChapter(next[0] ?? null)
        } else {
          const previewChapter: CacheChapter = {
            id: 'preview',
            title: '正文',
            startIndex: 0,
            endIndex: opened.preview.length,
            level: 1
          }
          setChapters([previewChapter])
          setCurrentChapter(previewChapter)
        }

        disposeListener = window.api.textReader.onCacheUpdated((data) => {
          if (!isMounted) return
          if (!data || data.contentPath !== contentPath) return

          const next = [...(data.chapters ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          if (next.length > 0) {
            setChapters(next)
            setCurrentChapter((prev) => {
              if (!prev) return next[0] ?? null
              const match = next.find((c) => c.id === prev.id)
              return match ?? (next[0] ?? null)
            })
          }
          setIsCacheBuilding(false)
        })
      } catch (e) {
        if (!isMounted) return
        setError(e instanceof Error ? e.message : '读取失败')
      } finally {
        if (!isMounted) return
        setIsLoading(false)
      }
    })()

    return () => {
      isMounted = false
      disposeListener?.()
    }
  }, [bookId])

  return useMemo(() => {
    return {
      book,
      content,
      chapters,
      currentChapter,
      isLoading,
      error,
      isCacheBuilding,
      sidebarMode,
      setSidebarMode,
      setCurrentChapter,
      goBack
    }
  }, [
    book,
    content,
    chapters,
    currentChapter,
    isLoading,
    error,
    isCacheBuilding,
    sidebarMode,
    setSidebarMode,
    setCurrentChapter,
    goBack
  ])
}
