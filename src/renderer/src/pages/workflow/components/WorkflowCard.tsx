import { Card, CardBody } from '@heroui/react'
import { LucideIcon } from 'lucide-react'
import { FC } from 'react'
import { useNavigate } from 'react-router-dom'

interface WorkflowCardProps {
  title: string
  description: string
  icon: LucideIcon
  route: string
  gradient: string
}

const WorkflowCard: FC<WorkflowCardProps> = ({ title, description, icon: Icon, route, gradient }) => {
  const navigate = useNavigate()

  return (
    <Card
      isPressable
      onPress={() => navigate(route)}
      className="w-full max-w-[280px] hover:scale-[1.02] transition-transform duration-200"
      style={{
        background: gradient,
        border: 'none'
      }}
    >
      <CardBody className="flex flex-col items-center justify-center gap-4 py-8 px-6">
        <div className="p-4 rounded-full bg-white/20 backdrop-blur-sm">
          <Icon size={32} className="text-white" />
        </div>
        <div className="text-center">
          <h3 className="text-xl font-semibold text-white mb-2">{title}</h3>
          <p className="text-sm text-white/80">{description}</p>
        </div>
      </CardBody>
    </Card>
  )
}

export default WorkflowCard
