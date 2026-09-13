"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { scaleTime, scaleSqrt } from "d3-scale";
import { timeMonth } from "d3-time";
import { timeFormat } from "d3-time-format";
import { monthTotals, type MonthlySummary } from "@/lib/monthly-summary";

/**
 * MONTHLY BARS, high-density visualization for officials with so many
 * trades that the dot-timeline becomes a smear. One stacked bar per month:
 * sales above the midline (red), purchases below (green). A 1-px amber
 * tick at the top of any month that contains a late-filed trade preserves
 * the accountability signal that the dot view carries via stroke color.
 *
 * The chart takes a server-computed monthly summary (lib/monthly-summary.ts)
 * rather than the rows themselves. It used to bucket every row in the
 * browser, which meant the page serialised every row into the HTML as
 * props; at 30,000 rows for President Trump that was several megabytes
 * for twelve numbers a month. The summary carries counts, late flags and
 * dollar estimates per month and source kind, so the hover label can say
 * how many of a month's trades came from an annual report.
 *
 * Same x-axis (scaleTime) as TransactionTimeline so this can sit directly
 * above the dot view as a "density overview" + drill-down pair.
 */

interface Props {
  summary: MonthlySummary;
  // If set, the parent is rendering a filtered subset and this month
  // should be drawn with a highlighted outline.
  selectedMonth?: string | null; // "YYYY-MM"
  // When true, clicking a bar updates ?month=YYYY-MM on the URL so the
  // parent server component can re-filter the dataset.
  clickToZoom?: boolean;
}

interface MonthBucket {
  month: Date;
  monthKey: string;
  sales: number;
  purchases: number;
  late: number;
  total: number;
  annualLane: number;
}

const CHART_MARGIN = { top: 28, right: 16, bottom: 28, left: 16 };

export default function MonthlyBars(props: Props) {
  return (
    <Suspense fallback={null}>
      <MonthlyBarsContent {...props} />
    </Suspense>
  );
}

function monthDate(monthKey: string): Date {
  return new Date(`${monthKey}-01T00:00:00`);
}

