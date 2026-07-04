'use client'

import { useMemo } from 'react'
import { formatCurrency } from '@/lib/currency'
import { useCurrency } from '@/contexts/CurrencyContext'

/**
 * Donut/pie chart for category-share visualization.
 *
 * Inputs are pre-sorted, already-aggregated category totals (largest first).
 * Renders a hand-rolled SVG pie + a legend showing each category with a color
 * swatch, total amount, and percentage of the whole. No external charting
 * library — keeps bundle size flat and SSR-safe.
 *
 * If `data` is empty, returns a friendly empty state instead of an empty SVG.
 */

// Fixed color palette tuned for readability against light + dark backgrounds.
// Twelve distinct hues — enough for a comfortable spread; categories beyond
// that wrap and reuse colors (rare in real use).
const SLICE_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#a855f7', // purple
] as const

interface CategoryDatum {
  category: string
  amount: number
}

interface CategoryPieChartProps {
  data: CategoryDatum[]
  /** Sum of all amounts — passed in (not recomputed) so caller can decide
   *  what "total" means (e.g., all expenses vs. filtered subset). */
  total: number
  /** What the slices represent, used in the SVG aria-label so the chart is
   *  described correctly for screen readers (e.g., "category", "payment
   *  source"). Defaults to "category" to preserve existing behavior. */
  label?: string
}

export default function CategoryPieChart({ data, total, label = 'category' }: CategoryPieChartProps) {
  const { currency } = useCurrency()

  // Pre-compute slice geometry once per data change. Each slice carries its
  // start/end angle, percentage, and assigned color for later rendering.
  const slices = useMemo(() => {
    if (total <= 0) return []
    let cumulative = -Math.PI / 2 // start at the top (12 o'clock)
    return data.map((item, i) => {
      const fraction = item.amount / total
      const startAngle = cumulative
      const endAngle = cumulative + fraction * 2 * Math.PI
      cumulative = endAngle
      return {
        ...item,
        color: SLICE_COLORS[i % SLICE_COLORS.length],
        fraction,
        startAngle,
        endAngle,
        percentage: fraction * 100,
      }
    })
  }, [data, total])

  if (slices.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No expenses this month</p>
    )
  }

  // SVG viewport — pie is centered at (100, 100) with radius 90.
  // Inner radius 50 makes it a donut, which leaves room for a center label.
  const cx = 100
  const cy = 100
  const outerRadius = 90
  const innerRadius = 55

  return (
    <div className="flex flex-col sm:flex-row gap-6 items-center sm:items-start">
      {/* Chart */}
      <div className="flex-shrink-0 relative">
        <svg viewBox="0 0 200 200" className="w-48 h-48" role="img" aria-label={`Expenses by ${label}`}>
          {slices.length === 1 ? (
            // Single-slice case: stroke a circle. SVG arcs can't draw a full
            // 360° arc with a single path, so this avoids the edge case.
            <>
              <circle cx={cx} cy={cy} r={outerRadius} fill={slices[0].color} />
              <circle cx={cx} cy={cy} r={innerRadius} fill="hsl(var(--background))" />
            </>
          ) : (
            slices.map((slice) => (
              <path
                key={slice.category}
                d={donutSlicePath(cx, cy, outerRadius, innerRadius, slice.startAngle, slice.endAngle)}
                fill={slice.color}
              />
            ))
          )}
        </svg>
        {/* Center label inside the donut hole. Pointer-events none so the
            SVG/legend interactions aren't blocked. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="text-sm font-semibold tabular-nums">
            {formatCurrency(total, currency)}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex-1 w-full space-y-1.5">
        {slices.map((slice) => (
          <div
            key={slice.category}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-3 h-3 rounded-sm flex-shrink-0"
                style={{ backgroundColor: slice.color }}
                aria-hidden="true"
              />
              <span className="truncate">{slice.category}</span>
            </div>
            <div className="flex items-baseline gap-2 flex-shrink-0 tabular-nums">
              <span className="font-semibold">
                {formatCurrency(slice.amount, currency)}
              </span>
              <span className="text-xs text-muted-foreground w-12 text-right">
                {slice.percentage.toFixed(1)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Build an SVG path string for a single donut slice.
 *
 * Construction: move to outer-start point, arc to outer-end point, line to
 * inner-end point, arc back to inner-start point, close. The two arcs go in
 * opposite directions (sweep flag 1 for outer, 0 for inner) so the slice is
 * a closed annular wedge.
 *
 * `largeArc` is 1 when the slice covers more than 180° — needed for SVG's
 * arc command to choose the longer path.
 */
function donutSlicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle
  const largeArc = sweep > Math.PI ? 1 : 0

  const xOuterStart = cx + rOuter * Math.cos(startAngle)
  const yOuterStart = cy + rOuter * Math.sin(startAngle)
  const xOuterEnd = cx + rOuter * Math.cos(endAngle)
  const yOuterEnd = cy + rOuter * Math.sin(endAngle)
  const xInnerEnd = cx + rInner * Math.cos(endAngle)
  const yInnerEnd = cy + rInner * Math.sin(endAngle)
  const xInnerStart = cx + rInner * Math.cos(startAngle)
  const yInnerStart = cy + rInner * Math.sin(startAngle)

  return [
    `M ${xOuterStart} ${yOuterStart}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${xOuterEnd} ${yOuterEnd}`,
    `L ${xInnerEnd} ${yInnerEnd}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${xInnerStart} ${yInnerStart}`,
    'Z',
  ].join(' ')
}
