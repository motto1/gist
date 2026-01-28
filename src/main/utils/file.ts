import * as fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { audioExts, documentExts, imageExts, textExts, videoExts } from '@shared/config/constant'
import { FileMetadata, FileTypes, NotesTreeNode } from '@types'
import chardet from 'chardet'
import { app } from 'electron'
import iconv from 'iconv-lite'
import { v4 as uuidv4 } from 'uuid'

const logger = loggerService.withContext('Utils:File')

// 创建文件类型映射表，提高查找效率
const fileTypeMap = new Map<string, FileTypes>()

// 初始化映射表
function initFileTypeMap() {
  imageExts.forEach((ext) => fileTypeMap.set(ext, FileTypes.IMAGE))
  videoExts.forEach((ext) => fileTypeMap.set(ext, FileTypes.VIDEO))
  audioExts.forEach((ext) => fileTypeMap.set(ext, FileTypes.AUDIO))
  textExts.forEach((ext) => fileTypeMap.set(ext, FileTypes.TEXT))
  documentExts.forEach((ext) => fileTypeMap.set(ext, FileTypes.DOCUMENT))
}

// 初始化映射表
initFileTypeMap()

export function untildify(pathWithTilde: string) {
  if (pathWithTilde.startsWith('~')) {
    const homeDirectory = os.homedir()
    return pathWithTilde.replace(/^~(?=$|\/|\\)/, homeDirectory)
  }
  return pathWithTilde
}

export async function hasWritePermission(dir: string) {
  try {
    logger.info(`Checking write permission for ${dir}`)
    await fs.promises.access(dir, fs.constants.W_OK)
    return true
  } catch (error) {
    return false
  }
}

/**
 * Check if a path is inside another path (proper parent-child relationship)
 * This function correctly handles edge cases that string.startsWith() cannot handle,
 * such as distinguishing between '/root/test' and '/root/test aaa'
 *
 * @param childPath - The path that might be inside the parent path
 * @param parentPath - The path that might contain the child path
 * @returns true if childPath is inside parentPath, false otherwise
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
  try {
    const resolvedChild = path.resolve(childPath)
    const resolvedParent = path.resolve(parentPath)

    // Normalize paths to handle different separators
    const normalizedChild = path.normalize(resolvedChild)
    const normalizedParent = path.normalize(resolvedParent)

    // Check if they are the same path
    if (normalizedChild === normalizedParent) {
      return true
    }

    // Get relative path from parent to child
    const relativePath = path.relative(normalizedParent, normalizedChild)

    // If relative path is empty, they are the same
    // If relative path starts with '..', child is not inside parent
    // If relative path is absolute, child is not inside parent
    return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
  } catch (error) {
    logger.error('Failed to check path relationship:', error as Error)
    return false
  }
}

export function getFileType(ext: string): FileTypes {
  ext = ext.toLowerCase()
  return fileTypeMap.get(ext) || FileTypes.OTHER
}

export function getFileDir(filePath: string) {
  return path.dirname(filePath)
}

export function getFileName(filePath: string) {
  return path.basename(filePath)
}

export function getFileExt(filePath: string) {
  return path.extname(filePath)
}

export function getAllFiles(dirPath: string, arrayOfFiles: FileMetadata[] = []): FileMetadata[] {
  const files = fs.readdirSync(dirPath)

  files.forEach((file) => {
    if (file.startsWith('.')) {
      return
    }

    const fullPath = path.join(dirPath, file)
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles)
    } else {
      const ext = path.extname(file)
      const fileType = getFileType(ext)

      if ([FileTypes.OTHER, FileTypes.IMAGE, FileTypes.VIDEO, FileTypes.AUDIO].includes(fileType)) {
        return
      }

      const name = path.basename(file)
      const stats = fs.statSync(fullPath)
      const size = stats.size

      const fileItem: FileMetadata = {
        id: uuidv4(),
        name,
        path: fullPath,
        size,
        ext,
        count: 1,
        origin_name: name,
        type: fileType,
        created_at: stats.birthtime.toISOString(),
        mtime: stats.mtime.getTime()
      }

      arrayOfFiles.push(fileItem)
    }
  })

  return arrayOfFiles
}

export function getTempDir() {
  return path.join(app.getPath('temp'), 'Read-No-More')
}

export function getFilesDir() {
  return path.join(app.getPath('userData'), 'Data', 'Files')
}

/**
 * 获取 TextBooks 目录（程序目录下）
 */