function MonthlyBarsContent({ summary, selectedMonth, clickToZoom }: Props) {
  const router = useRouter();
  const search = useSearchParams();

  function handleClick(monthKey: string) {
    if (!clickToZoom) return;
    const params = new URLSearchParams(search.toString());
    // Toggle: clicking the same month again clears the filter.
    if (params.get("month") === monthKey) params.delete("month");
    else params.set("month", monthKey);
    // A month filter starts the table at page 1.
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  const data = useMemo(() => {
    const totals = monthTotals(summary);
    if (totals.length === 0) return { buckets: [] as MonthBucket[], maxStack: 0 };
    // Fill the months between the first and last with empty bars so the
    // time axis is continuous, as timeMonth.range did for the raw rows.
    const start = monthDate(totals[0].monthKey);
    const end = monthDate(totals[totals.length - 1].monthKey);
    const months = timeMonth.range(timeMonth.floor(start), timeMonth.offset(timeMonth.floor(end), 1));
    const byKey = new Map(totals.map((t) => [t.monthKey, t]));
    const buckets: MonthBucket[] = months.map((m) => {
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      const t = byKey.get(key);
      return {
        month: m,
        monthKey: key,
        sales: t?.sales ?? 0,
        purchases: t?.purchases ?? 0,
        late: t?.late ?? 0,
        total: t?.total ?? 0,
        annualLane: t?.annualLane ?? 0,
      };
    });
    const maxStack = buckets.reduce((m, b) => Math.max(m, b.sales, b.purchases), 0);
    return { buckets, maxStack };
  }, [summary]);

  const [hover, setHover] = useState<{ b: MonthBucket; x: number } | null>(null);

  const width = 920;
  const height = 200;
  const margin = CHART_MARGIN;
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const midY = margin.top + innerH / 2;

  if (data.buckets.length === 0) return null;

  const x = scaleTime()
    .domain([data.buckets[0].month, timeMonth.offset(data.buckets[data.buckets.length - 1].month, 1)])
    .range([margin.left, margin.left + innerW]);

  // Half the inner height for each side of the midline. We use scaleSqrt
  // instead of scaleLinear because high-volume officials (Trump) have one
  // or two months that are 10-50x the others, linear scaling makes every
  // smaller month invisible. Sqrt preserves ordinal correctness while
  // compressing the dominance enough to read the rest of the timeline.
  const halfH = (innerH - 6) / 2;
  const y = scaleSqrt()
    .domain([0, Math.max(1, data.maxStack)])
    .range([0, halfH]);

  const monthWidth = innerW / data.buckets.length;
  const barWidth = Math.max(4, monthWidth * 0.75);
  const monthLabel = timeFormat("%b");
  const yearLabel = timeFormat("%Y");

  // Because bar HEIGHT is sqrt-compressed, the tallest months can't be read
  // off the axis by eye. Print the exact trade count above the 3 busiest
  // months so the chart is honest and legible without hovering.
  const topMonthKeys = new Set(
    data.buckets
      .toSorted((a, b) => b.total - a.total)
      .slice(0, 3)
      .filter((b) => b.total > 0)
      .map((b) => b.monthKey)
  );
  const hasAnnualLane = data.buckets.some((b) => b.annualLane > 0);

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img">
        {/* Midline */}
        <line
          x1={margin.left}
          x2={margin.left + innerW}
          y1={midY}
          y2={midY}
          stroke="#d4d4d4"
          strokeWidth={0.5}
        />

        {/* Bars */}
        {data.buckets.map((b) => {
          const cx = x(b.month) + monthWidth / 2;
          const xPos = cx - barWidth / 2;
          const salesH = y(b.sales);
          const purchH = y(b.purchases);
          const isHover = hover?.b.monthKey === b.monthKey;
          const isSelected = selectedMonth === b.monthKey;
          const clickable = clickToZoom && b.total > 0;
          return (
            <g
              key={b.monthKey}
              onMouseEnter={() => setHover({ b, x: cx })}
              onMouseLeave={() => setHover(null)}
              onClick={() => clickable && handleClick(b.monthKey)}
              style={{ cursor: clickable ? "pointer" : "default" }}
            >
              {/* Selected highlight, drawn behind the bars */}
              {isSelected && (
                <rect
                  x={xPos - 3}
                  y={margin.top - 2}
                  width={barWidth + 6}
                  height={innerH + 4}
                  fill="none"
                  stroke="#0a0a0a"
                  strokeWidth={1}
                />
              )}
              {/* Invisible hit target so empty months don't grab hover */}
              {b.total > 0 && (
                <rect
                  x={xPos - 2}
                  y={margin.top}
                  width={barWidth + 4}
                  height={innerH}
                  fill="transparent"
                />
              )}
              {/* Sales, above the midline */}
              {b.sales > 0 && (
                <rect
                  x={xPos}
                  y={midY - salesH}
                  width={barWidth}
                  height={salesH}
                  fill="#dc2626"
                  opacity={isHover ? 1 : 0.85}
                />
              )}
              {/* Purchases, below the midline */}
              {b.purchases > 0 && (
                <rect
                  x={xPos}
                  y={midY}
                  width={barWidth}
                  height={purchH}
                  fill="#16a34a"
                  opacity={isHover ? 1 : 0.85}
                />
              )}
              {/* Late-filing tick, amber bar at the very top of the
                  sales stack. We attach it to sales because lateness is
                  the public-interest signal worth foregrounding. Only a
                  278-T row can be late (the summary never counts an
                  annual row here). */}
              {b.late > 0 && b.sales > 0 && (
                <rect
                  x={xPos}
                  y={midY - salesH - 2}
                  width={barWidth}
                  height={1.5}
                  fill="#f59e0b"
                />
              )}
              {b.late > 0 && b.sales === 0 && b.purchases > 0 && (
                <rect
                  x={xPos}
                  y={midY + purchH + 1}
                  width={barWidth}
                  height={1.5}
                  fill="#f59e0b"
                />
              )}
              {/* Exact count label on the busiest months so the sqrt-scaled
                  heights don't hide the true magnitudes. Sits just above the
                  sales stack (top of the bar). */}
              {topMonthKeys.has(b.monthKey) && (
                <text
                  x={cx}
                  y={midY - salesH - (b.late > 0 && b.sales > 0 ? 6 : 4)}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#525252"
                  className="font-[family-name:var(--font-dm-mono)] tabular-nums"
                >
                  {b.total.toLocaleString()}
                </text>
              )}
            </g>
          );
        })}

        {/* Month labels under the midline, thinned so they never collide:
            every month when there is room for a 3-letter label, otherwise
            every 2nd, 3rd or 6th. January carries the year and a dashed
            year line. (Trevor, Sep 6: a chart with only "2026" under it
            told readers nothing about which months they were looking at.) */}
        {(() => {
          const step = monthWidth >= 26 ? 1 : monthWidth >= 14 ? 2 : monthWidth >= 9 ? 3 : 6;
          return data.buckets.map((b, i) => {
            const isJan = b.month.getMonth() === 0;
            const showLabel = i === 0 || isJan || i % step === 0;
            if (!showLabel) return null;
            const label = i === 0 || isJan ? `${monthLabel(b.month)} ${yearLabel(b.month)}` : monthLabel(b.month);
            return (
              <g key={`mo-${b.monthKey}`}>
                {(i === 0 || isJan) && (
                  <line
                    x1={x(b.month)}
                    x2={x(b.month)}
                    y1={margin.top}
                    y2={margin.top + innerH}
                    stroke="#e5e5e5"
                    strokeDasharray="2 2"
                  />
                )}
                <text x={x(b.month) + monthWidth / 2} y={height - 8} fontSize={10} fill="#737373" textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          });
        })()}

        {/* Hover label */}
        {hover && (
          <text
            x={hover.x}
            y={margin.top - 8}
            textAnchor="middle"
            fontSize={10}
            fill="#404040"
          >
            {monthLabel(hover.b.month)} {yearLabel(hover.b.month)} · {hover.b.total.toLocaleString()} trade
            {hover.b.total === 1 ? "" : "s"}
            {hover.b.late > 0 ? ` · ${hover.b.late.toLocaleString()} late` : ""}
            {hover.b.annualLane > 0 ? ` · ${hover.b.annualLane.toLocaleString()} from annual report` : ""}
          </text>
        )}
      </svg>

      {/* Below-chart legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 mt-1 pl-4">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2 bg-red-600" /> Sales
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2 bg-emerald-600" /> Purchases
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-[2px] bg-amber-500" /> Months
          with late-filed 278-T trades
        </span>
        {hasAnnualLane && (
          <span className="text-neutral-400">
            Bars include trades read from the annual report; hover a month for its share
          </span>
        )}
        <span className="text-neutral-400">
          Bar height scales with the square root of monthly trades, so busy
          months stay readable
        </span>
      </div>
    </div>
  );
}
