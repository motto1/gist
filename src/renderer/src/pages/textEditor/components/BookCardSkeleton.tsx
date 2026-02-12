import { Skeleton } from '@heroui/react'

type CardSize = 'large' | 'medium' | 'small'

const SIZE_STYLES: Record<
  CardSize,
  {
    cardMaxWidth: string
    coverPadding: string
    badgeHeight: string
    badgeWidth: string
    titleHeight: string
    statHeight: string
  }
> = {
  large: {
    cardMaxWidth: 'max-w-[280px]',
    coverPadding: 'p-[14px_14px_12px_16px]',
    badgeHeight: 'h-5',
    badgeWidth: 'w-12',
    titleHeight: 'h-5',
    statHeight: 'h-3'
  },
  medium: {
    cardMaxWidth: 'max-w-[240px]',
    coverPadding: 'p-[12px_12px_10px_14px]',
    badgeHeight: 'h-5',
    badgeWidth: 'w-10',
    titleHeight: 'h-4',
    statHeight: 'h-[11px]'
  },
  small: {
    cardMaxWidth: 'max-w-[196px]',
    coverPadding: 'p-[10px_10px_9px_12px]',
    badgeHeight: 'h-[18px]',
    badgeWidth: 'w-9',
    titleHeight: 'h-3.5',
    statHeight: 'h-[10px]'
  }
}

/**
 * Skeleton loader for BookCard component
 * Matches the structure and dimensions of the actual BookCard
 */
export default function BookCardSkeleton({ size = 'medium' }: { size?: CardSize }) {
  const sizeStyle = SIZE_STYLES[size]

  return (
    <div
      className={`w-full ${sizeStyle.cardMaxWidth} overflow-hidden rounded-2xl border border-divider bg-content1 shadow-sm`}>
      <div
        className={`relative aspect-[2/3] flex flex-col justify-between gap-2.5 bg-gradient-to-br from-gray-300 to-gray-400 text-white/92 dark:from-gray-700 dark:to-gray-800 ${sizeStyle.coverPadding}`}>
        <div className="absolute top-2.5 left-3">
          <Skeleton className={`${sizeStyle.badgeHeight} ${sizeStyle.badgeWidth} rounded-full`} />
        </div>

        <div className="relative mt-8 flex flex-col gap-2">
          <Skeleton className={`${sizeStyle.titleHeight} w-3/4 rounded-lg`} />
          <Skeleton className={`${sizeStyle.titleHeight} w-1/2 rounded-lg`} />
        </div>

        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <Skeleton className={`${sizeStyle.statHeight} w-16 rounded`} />
            <Skeleton className={`${sizeStyle.statHeight} w-20 rounded`} />
          </div>
          <Skeleton className={`${sizeStyle.statHeight} w-24 rounded`} />
        </div>
      </div>
    </div>
  )
}
