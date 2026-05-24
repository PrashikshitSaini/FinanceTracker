'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MoreVertical, CreditCard, FileDown, KeyRound } from 'lucide-react'

/**
 * Dropdown menu for header secondary actions: Payment Sources, Export
 * Statement, API Keys. Replaces three indistinguishable icon buttons in the
 * header — the menu items are LABELED so users can actually find them.
 *
 * Implemented as a self-contained "click trigger → absolute-positioned panel"
 * with a click-outside-to-close handler. No new dependency needed; keeps the
 * header from getting any wider on phones where every pixel counts.
 *
 * On desktop the dropdown's behavior is identical — labels just have more
 * room to breathe.
 */
interface HeaderMoreMenuProps {
  onOpenPaymentSources: () => void
  onOpenApiKeys: () => void
}

export default function HeaderMoreMenu({
  onOpenPaymentSources,
  onOpenApiKeys,
}: HeaderMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close on outside click. Also close on Escape — both for accessibility and
  // so a stray tap doesn't leave the menu lingering forever.
  useEffect(() => {
    if (!open) return

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown, { passive: true })
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  // Each item closes the menu and then performs its action. The closing must
  // be synchronous so a dialog-opening action doesn't immediately fight with
  // the click-outside listener once the dialog mounts.
  const runAndClose = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(v => !v)}
        title="More options"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVertical className="h-4 w-4" />
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-56 rounded-md border bg-card shadow-lg py-1 z-50"
        >
          <MenuItem
            icon={<CreditCard className="h-4 w-4" />}
            label="Payment Sources"
            onClick={() => runAndClose(onOpenPaymentSources)}
          />
          <MenuItem
            icon={<FileDown className="h-4 w-4" />}
            label="Export Statement (PDF)"
            onClick={() =>
              runAndClose(() => window.open('/statement', '_blank', 'noopener'))
            }
          />
          <MenuItem
            icon={<KeyRound className="h-4 w-4" />}
            label="API Keys"
            onClick={() => runAndClose(onOpenApiKeys)}
          />
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      // Tap-target sized for mobile: at least 44px tall (Apple HIG / Material
      // recommend ≥44pt / 48dp). py-2.5 + text-sm gets us there comfortably.
      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left hover:bg-muted active:bg-muted/80 transition-colors"
    >
      <span className="text-muted-foreground flex-shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
