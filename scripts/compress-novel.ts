import type { ModelMessage } from 'ai'
import chardet from 'chardet'
import { promises as fs } from 'fs'
import iconv from 'iconv-lite'
import path from 'path'

import {
  clearAllProviders,
  createAndRegisterProvider,
  ProviderConfigFactory,
  type ProviderId
} from '../packages/aiCore/src/core/providers'
import { createExecutor } from '../packages/aiCore/src/core/runtime'

type CliOptions = {
  input: string
  output?: string
  ratio: number
  chunkSize: number
  overlap: number
  provider: ProviderId
  model: string
  apiKey: string
  baseUrl?: string
  temperature: number
}

type Chunk = {
  index: number
  text: string
  start: number
  end: number
  targetLength: number
}

async function readTextFileWithAutoEncoding(filePath: string): Promise<{ content: string; encoding: string }> {
  const detected = (await chardet.detectFile(filePath, { sampleSize: 256 * 1024 })) || 'UTF-8'
  const candidates = Array.from(new Set([detected, 'UTF-8', 'GB18030', 'Big5']))
  const buffer = await fs.readFile(filePath)

  for (const encoding of candidates) {
    try {
      const content = iconv.decode(buffer, encoding)
      if (!content.includes('\uFFFD')) {
        return { content: content.replace(/\r\n/g, '\n'), encoding }
      }
    } catch (error) {
      // ignore and try next encoding
    }
  }

  const fallback = buffer.toString('utf8')
  return { content: fallback.replace(/\r\n/g, '\n'), encoding: 'UTF-8 (fallback)' }
}

function splitTextIntoChunks(text: string, chunkSize: number, overlap: number, ratio: number): Chunk[] {
  const chunks: Chunk[] = []
  let start = 0
  let index = 0

  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize)
    const chunkText = text.slice(start, end).trim()

    if (chunkText.length > 0) {
      const targetLength = Math.max(120, Math.round(chunkText.length * ratio))
      chunks.push({ index, text: chunkText, start, end, targetLength })
      index += 1
    }

    if (end === text.length) {
      break
    }

    start = end - overlap
    if (start <= 0) {
      start = end
    }
  }

  return chunks
}

function parseRatio(value: string): number {
  if (value.endsWith('%')) {
    return Number.parseFloat(value.slice(0, -1)) / 100
  }
  return Number.parseFloat(value)
}

function parseNumber(value: string, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function showHelp(): void {
  console.log(`用法: yarn compress:novel --input <输入文件> [选项]

必选参数:
  --input <path>          待压缩的 TXT 文件路径

可选参数:
  --output <path>         输出文件路径，默认与输入文件同名增加 .compressed.txt
  --ratio <0-1|百分比>    压缩比例，默认 0.2 (20%)，支持例如 0.15 或 15%
  --chunk-size <number>   每个片段的最大字数，默认 3200
  --overlap <number>      分块重叠字数，默认 200
  --provider <id>         使用的模型提供方，默认 openai
  --model <name>          模型名称，默认 gpt-4o-mini
  --api-key <key>         指定 API Key，默认读取环境变量 NOVEL_COMPRESS_API_KEY 或 OPENAI_API_KEY
  --base-url <url>        自定义兼容接口地址，可选
  --temperature <number>  采样温度，默认 0.4
  --help                  显示本帮助信息
`)
}

function parseArgs(argv: string[]): CliOptions {
  const defaults = {
    ratio: 0.2,
    chunkSize: 3200,
    overlap: 200,
    provider: 'openai' as ProviderId,
    model: 'gpt-4o-mini',
    temperature: 0.4
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    showHelp()
    process.exit(0)
  }

  const options: Partial<CliOptions> = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = arg.includes('=') ? arg.split('=')[1] : next

    switch (key) {
      case 'input':
        options.input = value
        if (!arg.includes('=') && next) i += 1
        break
      case 'output':
        options.output = value
        if (!arg.includes('=') && next) i += 1
        break
      case 'ratio':
        if (!value) break
        options.ratio = Number.isFinite(Number(value)) || value.endsWith('%') ? parseRatio(value) : defaults.ratio
        if (!arg.includes('=') && next) i += 1
        break
      case 'chunk-size':
        if (!value) break
        options.chunkSize = parseNumber(value, defaults.chunkSize)
        if (!arg.includes('=') && next) i += 1
        break
      case 'overlap':
        if (!value) break
        options.overlap = parseNumber(value, defaults.overlap)
        if (!arg.includes('=') && next) i += 1
        break
      case 'provider':
        if (!value) break
        options.provider = value as ProviderId
        if (!arg.includes('=') && next) i += 1
        break
      case 'model':
        if (!value) break
        options.model = value
        if (!arg.includes('=') && next) i += 1
        break
      case 'api-key':
        if (!value) break
        options.apiKey = value
        if (!arg.includes('=') && next) i += 1
        break
      case 'base-url':
        if (!value) break
        options.baseUrl = value
        if (!arg.includes('=') && next) i += 1
        break
      case 'temperature':
        if (!value) break
        const parsed = Number.parseFloat(value)
        options.temperature = Number.isFinite(parsed) ? parsed : defaults.temperature
        if (!arg.includes('=') && next) i += 1
        break
      default:
        break
    }
  }

  if (!options.input) {
    console.error('缺少必填参数 --input')
    showHelp()
    process.exit(1)
  }

  const apiKey =
    options.apiKey ||
    process.env.NOVEL_COMPRESS_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    console.error('未找到可用的 API Key，请使用 --api-key 或设置 NOVEL_COMPRESS_API_KEY / OPENAI_API_KEY 环境变量')
    process.exit(1)
  }

  return {
    input: options.input,
    output: options.output,
    ratio: options.ratio ?? defaults.ratio,
    chunkSize: options.chunkSize ?? defaults.chunkSize,
    overlap: options.overlap ?? defaults.overlap,
    provider: options.provider ?? defaults.provider,
    model: options.model ?? defaults.model,
    apiKey,
    baseUrl: options.baseUrl,
    temperature: options.temperature ?? defaults.temperature
  }
}

