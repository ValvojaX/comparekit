// A compact overview strip of differences, shared by the hex and table views.
// Positions are expressed in arbitrary units (bytes, rows) over `total`.
import { memo, useMemo } from 'react'
import './minimap.css'

export type MarkClass = 'changed' | 'removed' | 'added' | 'unimp' | 'missing'
export interface Mark {
  start: number
  end: number
  cls: MarkClass
}

/** Many marks are merged into at most `buckets` slots so huge diffs stay cheap. */
function mergeMarks(marks: Mark[], total: number, buckets: number): Mark[] {
  if (marks.length <= buckets) return marks
  const out: Mark[] = []
  const unit = total / buckets
  for (const m of marks) {
    const last = out[out.length - 1]
    if (last && m.start - last.end < unit) {
      last.end = Math.max(last.end, m.end)
      if (last.cls !== m.cls) last.cls = 'changed'
    } else out.push({ ...m })
  }
  return out
}

export const MiniMap = memo(function MiniMap(props: {
  total: number
  marks: Mark[]
  viewStart: number
  viewSize: number
  onJump: (pos: number) => void
  title?: string
}) {
  const total = Math.max(props.total, 1)
  const marks = useMemo(() => mergeMarks(props.marks, total, 1500), [props.marks, total])
  const vpTop = (props.viewStart / total) * 100
  const vpH = Math.min(100, (props.viewSize / total) * 100)
  return (
    <div
      className="cc-minimap"
      title={props.title ?? 'Overview of differences'}
      onMouseDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const jump = (y: number) => props.onJump(Math.max(0, Math.min(1, (y - r.top) / r.height)) * total)
        jump(e.clientY)
        const move = (ev: MouseEvent) => jump(ev.clientY)
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    >
      {marks.map((m, i) => (
        <div
          key={i}
          className={`cc-mm-mark mm-${m.cls}`}
          style={{ top: `${(m.start / total) * 100}%`, height: `${((m.end - m.start) / total) * 100}%` }}
        />
      ))}
      <div className="cc-mm-viewport" style={{ top: `${vpTop}%`, height: `${vpH}%` }} />
    </div>
  )
})
