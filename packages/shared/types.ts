export type ModelType = 'text' | 'vision' | 'embedding' | 'reasoning' | 'function_calling' | 'web_search' | 'rerank'

export type EndpointType = 'openai' | 'openai-response' | 'anthropic' | 'gemini' | 'image-generation' | 'jina-rerank'

export type ModelPricing = {
  input_per_million_tokens: number
  output_per_million_tokens: number
  currencySymbol?: string
}

export type ModelCapability = {
  type: ModelType
  isUserSelected?: boolean
}

export type Model = {
  id: string
  provider: string
  name: string
  group: string
  owned_by?: string
  description?: string
  capabilities?: ModelCapability[]
  type?: ModelType[]
  pricing?: ModelPricing
  endpoint_type?: EndpointType
  supported_endpoint_types?: EndpointType[]
  supported_text_delta?: boolean
}

/**
 * Runtime config injected by Electron host for gist-video backend.
 *
 * Notes:
 * - Contains sensitive data (apiKey). Do NOT persist to disk.
 * - Used to pass provider credentials to the local Python backend via env.
 */
export type GistVideoRuntimeConfig = {
  visionApiBase?: string
  visionApiKey?: string
}

export enum FileTypes {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  TEXT = 'text',
  DOCUMENT = 'document',
  OTHER = 'other'
}

export interface FileMetadata {
  id: string
  name: string
  origin_name: string
  path: string
  size: number
  ext: string
  type: FileTypes
  created_at: string
  mtime: number
  count: number
  tokens?: number
  purpose?: string
  charLength?: number
  preview?: string
}

// =================================================================
// Chapter-Based Chunking Types (章节分块相关类型)
// =================================================================

/**
 * 章节信息
 */
export interface ChapterInfo {
  index: number           // 章节索引 (0-based)
  title: string           // 章节标题 (如 "第一章 开始")
  startOffset: number     // 在原文中的起始字节位置
  endOffset: number       // 在原文中的结束字节位置
}

/**
 * 章节识别结果
 */
export interface ChapterParseResult {
  success: boolean
  totalChapters: number
  chapters: ChapterInfo[]
  usedRule: string        // 使用的规则名称
  error?: string
}

/**
 * 分块模式
 */
export type ChunkMode = 'bySize' | 'byChapter'

/**
 * 按章节分块的单个分块信息
 */
export interface ChapterChunk {
  index: number                 // 分块索引
  chapters: ChapterInfo[]       // 包含的章节列表
  text: string                  // 分块文本内容
}

// =================================================================
// Novel Compression Shared Types
// =================================================================

export type TextCategory = 'academic' | 'novel' | 'discussion'

export type CompressionStage =
  | 'idle'
  | 'initializing'
  | 'compressing'
  | 'finalizing'
  | 'failed'
  | 'cancelled'
  | 'completed'

export interface CompressionProgress {
  current: number
  total: number
  percentage: number
  stage: CompressionStage
}

export interface CompressionUsageMetrics {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  requests?: number
}

export interface CompressionChunk {
  index: number
  text: string
  targetLength: number
  compressed?: string
  model?: string
  usage?: CompressionUsageMetrics
  durationMs?: number
  retries?: number
  chapterTitles?: string[]  // 章节模式：该分块包含的章节标题
}

export interface NovelCompressionResult {
  merged: string
  chunks: CompressionChunk[]
  characterProfiles?: Record<string, string>  // 保持向后兼容（传统模式）
  characterMatrix?: CharacterPlotMatrix       // 新增：矩阵模式数据
}

export interface CompressionLogEntry {
  id: string
  level: 'info' | 'warning' | 'error' | 'retry'
  message: string
  timestamp: number
  data?: any
}

export interface ChunkSummary {
  index: number
  status: 'pending' | 'processing' | 'completed' | 'error'
  inputLength: number
  targetLength: number
  outputLength?: number
  usage?: CompressionUsageMetrics
  durationMs?: number
  startedAt?: number
  finishedAt?: number
  errorMessage?: string
}

export interface ChunkDetectionInfo {
  hasChunks: boolean
  chunkCount: number
  missingChunks: number[]
}

export interface ModelHealthStat {
  index: number           // 模型索引
  model: string          // 模型名称
  provider: string       // 提供商ID
  baseUrl: string        // API端点
  successRate: string    // 成功率（格式化字符串，如 "95%"）
  successes: number      // 成功次数
  failures: number       // 失败次数
  total: number          // 总尝试次数
  healthy: boolean       // 是否健康
  lastError?: string     // 最后一次失败的错误信息
}

// =================================================================
// Character Plot Matrix Types (人物志矩阵相关类型)
// =================================================================

/**
 * 角色信息
 */
export interface Character {
  displayName: string      // 显示名称："石昊（小不点）"
  canonicalName: string    // 规范名称："石昊"
  aliases: string[]        // 别名：["小不点", "荒"]
  firstAppearance: number  // 首次出场的分块索引
}

/**
 * 单个分块的角色剧情分析结果
 */
