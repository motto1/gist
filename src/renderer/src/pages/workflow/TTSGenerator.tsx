import { Button, Card, CardBody, Input, Select, SelectItem, Tooltip } from '@heroui/react'
import { ArrowLeft, Download, FileText, Mic, Play, Settings2 } from 'lucide-react'
import { FC, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import DragBar from './components/DragBar'

const TTSGenerator: FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  // Retrieve data passed from CharacterWorkflow (or other sources)
  // Expecting state: { summary?: string, monologue?: string, characterName?: string, outputDir?: string }
  const { summary, monologue, characterName, outputDir } = (location.state as {
    summary?: string
    monologue?: string
    characterName?: string
    outputDir?: string
  }) || {}

  // Determine default source type
  // Prioritize summary if available, otherwise monologue, otherwise default to summary
  const [sourceType, setSourceType] = useState<'summary' | 'monologue'>(
    summary ? 'summary' : (monologue ? 'monologue' : 'summary')
  )

  // Derive current text based on selection
  const currentText = useMemo(() => {
    return sourceType === 'summary' ? summary : monologue
  }, [sourceType, summary, monologue])

  const [voice, setVoice] = useState('zh-CN-XiaoxiaoNeural')
  const [rate, setRate] = useState('+0%')
  const [pitch, setPitch] = useState('+0Hz')
  const [volume, setVolume] = useState('+0%')
  const [isGenerating, setIsGenerating] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioPath, setAudioPath] = useState<string | null>(null)

  const voices = [
    { value: 'zh-CN-XiaoxiaoNeural', label: 'Chinese (Mandarin) - Xiaoxiao (Female)' },
    { value: 'zh-CN-YunxiNeural', label: 'Chinese (Mandarin) - Yunxi (Male)' },
    { value: 'zh-CN-YunjianNeural', label: 'Chinese (Mandarin) - Yunjian (Male)' },
    { value: 'zh-CN-XiaoyiNeural', label: 'Chinese (Mandarin) - Xiaoyi (Female)' },
    { value: 'en-US-AriaNeural', label: 'English (US) - Aria (Female)' },
    { value: 'en-US-GuyNeural', label: 'English (US) - Guy (Male)' },
    { value: 'en-US-JennyNeural', label: 'English (US) - Jenny (Female)' },
    { value: 'ja-JP-NanamiNeural', label: 'Japanese - Nanami (Female)' },
    { value: 'ja-JP-KeitaNeural', label: 'Japanese - Keita (Male)' }
  ]

  const handleGenerate = useCallback(async () => {
    if (!currentText) return
    setIsGenerating(true)
    setAudioUrl(null)
    setAudioPath(null)

    try {
      const generateOptions: any = {
        text: currentText,
        voice,
        rate,
        pitch,
        volume
      }

      if (characterName && outputDir) {
         const audioDir = await window.api.path.join(outputDir, 'audio')
         const filename = `${characterName}_${sourceType === 'summary' ? 'bio' : 'monologue'}.mp3`
         generateOptions.outputDir = audioDir
         generateOptions.filename = filename
      }

      const result = await window.api.edgeTTS.generate(generateOptions)

      if (result.filePath) {
        setAudioPath(result.filePath)
        // Read file as base64 to play
        const base64 = await window.api.fs.read(result.filePath, 'base64')
        setAudioUrl(`data:audio/mp3;base64,${base64}`)
        window.toast?.success?.(t('workflow.tts.success', '生成成功'))
      }
    } catch (error) {
      console.error('TTS Generation failed:', error)
      window.toast?.error?.(t('workflow.tts.failed', '生成失败'))
    } finally {
      setIsGenerating(false)
    }
  }, [currentText, voice, rate, pitch, volume, t])

  const handleDownload = useCallback(() => {
    if (audioPath) {
      window.api.file.openPath(audioPath)
    }
  }, [audioPath])

  return (
    <>
      <DragBar />
      <div className="flex flex-col h-full w-full bg-background relative">
        {/* Header */}
        <div
          className="flex items-center gap-4 px-6 py-4 border-b border-foreground/10 relative z-10"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <h1 className="text-xl font-semibold">{t('workflow.tts.title', '语音生成 (Edge TTS)')}</h1>
        </div>

        <Tooltip content={t('workflow.character.stage3.prev', '上一步')} placement="right">
          <Button
            isIconOnly
            radius="full"
            variant="shadow"
            className="absolute left-6 top-1/2 -translate-y-1/2 h-12 w-12 z-20 shadow-lg"
            onPress={() => navigate(-1)}
            aria-label={t('workflow.character.stage3.prev', '上一步')}
          >
            <ArrowLeft size={20} />
          </Button>
        </Tooltip>

        <Tooltip content={isGenerating ? t('workflow.tts.generating', '生成中...') : t('workflow.tts.generate', '开始生成')} placement="left">
          <Button
            isIconOnly
            radius="full"
            color="primary"
            variant="shadow"
            className="absolute right-6 top-1/2 -translate-y-1/2 h-12 w-12 z-20 shadow-lg"
            onPress={handleGenerate}
            isDisabled={!currentText || isGenerating}
            isLoading={isGenerating}
            aria-label={isGenerating ? t('workflow.tts.generating', '生成中...') : t('workflow.tts.generate', '开始生成')}
          >
            {!isGenerating && <Mic size={20} />}
          </Button>
        </Tooltip>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-8">
          <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left Column: Source Selection & Preview */}
            <div className="space-y-4">
              <Card className="h-full min-h-[400px]">
                <CardBody className="p-4 space-y-6">
                  <div className="flex items-center gap-2 text-lg font-medium">
                    <FileText size={20} />
                    {t('workflow.tts.source', '内容来源')}
                  </div>

                  <Select
                    label={t('workflow.tts.selectSource', '选择来源')}
                    selectedKeys={[sourceType]}
                    onChange={(e) => e.target.value && setSourceType(e.target.value as 'summary' | 'monologue')}
                    variant="bordered"
                    disallowEmptySelection
                  >
                    <SelectItem key="summary">
                      {t('workflow.character.secondary.bio', '人物志')}
                    </SelectItem>
                    <SelectItem key="monologue">
                      {t('workflow.character.secondary.monologue', '心理独白')}
                    </SelectItem>
                  </Select>

                  <div className="bg-default-100 p-4 rounded-lg flex-1">
                    <div className="text-xs text-foreground/50 mb-3 font-medium uppercase tracking-wider">
                      {t('workflow.tts.preview', '内容预览')}
                    </div>
                    <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                      {currentText
                        ? (currentText.length > 500 ? currentText.slice(0, 500) + '...' : currentText)
                        : <span className="text-foreground/40 italic">{t('workflow.tts.noContent', '该来源暂无内容')}</span>
                      }
                    </p>
                  </div>
                </CardBody>
              </Card>
            </div>

            {/* Right Column: Settings & Result */}
            <div className="space-y-6">
              <Card>
                <CardBody className="p-4 space-y-6">
                  <div className="flex items-center gap-2 text-lg font-medium">
                    <Settings2 size={20} />
                    {t('workflow.tts.settings', '配置')}
                  </div>

                  <Select
                    label={t('workflow.tts.voice', '选择语音')}
                    selectedKeys={[voice]}
                    onChange={(e) => setVoice(e.target.value)}
                    variant="bordered"
                  >
                    {voices.map((v) => (
                      <SelectItem key={v.value}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </Select>

                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label={t('workflow.tts.rate', '语速 (Rate)')}
                      value={rate}
                      onValueChange={setRate}
                      placeholder="+0%"
                      variant="bordered"
                      description="e.g. +10%, -10%"
                    />
                    <Input
                      label={t('workflow.tts.pitch', '音调 (Pitch)')}
                      value={pitch}
                      onValueChange={setPitch}
                      placeholder="+0Hz"
                      variant="bordered"
                      description="e.g. +10Hz, -5Hz"
                    />
                  </div>

                   <Input
                      label={t('workflow.tts.volume', '音量 (Volume)')}
                      value={volume}
                      onValueChange={setVolume}
                      placeholder="+0%"
                      variant="bordered"
                      description="e.g. +10%, -10%"
                    />

                </CardBody>
              </Card>

              {/* Result Area */}
              {audioUrl && (
                <Card className="bg-success-50 border-success-200">
                  <CardBody className="p-4 space-y-4">
                    <div className="flex items-center gap-2 text-success-700 font-medium">
                      <Play size={20} />
                      {t('workflow.tts.result', '生成结果')}
                    </div>

                    <audio controls src={audioUrl} className="w-full" />

                    <div className="flex gap-2">
                       <Button
                        variant="flat"
                        color="success"
                        className="flex-1"
                        startContent={<Download size={16} />}
                        onPress={handleDownload}
                      >
                        {t('workflow.tts.openFile', '打开文件位置')}
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default TTSGenerator