export function getTextBooksDir() {
  // 打包后：与 exe 同目录（setup/portable 都需要读写这里的 TextBooks）
  // 开发态：electron 的 exe 在 node_modules/electron/dist，不能用它作为“程序目录”
  const baseDir = (() => {
    if (app.isPackaged) return path.dirname(app.getPath('exe'))

    const hasPackageJson = (dir: string) => fs.existsSync(path.join(dir, 'package.json'))

    // 优先 cwd（通常是项目根目录），其次尝试 appPath 的上级目录（兼容某些 dev server 场景）
    const cwd = process.cwd()
    if (hasPackageJson(cwd)) return cwd

    const appPath = app.getAppPath()
    const candidates = [appPath, path.join(appPath, '..'), path.join(appPath, '..', '..')]
    for (const candidate of candidates) {
      if (candidate.includes('node_modules')) continue
      if (hasPackageJson(candidate)) return candidate
    }

    return cwd
  })()

  const textBooksDir = path.join(baseDir, 'TextBooks')
  if (!fs.existsSync(textBooksDir)) {
    fs.mkdirSync(textBooksDir, { recursive: true })
    logger.info(`TextBooks directory created at: ${textBooksDir}`)
  }
  return textBooksDir
}

/**
 * 生成安全的文件夹名称（处理特殊字符）
 * @param bookTitle 书籍标题
 * @returns 安全的文件夹名称
 */
export function sanitizeFolderName(bookTitle: string): string {
  // 移除或替换 Windows/Linux 不允许的文件名字符
  // Windows: < > : " / \ | ? *
  // 同时移除控制字符和前后空格
  return bookTitle
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')  // 替换特殊字符为下划线
    .replace(/\s+/g, ' ')                     // 多个空格合并为一个
    .trim()                                   // 移除前后空格
    .slice(0, 200)                            // 限制长度（Windows路径限制）
    || '未命名'                                // 如果为空则使用默认名称
}

/**
 * 生成唯一的文件夹名称（处理重名）
 * @param baseDir 基础目录
 * @param folderName 期望的文件夹名称
 * @returns 唯一的文件夹名称
 */
export function getUniqueFolderName(baseDir: string, folderName: string): string {
  const safeName = sanitizeFolderName(folderName)
  let uniqueName = safeName
  let counter = 1

  // 检查文件夹是否存在，如果存在则添加编号
  while (fs.existsSync(path.join(baseDir, uniqueName))) {
    counter++
    uniqueName = `${safeName}(${counter})`
  }

  return uniqueName
}

export function getNotesDir() {
  const notesDir = path.join(app.getPath('userData'), 'Data', 'Notes')
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true })
    logger.info(`Notes directory created at: ${notesDir}`)
  }
  return notesDir
}

export function getConfigDir() {
  return path.join(os.homedir(), '.readnomore', 'config')
}

export function getCacheDir() {
  return path.join(app.getPath('userData'), 'Cache')
}

export function getAppConfigDir(name: string) {
  return path.join(getConfigDir(), name)
}

export function getMcpDir() {
  return path.join(os.homedir(), '.readnomore', 'mcp')
}

/**
 * 读取文件内容并自动检测编码格式进行解码
 * @param filePath - 文件路径
 * @returns 解码后的文件内容
 * @throws 如果路径不存在抛出错误
 */