export interface ChunkCharacterPlotAnalysis {
  chunkIndex: number
  chunkName: string  // "第1节"
  characterPlots: Record<string, string>  // 角色显示名 -> 剧情摘要（整段模式）
  characterPlotsByChapter?: Record<string, Record<string, string>>  // 角色 -> {章节标题 -> 剧情}（章节模式）
}

/**
 * 角色-剧情矩阵（最终输出）
 */
export interface CharacterPlotMatrix {
  characters: Character[]                    // 所有角色列表
  chunks: ChunkCharacterPlotAnalysis[]       // 所有分块分析
  matrix: string[][]                         // [角色索引][分块索引] = 剧情文本
  metadata: {
    totalCharacters: number
    totalChunks: number
    generatedAt: number
  }
}

/**
 * 人物志输出格式（JSON 会自动生成，这里只选择附加格式）
 */
export type CharacterOutputFormat = 'markdown' | 'csv' | 'html'

/**
 * 分块分析文件格式（用于断点续传）
 */
export interface ChunkAnalysisFile {
  chunkIndex: number
  chunkName: string
  chunkHash: string  // 原文hash，用于验证内容是否变化
  characterPlots: Record<string, string>
  metadata: {
    analyzedAt: number
    modelId: string
    temperature: number
    durationMs: number
  }
}

/**
 * 元数据文件（用于断点续传验证）
 */
export interface CharacterAnalysisMetadata {
  version: string  // 格式版本号
  sourceFile: string
  sourceFileHash: string
  totalChunks: number
  chunkSize: number
  overlap: number
  createdAt: number
  lastUpdatedAt: number
}

/**
 * 进度文件（用于断点续传）
 */
export interface CharacterAnalysisProgress {
  completedChunks: number[]
  failedChunks: number[]
  totalChunks: number
  lastChunkIndex: number
  canResume: boolean
}

/**
 * 指定人物配置
 * 用于控制是否只分析特定角色的剧情
 */
export interface CharacterTargetConfig {
  enabled: boolean           // 是否启用指定人物模式
  characters: string[]       // 指定的人物列表（如：["张三", "李四(老李)"]）
}

/**
 * Represents the complete, shareable state of the Novel Compression UI.
 * This state is managed in the main process and synchronized with the renderer process.
 */
export interface NovelCompressionState {
  // Settings
  selectedModel: Model | null
  selectedModels: Model[]
  enableMultiModel: boolean
  ratioPercent: number
  chunkSize: number
  overlap: number
  temperature: number
  maxConcurrency: number  // 每个模型的最大并发数
  category: TextCategory
  enableAutoClassification: boolean
  
  // Character Analysis Settings
  characterMode: 'traditional' | 'matrix'  // 人物志模式：traditional=文学性, matrix=矩阵模式
  characterOutputFormat: CharacterOutputFormat  // 矩阵输出格式
  targetCharacters: string[]  // 传统模式：用户指定的目标角色列表
  targetCharacterConfig: CharacterTargetConfig | null  // 指定人物配置（新功能）

  // Chapter-Based Chunking Settings (章节分块设置)
  chunkMode: ChunkMode                              // 分块模式：'bySize' | 'byChapter'
  chaptersPerChunk: number                          // 每块包含的章节数（默认3）
  chapterParseResult: ChapterParseResult | null     // 章节识别结果

  // File & Content
  selectedFile: FileMetadata | null
  // rawContent is intentionally omitted as it's too large for frequent IPC.
  // The main process reads it from the file path when a task starts.
  preview: string // A small preview can be kept in state for quick display.
  outputPath: string
  inputText?: string // For direct text input without a file
  mergedContent: string

  // Process State
  isProcessing: boolean
  progress: CompressionProgress | null
  result: NovelCompressionResult | null
  logs: CompressionLogEntry[]
  chunkSummaries: ChunkSummary[]
  debugInfo: any | null
  isClassifying?: boolean
  modelHealthStats: ModelHealthStat[] | null  // 模型池健康度统计

  // Resume Logic
  canResume: boolean
  chunkInfo: ChunkDetectionInfo | null
  continueLatestTask: boolean
  
  // Auto Resume
  enableAutoResume: boolean // 失败自动重试：失败时自动重试
  autoResumeAttempts: number
}

// =================================================================
// Novel Outline Types (大纲提取器相关类型)
// =================================================================

/**
 * 固定的大纲结构（一级、二级、三级固定，四级及以下由模型自由发挥）
 */
