import { PointerSensor } from '@dnd-kit/core'

export const PORTAL_NO_DND_SELECTORS = [
  '.ant-dropdown',
  '.ant-select-dropdown',
  '.ant-popover',
  '.ant-tooltip',
  '.ant-modal'
].join(',')

/**
 * Prevent drag on elements with specific classes or data-no-dnd attribute
 */
export class PortalSafePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown',
      handler: ({ nativeEvent: event }) => {
        const target = event.target as HTMLElement | null

        if (!target) {
          return true
        }

        // Explicit opt-out always wins
        if (target.closest('[data-no-dnd]')) {
          return false
        }

        // Explicit opt-in (used when we intentionally render Sortable inside portals like dropdown/select)
        if (target.closest('[data-allow-dnd]')) {
          return true
        }

        // Default: block dragging inside common portal containers
        if (target.closest(PORTAL_NO_DND_SELECTORS)) {
          return false
        }

        return true
      }
    }
  ] as (typeof PointerSensor)['activators']
}
