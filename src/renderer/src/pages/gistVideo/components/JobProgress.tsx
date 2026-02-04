import ProgressDisplay from '@renderer/pages/workflow/components/ProgressDisplay'

export default function JobProgress(props: { pct: number; stage: string }) {
  const pct = Math.max(0, Math.min(100, Number(props.pct || 0)))
  const stage = props.stage || '空闲'
  return <ProgressDisplay percentage={pct} stage={stage} />
}
