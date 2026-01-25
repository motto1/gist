import { Button, Card, CardBody, Spinner, Tab, Tabs } from '@heroui/react'
import { FileMetadata, FileTypes } from '@renderer/types/file'
import { TextBook } from '@shared/types'
import { BookOpen, FileText, FolderOpen, Upload } from 'lucide-react'
import { FC, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type SelectedFile = FileMetadata

interface NovelPickerProps {
  selectedFile: SelectedFile | null
  onFileSelect: (file: SelectedFile | null) => void
}

type SourceTab = 'file' | 'library'

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// 直接读取 library.json 文件（与 useTextEditorLibrary hook 相同的方式）
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

// Convert TextBook to FileMetadata
const bookToFileMetadata = (book: TextBook): FileMetadata => ({
  id: book.id,
  name: book.title,
  origin_name: book.title,
  path: book.filePath,
  size: book.fileSize,
  ext: '.txt',
  type: FileTypes.TEXT,
  created_at: book.createdAt,
  mtime: new Date(book.updatedAt).getTime(),
  count: 0,
  charLength: book.charCount
})

const NovelPicker: FC<NovelPickerProps> = ({ selectedFile, onFileSelect }) => {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SourceTab>('file')
  const [books, setBooks] = useState<TextBook[]>([])
  const [isLoadingBooks, setIsLoadingBooks] = useState(false)
  const [isImporting, setIsImporting] = useState(false)

  // Load books from library.json file directly
  const loadBooks = useCallback(async () => {
    setIsLoadingBooks(true)
    try {
      const libraryPath = await getLibraryFilePath()
      const raw = await window.api.file.readExternal(libraryPath, false)
      const parsed = typeof raw === 'string' ? safeJsonParse<unknown>(raw) : null
      setBooks(normalizeBooks(parsed))
    } catch (error) {
      console.error('Failed to load books:', error)
      setBooks([])
    } finally {
      setIsLoadingBooks(false)
    }
  }, [])

  // Load books when switching to library tab or on mount
  useEffect(() => {
    loadBooks()
  }, [loadBooks])

  // Import file to library (same logic as useTextEditorLibrary.importBook)
  const importFileToLibrary = useCallback(async (filePath: string): Promise<TextBook | null> => {
    try {
      const content = await window.api.file.readExternal(filePath, true)
      if (typeof content !== 'string') {
        window.toast?.error?.(t('workflow.config.cannotReadFile', '无法读取文件内容'))
        return null
      }

      const { name, ext } = await window.api.path.parse(filePath)
      const id = createId()
      const now = new Date().toISOString()
      const bytes = new TextEncoder().encode(content).length

      // Generate folder name (handle special characters and duplicates)
      const existingFolderNames = books.map(b => b.folderName)
      const folderName = await window.api.textBooks.generateFolderName(name || '未命名', existingFolderNames)

      // Create book folder and save content
      const bookFolder = await getBookFolderPath(folderName)
      const contentPath = await getBookContentPath(folderName)

      // Create directory structure and save book content
      await window.api.file.mkdir(bookFolder)
      await window.api.file.mkdir(await window.api.path.join(bookFolder, 'compression'))
      await window.api.file.mkdir(await window.api.path.join(bookFolder, 'character'))
      await window.api.file.mkdir(await window.api.path.join(bookFolder, 'outline'))
      await window.api.file.write(contentPath, content)

      // Preheat reader cache
      void window.api.textReader.openBook(contentPath)

      const newBook: TextBook = {
        id,
        title: name || '未命名',
        originalFileName: `${name}${ext}`,
        folderName,
        folderPath: bookFolder,
        filePath: contentPath,
        createdAt: now,
        updatedAt: now,
        fileSize: bytes,
        charCount: content.length
      }

      // Update library.json
      const nextBooks = [newBook, ...books]
      const libraryPath = await getLibraryFilePath()
      await window.api.file.write(libraryPath, JSON.stringify(nextBooks, null, 2))
      setBooks(nextBooks)

      return newBook
    } catch (error) {
      console.error('Failed to import file to library:', error)
      window.toast?.error?.(t('workflow.config.importFailed', '导入失败'))
      return null
    }
  }, [books, t])

  // Handle file selection from system - import to library first
  const handleSelectFile = useCallback(async () => {
    try {
      const result = await window.api.file.select({
        title: t('workflow.config.selectNovelFile', '选择小说文件'),
        filters: [
          { name: 'Text Files', extensions: ['txt'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })

      if (!result || result.length === 0) return

      const selectedPath = result[0].path

      // Check if the file is already in the library
      const textBooksDir = await window.api.textBooks.getTextBooksDir()
      if (selectedPath.includes(textBooksDir) || selectedPath.includes('TextBooks')) {
        // Already a library book, find it and use it directly
        const existingBook = books.find(b => b.filePath === selectedPath)
        if (existingBook) {
          onFileSelect(bookToFileMetadata(existingBook))
          return
        }
      }

      // Import to library first
      setIsImporting(true)
      const importedBook = await importFileToLibrary(selectedPath)
      setIsImporting(false)

      if (importedBook) {
        window.toast?.success?.(t('workflow.config.importedToLibrary', '已导入书库'))
        onFileSelect(bookToFileMetadata(importedBook))
      }
    } catch (error) {
      console.error('Failed to select file:', error)
      setIsImporting(false)
    }
  }, [books, importFileToLibrary, onFileSelect, t])

  // Handle book selection from library
  const handleSelectBook = useCallback(
    (book: TextBook) => {
      onFileSelect(bookToFileMetadata(book))
    },
    [onFileSelect]
  )

  // Handle clear selection
  const handleClearFile = useCallback(() => {
    onFileSelect(null)
  }, [onFileSelect])

  // If file is selected, show selected state
  if (selectedFile) {
    return (
      <div className="w-full">
        <label className="text-sm font-medium text-foreground/70 mb-2 block">
          {t('workflow.config.selectNovel', '选择小说')}
        </label>
        <Card className="bg-foreground/5">
          <CardBody className="flex flex-row items-center gap-4 py-4 px-4">
            <div className="p-3 rounded-lg bg-primary/10 flex-shrink-0">
              <FileText size={24} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{selectedFile.origin_name}</p>
              <p className="text-sm text-foreground/50">
                {formatFileSize(selectedFile.size)}
                {selectedFile.charLength && ` · ${selectedFile.charLength.toLocaleString()} 字`}
              </p>
            </div>
            <Button variant="light" color="danger" size="sm" onPress={handleClearFile} className="flex-shrink-0">
              {t('workflow.config.clear', '清除')}
            </Button>
          </CardBody>
        </Card>
      </div>
    )
  }

  // Show picker UI
  return (
    <div className="w-full">
      <label className="text-sm font-medium text-foreground/70 mb-2 block">
        {t('workflow.config.selectNovel', '选择小说')}
      </label>

      <Card>
        <CardBody className="p-0">
          {/* Source Tabs */}
          <Tabs
            aria-label="Novel source"
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as SourceTab)}
            classNames={{
              tabList: 'w-full bg-foreground/5 p-1 rounded-t-lg',
              cursor: 'bg-background shadow-sm',
              tab: 'h-10',
              panel: 'p-0'
            }}
          >
            <Tab
              key="file"
              title={
                <div className="flex items-center gap-2">
                  <FolderOpen size={16} />
                  <span>{t('workflow.config.localFile', '本地文件')}</span>
                </div>
              }
            >
              {/* Local File Selection */}
              {isImporting ? (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                  <Spinner size="lg" />
                  <p className="text-sm text-foreground/60">
                    {t('workflow.config.importing', '正在导入书库...')}
                  </p>
                </div>
              ) : (
                <div
                  onClick={handleSelectFile}
                  className="flex flex-col items-center justify-center py-12 gap-4 cursor-pointer hover:bg-foreground/5 transition-colors"
                >
                  <div className="p-4 rounded-full bg-foreground/5">
                    <Upload size={32} className="text-foreground/40" />
                  </div>
                  <div className="text-center">
                    <p className="font-medium text-foreground/70">
                      {t('workflow.config.clickToSelect', '点击选择文件')}
                    </p>
                    <p className="text-sm text-foreground/40 mt-1">
                      {t('workflow.config.willImportToLibrary', '选择后将自动导入书库')}
                    </p>
                  </div>
                </div>
              )}
            </Tab>

            <Tab
              key="library"
              title={
                <div className="flex items-center gap-2">
                  <BookOpen size={16} />
                  <span>{t('workflow.config.library', '书库')}</span>
                </div>
              }
            >
              {/* Library Selection */}
              <div className="p-4">
                {isLoadingBooks ? (
                  <div className="flex items-center justify-center py-12">
                    <Spinner size="lg" />
                  </div>
                ) : books.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-4">
                    <div className="p-4 rounded-full bg-foreground/5">
                      <BookOpen size={32} className="text-foreground/40" />
                    </div>
                    <div className="text-center">
                      <p className="font-medium text-foreground/70">
                        {t('workflow.config.noBooks', '书库为空')}
                      </p>
                      <p className="text-sm text-foreground/40 mt-1">
                        {t('workflow.config.importBooksHint', '请先在书库中导入小说')}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                    {books.map((book) => (
                      <Button
                        key={book.id}
                        variant="bordered"
                        className="h-auto py-3 px-4 justify-start"
                        onPress={() => handleSelectBook(book)}
                      >
                        <div className="flex items-center gap-3 w-full min-w-0">
                          <FileText size={20} className="text-primary flex-shrink-0" />
                          <div className="flex-1 text-left min-w-0">
                            <p className="font-medium truncate">{book.title}</p>
                            <p className="text-xs text-foreground/50">
                              {formatFileSize(book.fileSize)}
                              {book.charCount && ` · ${book.charCount.toLocaleString()} 字`}
                            </p>
                          </div>
                        </div>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </Tab>
          </Tabs>
        </CardBody>
      </Card>
    </div>
  )
}

export default NovelPicker