export async function readTextFileWithAutoEncoding(
  filePath: string
): Promise<{ content: string; encoding: string }> {
  const buffer = await readFile(filePath)

  // 性能优化：只使用前64KB进行编码检测，对于大文件可以显著提升性能
  const SAMPLE_SIZE = 64 * 1024 // 64KB
  const sampleBuffer = buffer.length > SAMPLE_SIZE ? buffer.subarray(0, SAMPLE_SIZE) : buffer

  // The chardet library's detect function returns the encoding name as a string or null.
  const detectedEncoding = chardet.detect(sampleBuffer)
  let content = ''
  let encoding = 'utf-8'

  if (detectedEncoding) {
    encoding = detectedEncoding.toLowerCase()
    logger.info(`Detected file encoding: ${encoding} for ${filePath}`)
  } else {
    logger.warn(`Could not detect encoding for ${filePath}, trying GBK and UTF-8 fallback.`)
    // 对于回退检测，也只使用样本进行判断
    const gbkSample = iconv.decode(sampleBuffer, 'gbk')
    const utf8Sample = sampleBuffer.toString('utf-8')
    const gbkInvalidChars = (gbkSample.match(/�/g) || []).length
    const utf8InvalidChars = (utf8Sample.match(/�/g) || []).length

    if (gbkInvalidChars < utf8InvalidChars) {
      encoding = 'gbk'
      // 使用完整buffer解码内容
      content = iconv.decode(buffer, 'gbk')
      logger.info(`Fallback for ${filePath} decided on GBK due to fewer replacement characters.`)
    } else {
      encoding = 'utf-8'
      content = buffer.toString('utf-8')
      logger.info(`Fallback for ${filePath} decided on UTF-8.`)
    }
  }

  if (!content) {
    try {
      if (encoding.startsWith('gb') || encoding === 'windows-1252') {
        content = iconv.decode(buffer, 'gbk')
      } else {
        content = buffer.toString(encoding as BufferEncoding)
      }
    } catch (e) {
      logger.error(`Failed to decode ${filePath} with detected encoding ${encoding}, falling back to utf-8.`, e as Error)
      content = buffer.toString('utf-8') // Final fallback
      encoding = 'utf-8'
    }
  }

  if (content.includes('�')) {
    logger.warn(
      `Decoded content for ${filePath} contains replacement characters (�), which may indicate an incorrect encoding was used.`
    )
  }

  return { content, encoding }
}

export async function base64Image(file: FileMetadata): Promise<{ mime: string; base64: string; data: string }> {
  const filePath = path.join(getFilesDir(), `${file.id}${file.ext}`)
  const data = await fs.promises.readFile(filePath)
  const base64 = data.toString('base64')
  const ext = path.extname(filePath).slice(1) == 'jpg' ? 'jpeg' : path.extname(filePath).slice(1)
  const mime = `image/${ext}`
  return {
    mime,
    base64,
    data: `data:${mime};base64,${base64}`
  }
}

/**
 * 递归扫描目录，获取符合条件的文件和目录结构
 * @param dirPath 当前要扫描的路径
 * @param depth 当前深度
 * @param basePath
 * @returns 文件元数据数组
 */
export async function scanDir(dirPath: string, depth = 0, basePath?: string): Promise<NotesTreeNode[]> {
  const options = {
    includeFiles: true,
    includeDirectories: true,
    fileExtensions: ['.md'],
    ignoreHiddenFiles: true,
    recursive: true,
    maxDepth: 10
  }

  // 如果是第一次调用，设置basePath为当前目录
  if (!basePath) {
    basePath = dirPath
  }

  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return []
  }

  if (!fs.existsSync(dirPath)) {
    loggerService.withContext('Utils:File').warn(`Dir not exist: ${dirPath}`)
    return []
  }

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  const result: NotesTreeNode[] = []

  for (const entry of entries) {
    if (options.ignoreHiddenFiles && entry.name.startsWith('.')) {
      continue
    }

    const entryPath = path.join(dirPath, entry.name)

    const relativePath = path.relative(basePath, entryPath)
    const treePath = '/' + relativePath.replace(/\\/g, '/')

    if (entry.isDirectory() && options.includeDirectories) {
      const stats = await fs.promises.stat(entryPath)
      const dirTreeNode: NotesTreeNode = {
        id: uuidv4(),
        name: entry.name,
        treePath: treePath,
        externalPath: entryPath,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
        type: 'folder',
        children: [] // 添加 children 属性
      }

      // 如果启用了递归扫描，则递归调用 scanDir
      if (options.recursive) {
        dirTreeNode.children = await scanDir(entryPath, depth + 1, basePath)
      }

      result.push(dirTreeNode)
    } else if (entry.isFile() && options.includeFiles) {
      const ext = path.extname(entry.name).toLowerCase()
      if (options.fileExtensions.length > 0 && !options.fileExtensions.includes(ext)) {
        continue
      }

      const stats = await fs.promises.stat(entryPath)
      const name = entry.name.endsWith(options.fileExtensions[0])
        ? entry.name.slice(0, -options.fileExtensions[0].length)
        : entry.name

      // 对于文件，treePath应该使用不带扩展名的路径
      const nameWithoutExt = path.basename(entryPath, path.extname(entryPath))
      const dirRelativePath = path.relative(basePath, path.dirname(entryPath))
      const fileTreePath = dirRelativePath
        ? `/${dirRelativePath.replace(/\\/g, '/')}/${nameWithoutExt}`
        : `/${nameWithoutExt}`

      const fileTreeNode: NotesTreeNode = {
        id: uuidv4(),
        name: name,
        treePath: fileTreePath,
        externalPath: entryPath,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
        type: 'file'
      }
      result.push(fileTreeNode)
    }
  }

  return result
}

