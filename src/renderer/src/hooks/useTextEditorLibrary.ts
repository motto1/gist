import type { TextBook } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// 使用新的 TextBooks 目录结构
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

const createId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useTextEditorLibrary() {
  const navigate = useNavigate()
  const [books, setBooks] = useState<TextBook[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const persistBooks = useCallback(async (nextBooks: TextBook[]) => {
    const libraryPath = await getLibraryFilePath()
    await window.api.file.write(libraryPath, JSON.stringify(nextBooks, null, 2))
  }, [])

  const loadBooks = useCallback(async () => {
    setIsLoading(true)
    try {
      const libraryPath = await getLibraryFilePath()
      const raw = await window.api.file.readExternal(libraryPath, false)
      const parsed = typeof raw === 'string' ? safeJsonParse<unknown>(raw) : null
      const allBooks = normalizeBooks(parsed)

      // 检查文件是否存在；同时将 library.json 迁移为“相对路径为主”的格式，支持整体搬迁（如盘符变化）
      const validBooks: TextBook[] = []
      const removedBooks: TextBook[] = []
      let repairedCount = 0
      let migratedCount = 0

      const normalizeRelative = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '')

      const exists = async (filePath: string) => {
        try {
          return Boolean(await window.api.file.get(filePath))
        } catch {
          return false
        }
      }

      const resolveAbsoluteFromRelative = async (relativeFilePath: string) => {
        const textBooksDir = await window.api.textBooks.getTextBooksDir()
        const normalized = normalizeRelative(relativeFilePath)
        const parts = normalized.split('/').filter(Boolean)
        return await window.api.path.join(textBooksDir, ...parts)
      }

      for (const book of allBooks) {
        // 1) 优先相对路径（可跨设备/跨盘符）
        if (book.relativeFilePath) {
          const absolute = await resolveAbsoluteFromRelative(book.relativeFilePath)
          if (await exists(absolute)) {
            const folderPath = book.folderName ? await getBookFolderPath(book.folderName) : book.folderPath
            const next: TextBook = {
              ...book,
              folderPath,
              filePath: absolute,
              relativeFilePath: normalizeRelative(book.relativeFilePath)
            }
            validBooks.push(next)
            // 相对路径存在但之前绝对路径失效时，视为修复
            if (book.filePath !== absolute) repairedCount++
            continue
          }
        }

        // 2) 兼容旧数据：如果绝对路径仍可读，保留并补全相对路径
        if (book.filePath && (await exists(book.filePath))) {
          if (book.folderName) {
            const relativeFilePath = `${book.folderName}/content.txt`
            const folderPath = await getBookFolderPath(book.folderName)
            validBooks.push({
              ...book,
              folderPath,
              relativeFilePath: book.relativeFilePath ? normalizeRelative(book.relativeFilePath) : relativeFilePath
            })
            if (!book.relativeFilePath) migratedCount++
          } else {
            validBooks.push(book)
          }
          continue
        }

        // 3) 通过 folderName 推导（当 library.json 中绝对路径失效时）
        if (book.folderName) {
          const folderPath = await getBookFolderPath(book.folderName)
          const derivedContentPath = await getBookContentPath(book.folderName)
          if (await exists(derivedContentPath)) {
            const next: TextBook = {
              ...book,
              folderPath,
              filePath: derivedContentPath,
              relativeFilePath: book.relativeFilePath ? normalizeRelative(book.relativeFilePath) : `${book.folderName}/content.txt`
            }
            validBooks.push(next)
            repairedCount++
            if (!book.relativeFilePath) migratedCount++
            continue
          }
        }

        removedBooks.push(book)
      }

      // 如果有书籍被清理/修复/迁移，持久化更新后的列表
      if (removedBooks.length > 0 || repairedCount > 0 || migratedCount > 0) {
        if (removedBooks.length > 0) {
          console.info(`Auto-cleaned ${removedBooks.length} missing book(s):`, removedBooks.map((b) => b.title))
        }
        if (repairedCount > 0) {
          console.info(`Auto-repaired ${repairedCount} book path(s)`)
        }
        if (migratedCount > 0) {
          console.info(`Auto-migrated ${migratedCount} book(s) to relativeFilePath`)
        }
        const libraryPathForWrite = await getLibraryFilePath()
        await window.api.file.write(libraryPathForWrite, JSON.stringify(validBooks, null, 2))
      }

      setBooks(validBooks)
    } catch {
      setBooks([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadBooks()
  }, [loadBooks])

  const importBook = useCallback(async () => {
    const files = await window.api.file.select({
      title: '导入 TXT 文件',
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })

    if (!files || files.length === 0) return

    const selectedFile = files[0]
    setIsLoading(true)
    try {
      const content = await window.api.file.readExternal(selectedFile.path, true)
      if (typeof content !== 'string') {
        window.toast?.error?.('无法读取文件内容')
        return
      }

      const { name, ext } = await window.api.path.parse(selectedFile.path)
      const id = createId()
      const now = new Date().toISOString()
      const bytes = new TextEncoder().encode(content).length

      // 生成文件夹名称（基于书名，处理特殊字符和重名）
      const folderName = await window.api.textBooks.generateFolderName(name || '未命名', books.map(b => b.folderName))

      // 创建书籍文件夹并保存内容
      const bookFolder = await getBookFolderPath(folderName)
      const contentPath = await getBookContentPath(folderName)

      // 创建目录结构并保存书籍内容（静默写入，不弹保存对话框）
      await window.api.file.mkdir(bookFolder)
      await window.api.file.mkdir(await window.api.path.join(bookFolder, 'compression'))
      await window.api.file.mkdir(await window.api.path.join(bookFolder, 'character'))
      await window.api.file.mkdir(await window.api.path.join(bookFolder, 'outline'))
      await window.api.file.write(contentPath, content)

      // 预热阅读器缓存：后台构建章节索引/缓存，避免首次打开大文件卡顿
      void window.api.textReader.openBook(contentPath)

      const nextBook: TextBook = {
        id,
        title: name || '未命名',
        originalFileName: `${name}${ext}`,
        folderName,
        folderPath: bookFolder,
        filePath: contentPath,
        relativeFilePath: `${folderName}/content.txt`,
        createdAt: now,
        updatedAt: now,
        fileSize: bytes,
        charCount: content.length
      }

      const nextBooks = [nextBook, ...books]
      setBooks(nextBooks)
      await persistBooks(nextBooks)
      window.toast?.success?.('导入成功')
    } catch (error) {
      console.error('Failed to import book:', error)
      window.toast?.error?.('导入失败')
    } finally {
      setIsLoading(false)
    }
  }, [books, persistBooks])

  const updateTitle = useCallback(
    async (bookId: string, newTitle: string) => {
      const title = newTitle.trim()
      if (!title) return
      const nextBooks = books.map((b) => (b.id === bookId ? { ...b, title, updatedAt: new Date().toISOString() } : b))
      setBooks(nextBooks)
      await persistBooks(nextBooks)
    },
    [books, persistBooks]
  )

  const deleteBook = useCallback(
    async (bookId: string) => {
      const book = books.find((b) => b.id === bookId)
      const nextBooks = books.filter((b) => b.id !== bookId)
      setBooks(nextBooks)
      await persistBooks(nextBooks)

      // 删除书籍文件夹
      if (book?.folderName) {
        try {
          const bookFolder = await getBookFolderPath(book.folderName)
          await window.api.file.deleteExternalDir(bookFolder)
        } catch {
          // ignore
        }
      }
    },
    [books, persistBooks]
  )

  const openReadView = useCallback(
    (bookId: string) => {
      navigate(`/text-reader/${bookId}`)
    },
    [navigate]
  )

  /** 重新排序书籍（用于拖拽排序） */
  const reorderBooks = useCallback(
    async (newBooks: TextBook[]) => {
      setBooks(newBooks)
      await persistBooks(newBooks)
    },
    [persistBooks]
  )

  return {
    books,
    isLoading,
    importBook,
    updateTitle,
    deleteBook,
    openReadView,
    reorderBooks
  }
}
