/**
 * The light on a marching edge: the edge control flow took to enter the running station, overlaid
 * in the SVG as a 1.5px round-capped path stroked with a `userSpaceOnUse` gradient — fully
 * transparent at the path's start, at full alert colour by 80% along it — so it is brightest at the
 * lamp end and fades back toward where control flow came from, as if the lamp lit the road it
 * arrived by. It does not move: a marching edge speaks about the past (control flow took this
 * edge); the action belongs to the running lamp (the pulse of `wf-lamp-running`). It used to be a
 * dashed alert-coloured line scrolling along the path, which read as "still hurrying from the
 * previous station to this one".
 *
 * The gradient is laid out along x (the x of the path's first and last point); the timeline's arcs
 * and its branching and merging curves are horizontal apart from two short vertical segments, so
 * that is enough. A path whose first and last x are the same (none in the spine, but guarded
 * anyway) is laid out along y instead. `id` is supplied by the caller and must be unique within one
 * SVG.
 */
export interface MarchLightProps {
  /**
   * The path to light up; for arcs, the one shortened by 6px that stops at the base of the
   * arrowhead.
   */
  d: string;
  /** Start of the path (the end control flow came from). */
  from: { x: number; y: number };
  /** End of the path (the end with the running lamp). */
  to: { x: number; y: number };
  id: string;
}

export function MarchLight({ d, from, id, to }: MarchLightProps) {
  const alongY = from.x === to.x;
  return (
    <>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={id}
          x1={alongY ? 0 : from.x}
          x2={alongY ? 0 : to.x}
          y1={alongY ? from.y : 0}
          y2={alongY ? to.y : 0}
        >
          <stop offset={0} stopColor="var(--color-warning)" stopOpacity={0} />
          <stop offset={0.8} stopColor="var(--color-warning)" />
        </linearGradient>
      </defs>
      <path
        className="wf-lit"
        d={d}
        data-testid="workflow-march-light"
        fill="none"
        stroke={`url(#${id})`}
      />
    </>
  );
}