/**
 * 文件名唯一性约束
 * @param baseDir 基础目录
 * @param fileName 文件名
 * @param isFile 是否为文件
 * @returns 唯一的文件名
 */
export function getName(baseDir: string, fileName: string, isFile: boolean): string {
  // 首先清理文件名
  const baseName = sanitizeFilename(fileName)
  let candidate = isFile ? baseName + '.md' : baseName
  let counter = 1

  while (fs.existsSync(path.join(baseDir, candidate))) {
    candidate = isFile ? `${baseName}${counter}.md` : `${baseName}${counter}`
    counter++
  }

  return isFile ? candidate.slice(0, -3) : candidate
}

/**
 * 文件名合法性校验
 * @param fileName 文件名
 * @param platform 平台，默认为当前运行平台
 * @returns 验证结果
 */
export function validateFileName(fileName: string, platform = process.platform): { valid: boolean; error?: string } {
  if (!fileName) {
    return { valid: false, error: 'File name cannot be empty' }
  }

  // 通用检查
  if (fileName.length === 0 || fileName.length > 255) {
    return { valid: false, error: 'File name length must be between 1 and 255 characters' }
  }

  // 检查 null 字符（所有系统都不允许）
  if (fileName.includes('\0')) {
    return { valid: false, error: 'File name cannot contain null characters.' }
  }

  // Windows 特殊限制
  if (platform === 'win32') {
    const winInvalidChars = /[<>:"/\\|?*]/
    if (winInvalidChars.test(fileName)) {
      return { valid: false, error: 'File name contains characters not supported by Windows: < > : " / \\ | ? *' }
    }

    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i
    if (reservedNames.test(fileName)) {
      return { valid: false, error: 'File name is a Windows reserved name.' }
    }

    if (fileName.endsWith('.') || fileName.endsWith(' ')) {
      return { valid: false, error: 'File name cannot end with a dot or a space' }
    }
  }

  // Unix/Linux/macOS 限制
  if (platform !== 'win32') {
    if (fileName.includes('/')) {
      return { valid: false, error: 'File name cannot contain slashes /' }
    }
  }

  // macOS 额外限制
  if (platform === 'darwin') {
    if (fileName.includes(':')) {
      return { valid: false, error: 'macOS filenames cannot contain a colon :' }
    }
  }

  return { valid: true }
}

/**
 * 文件名合法性检查
 * @param fileName 文件名
 * @throws 如果文件名不合法则抛出异常
 * @returns 合法的文件名
 */
export function checkName(fileName: string): string {
  const baseName = path.basename(fileName)
  const validation = validateFileName(baseName)
  if (!validation.valid) {
    // 自动清理非法字符，而不是抛出错误
    const sanitized = sanitizeFilename(baseName)
    logger.warn(`File name contains invalid characters, auto-sanitized: "${baseName}" -> "${sanitized}"`)
    return sanitized
  }
  return baseName
}

/**
 * 清理文件名，替换不合法字符
 * @param fileName 原始文件名
 * @param replacement 替换字符，默认为下划线
 * @returns 清理后的文件名
 */
export function sanitizeFilename(fileName: string, replacement = '_'): string {
  if (!fileName) return ''

  // 移除或替换非法字符
  let sanitized = fileName
    // oxlint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, replacement) // Windows 非法字符
    .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i, replacement + '$2') // Windows 保留名
    .replace(/[\s.]+$/, '') // 移除末尾的空格和点
    .substring(0, 255) // 限制长度

  // 确保不为空
  if (!sanitized) {
    sanitized = 'untitled'
  }

  return sanitized
}