export interface OutlineStructure {
  '世界观/背景': {
    时代: Record<string, any>
    世界格局: Record<string, any>
    核心矛盾: Record<string, any>
    力量体系: {
      能量来源: Record<string, any>
      修炼境界: Record<string, any>
    }
    特殊设定: Record<string, any>
  }
  '功法与武技': {
    功法: {
      名称: Record<string, any>
      描述: Record<string, any>
    }
    '武技/法术': {
      名称: Record<string, any>
      描述: Record<string, any>
    }
  }
  '势力分布': {
    势力全称: Record<string, any>
    空间坐标: {
      '位面/宇宙': Record<string, any>
      '大陆/星域': Record<string, any>
      '疆域/国度': Record<string, any>
      '州/郡/省': Record<string, any>
      '具体地点': Record<string, any>
    }
    势力评级: Record<string, any>
    势力类型: Record<string, any>
    核心简介: {
      一句话定位: Record<string, any>
      实力构成: Record<string, any>
      标志性特征: Record<string, any>
      与主角关系: Record<string, any>
    }
  }
  '主角设定': {
    主角: Record<string, any>
    外貌: Record<string, any>
    性格和动机: Record<string, any>
    '金手指/外挂': Record<string, any>
    成长弧光: Record<string, any>
  }
  '配角': {
    主要配角: {
      姓名: Record<string, any>
      来自哪里: Record<string, any>
      '与主角关系描述（主要是正面或中性）': Record<string, any>
    }
    反派: {
      姓名: Record<string, any>
      来自哪里: Record<string, any>
      '与主角关系描述（主要是负面）': Record<string, any>
    }
  }
  '剧情结构': Record<string, any>
}

/**
 * 单个分块的大纲提取结果
 */
export interface OutlineChunkResult {
  chunkIndex: number
  chunkName: string
  outline: OutlineStructure
}

/**
 * 最终大纲结果
 */
export interface NovelOutlineResult {
  chunks: OutlineChunkResult[]
  merged: OutlineStructure
  final: string  // Markdown格式
  metadata?: {
    version: string
    createdAt: number
    models: string[]
    chunkCount: number
  }
}

export interface NovelOutlineState {
  // Settings
  selectedModel: Model | null
  selectedModels: Model[]
  enableMultiModel: boolean
  chunkSize: number
  overlap: number
  temperature: number
  maxConcurrency: number
  category: TextCategory

  // Prompt Settings
  useCustomPrompts: boolean
  customExtractionPrompt: string
  customSynthesisPrompt: string
  customWorldviewPrompt: string        // 二次总结：世界观/背景
  customProtagonistPrompt: string      // 二次总结：主角设定
  customTechniquesPrompt: string       // 二次总结：功法与武技
  customFactionsPrompt: string         // 二次总结：势力分布
  customCharactersPrompt: string       // 二次总结：配角

  // File & Content
  selectedFile: FileMetadata | null
  preview: string
  outputPath: string
  inputText?: string

  // Process State
  isProcessing: boolean
  progress: CompressionProgress | null
  logs: CompressionLogEntry[]
  chunkSummaries: ChunkSummary[]
  chunkResults: OutlineChunkResult[]
  mergedOutline: OutlineStructure | null
  result: NovelOutlineResult | null
  error?: string
  modelHealthStats: ModelHealthStat[] | null

  // Resume Logic
  canResume: boolean
  chunkInfo: ChunkDetectionInfo | null
  continueLatestTask: boolean

  // Auto Resume
  enableAutoResume: boolean
  autoResumeAttempts: number
}


// =================================================================
// Text Editor Library Types (文案编辑图书库相关类型)
// =================================================================

/**
 * 图书元数据
 */
export interface TextBook {
  id: string                    // 唯一标识符 (UUID)
  title: string                 // 显示标题
  originalFileName: string      // 原始文件名
  folderName: string           // 文件夹名称（基于书名，处理特殊字符）
  folderPath: string           // 图书文件夹路径（可被运行时修复）
  filePath: string             // TXT文件路径（可被运行时修复）
  relativeFilePath?: string    // 相对 TextBooks 根目录的路径（推荐使用，支持整体搬迁）
  createdAt: string            // 导入时间 (ISO 8601)
  updatedAt: string            // 最后更新时间
  fileSize: number             // 文件大小 (bytes)
  charCount?: number           // 字符数 (可选)
}

/**
 * 图书配置文件结构
 */
export interface BookConfig {
  id: string
  title: string
  originalFileName: string
  createdAt: string
  updatedAt: string
  fileSize: number
  charCount: number
  chapters?: ReaderChapter[]
  chaptersParsedAt?: string
  encodingConverted?: boolean
}

// =================================================================
// TXT Reader Types (TXT阅读器相关类型)
// =================================================================

/**
 * 阅读器章节信息
 */
export interface ReaderChapter {
  id: string              // 章节唯一标识
  title: string           // 章节标题
  startIndex: number      // 在原文中的起始位置
  endIndex: number        // 在原文中的结束位置
  level: number           // 章节层级（1=章，2=节）
}

/**
 * 章节解析结果
 */
export interface ReaderChapterParseResult {
  chapters: ReaderChapter[]
  parsedAt: string        // 解析时间
  usedRule?: string
  totalChapters?: number
  durationMs?: number
}

/**
 * 侧边栏显示模式
 */
export type ReaderSidebarMode = 'fixed' | 'hover'

/**
 * 阅读器用户偏好设置
 */
export interface ReaderPreferences {
  sidebarMode: ReaderSidebarMode
}

/**
 * 图书库状态
 */
export interface TextEditorLibraryState {
  books: TextBook[]            // 图书列表
  isLoading: boolean           // 加载状态
  error: string | null         // 错误信息
}
