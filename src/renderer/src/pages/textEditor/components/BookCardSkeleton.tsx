import { Skeleton } from '@heroui/react'

/**
 * Skeleton loader for BookCard component
 * Matches the structure and dimensions of the actual BookCard
 */
export default function BookCardSkeleton() {
  return (
    <div className="w-full max-w-[280px] rounded-[var(--list-item-border-radius)] border-[0.5px] border-[var(--color-border)] overflow-hidden bg-[var(--color-background)] shadow-[0_5px_7px_-3px_var(--color-border-soft),0_2px_3px_-4px_var(--color-border-soft)]">
      {/* Cover Area Skeleton */}
      <div className="relative aspect-[3/4] p-[14px_14px_12px_16px] flex flex-col gap-2.5 justify-between bg-gradient-to-br from-gray-300 to-gray-400 dark:from-gray-700 dark:to-gray-800">
        {/* Badge Skeleton */}
        <div className="absolute top-2.5 left-3">
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>

        {/* Title Skeleton - at bottom */}
        <div className="mt-auto flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4 rounded-lg" />
          <Skeleton className="h-4 w-1/2 rounded-lg" />
        </div>
      </div>

      {/* Meta Area Skeleton */}
      <div className="p-[10px_12px_12px] flex flex-col gap-2">
        {/* Stats Row Skeleton */}
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 w-16 rounded" />
          <Skeleton className="h-3 w-20 rounded" />
        </div>

        {/* Date Row Skeleton */}
        <Skeleton className="h-3 w-24 rounded" />
      </div>
    </div>
  )
}