function buildMessages(chunk: Chunk, ratio: number): ModelMessage[] {
  const ratioPercent = Math.round(ratio * 100)
  const systemPrompt =
    '你是一名资深小说编辑，擅长在保持叙事逻辑和人物性格的前提下，将长篇文本压缩为紧凑的中文段落。请保留故事主线、关键事件与情感张力，确保语言流畅自然。'
  const userPrompt = `请将以下内容压缩到原文字数的约 ${ratioPercent}%（目标字数约 ${chunk.targetLength} 字），要求：
1. 保留人物名称、称谓与关键事件。
2. 保持时间顺序与因果关系清晰。
3. 避免添加与原文不一致的情节或设定。
4. 输出为自然流畅的中文段落，不要添加额外解释、标题或列表。

原文片段：
${chunk.text}`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
}

async function prepareProvider(provider: ProviderId, apiKey: string, baseUrl?: string) {
  clearAllProviders()

  const builder = ProviderConfigFactory.builder(provider)
  if (apiKey) {
    builder.withApiKey(apiKey as string)
  }
  if (baseUrl) {
    builder.withBaseURL(baseUrl)
  }
  const providerOptions = builder.build()

  const registered = await createAndRegisterProvider(provider, providerOptions)
  if (!registered) {
    throw new Error(`注册模型提供方 ${provider} 失败，请检查配置`)
  }

  return providerOptions
}

async function compressNovel(options: CliOptions) {
  const inputPath = path.resolve(process.cwd(), options.input)
  const inputStat = await fs.stat(inputPath)
  if (!inputStat.isFile()) {
    throw new Error(`输入路径不是文件: ${inputPath}`)
  }

  const outputPath = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.compressed.txt`)

  const { content, encoding } = await readTextFileWithAutoEncoding(inputPath)
  console.log(`📖 读取完成，检测到编码 ${encoding}，原文长度 ${content.length} 字`)

  const normalizedRatio = Math.min(Math.max(options.ratio, 0.05), 0.9)
  const normalizedChunkSize = Math.max(500, options.chunkSize)
  const normalizedOverlap = Math.min(Math.max(options.overlap, 0), normalizedChunkSize - 1)

  const chunks = splitTextIntoChunks(content, normalizedChunkSize, normalizedOverlap, normalizedRatio)
  if (chunks.length === 0) {
    throw new Error('未能切分出有效文本，请检查输入内容')
  }
  console.log(
    `✂️  已分块 ${chunks.length} 个片段，每块约 ${normalizedChunkSize} 字，重叠 ${normalizedOverlap} 字，目标比例 ${(normalizedRatio * 100).toFixed(1)}%`
  )

  const providerOptions = await prepareProvider(options.provider, options.apiKey, options.baseUrl)
  const executor = createExecutor(options.provider, { ...providerOptions, mode: 'chat' })

  const compressedResults: string[] = []

  for (const chunk of chunks) {
    console.log(`⚙️  正在压缩第 ${chunk.index + 1}/${chunks.length} 块 ...`)
    const messages = buildMessages(chunk, normalizedRatio)
    const response = await executor.generateText({
      model: options.model,
      messages,
      temperature: options.temperature,
      maxOutputTokens: Math.max(256, Math.round(chunk.targetLength * 1.5))
    })
    compressedResults.push(response.text.trim())
  }

  const merged = compressedResults.join('\n\n')
  await fs.writeFile(outputPath, merged, 'utf8')

  console.log('✅ 压缩完成')
  console.log(`➡️  输出路径: ${outputPath}`)
  console.log(`ℹ️  压缩后约 ${merged.length} 字，约为原始长度 ${(merged.length / content.length * 100).toFixed(2)}%`)
  console.log('📝 请随机抽查若干段落，确认人物与剧情未缺失。')
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    await compressNovel(options)
  } catch (error) {
    console.error('❌ 执行失败:', (error as Error).message)
    process.exit(1)
  }
}

main()
