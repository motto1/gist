import { BookOpen, FileText, Users } from 'lucide-react'
import { FC } from 'react'
import { useTranslation } from 'react-i18next'

import DragBar from './components/DragBar'
import WorkflowCard from './components/WorkflowCard'
import WorkflowHistory from './components/WorkflowHistory'

const LauncherPage: FC = () => {
  const { t } = useTranslation()

  const workflows = [
    {
      title: t('workflow.speedRead.title', '开始速读'),
      description: t('workflow.speedRead.description', '快速压缩长篇小说，保留核心剧情'),
      icon: BookOpen,
      route: '/workflow/speed-read',
      gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
    },
    {
      title: t('workflow.character.title', '生成人物志'),
      description: t('workflow.character.description', '提取角色关系与性格演变'),
      icon: Users,
      route: '/workflow/character',
      gradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'
    },
    {
      title: t('workflow.outline.title', '生成大纲'),
      description: t('workflow.outline.description', '提取故事结构与主线脉络'),
      icon: FileText,
      route: '/workflow/outline',
      gradient: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)'
    }
  ]

  return (
    <>
      <DragBar />
      <div className="flex flex-col h-full w-full overflow-auto bg-background">
        {/* Main content area - vertically centered */}
        <div className="flex-1 flex items-center justify-center px-6 py-8">
          <div className="w-full max-w-4xl">
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-foreground mb-2 tracking-tight">
                {t('workflow.launcher.title', '选择工作流')}
              </h1>
              <p className="text-sm text-foreground/60">
                {t('workflow.launcher.subtitle', '选择一个模式开始处理你的小说')}
              </p>
            </div>

            {/* Workflow Cards */}
            <div className="grid grid-cols-3 gap-2 w-full">
              {workflows.map((workflow) => (
                <WorkflowCard
                  key={workflow.route}
                  title={workflow.title}
                  description={workflow.description}
                  icon={workflow.icon}
                  route={workflow.route}
                  gradient={workflow.gradient}
                />
              ))}
            </div>
          </div>
        </div>

        {/* History Section - fixed at bottom, not affecting center calculation */}
        <div className="flex-shrink-0 w-full max-w-4xl mx-auto px-6 pb-6">
          <WorkflowHistory maxItems={10} showEmpty={false} />
        </div>
      </div>
    </>
  )
}

export default LauncherPage
