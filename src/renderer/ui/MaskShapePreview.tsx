import { useId } from 'react';

/**
 * Lightroom-style AREA preview for a mask shape (UX pack C §5), shared by the
 * live draw gesture (MaskDrawOverlay) and the post-create edit handles
 * (MaskOverlay) so both communicate WHAT the mask affects, not just its
 * outline. Coordinates are OUTPUT-frame normalized (0..1) — the caller
 * converts anchor→output before handing a shape here.
 *
 * Radial: a translucent fill inside the circle + a dashed "feather" circle at
 * radius·(1−feather) — the inner edge where the mask weight is still 1 before
 * it falls to 0 at `radius` (maskNode.ts's e0 = radius·(1−feather) falloff).
 * Linear: three parallel lines perpendicular to the axis (100% at p0, 50% at
 * the midpoint, 0% at p1) over a translucent gradient fading along the axis.
 * Every stroke carries a thin dark under-stroke so it reads on both bright and
 * dark image regions (the existing overlay convention).
 */
export type PreviewShape =
  | { type: 'radial'; cx: number; cy: number; radius: number; feather: number }
  | { type: 'linear'; x0: number; y0: number; x1: number; y1: number; feather: number };

export function MaskShapePreview({
  shape,
  canvasWidth,
  canvasHeight,
}: {
  shape: PreviewShape;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const rawId = useId();
  const gradId = `mask-grad-${rawId.replace(/:/g, '')}`;
  const maxDim = Math.max(canvasWidth, canvasHeight);

  if (shape.type === 'radial') {
    const cx = shape.cx * canvasWidth;
    const cy = shape.cy * canvasHeight;
    const r = shape.radius * maxDim;
    const rInner = Math.max(0, r * (1 - shape.feather));
    return (
      <g className="mask-area-preview" data-testid="mask-area-radial">
        <circle className="mask-area-fill" cx={cx} cy={cy} r={r} />
        <circle className="mask-area-outline-under" cx={cx} cy={cy} r={r} />
        <circle className="mask-area-outline" cx={cx} cy={cy} r={r} />
        <circle className="mask-area-feather" data-testid="mask-area-feather" cx={cx} cy={cy} r={rInner} />
      </g>
    );
  }

  const x0 = shape.x0 * canvasWidth;
  const y0 = shape.y0 * canvasHeight;
  const x1 = shape.x1 * canvasWidth;
  const y1 = shape.y1 * canvasHeight;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  // unit perpendicular to the axis, extended to span the whole frame so the
  // guide lines read as full-width gradient boundaries (LR behavior)
  const px = -dy / len;
  const py = dx / len;
  const half = maxDim; // generous — clipped by the SVG viewport
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const guide = (gx: number, gy: number, cls: string, testid: string) => (
    <>
      <line className="mask-area-line-under" x1={gx - px * half} y1={gy - py * half} x2={gx + px * half} y2={gy + py * half} />
      <line
        className={cls}
        data-testid={testid}
        x1={gx - px * half}
        y1={gy - py * half}
        x2={gx + px * half}
        y2={gy + py * half}
      />
    </>
  );

  return (
    <g className="mask-area-preview" data-testid="mask-area-linear">
      <defs>
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={x0} y1={y0} x2={x1} y2={y1}>
          {/* red = affected area, matching .mask-area-fill / the 'O' overlay (a
              white wash was ambiguous against highlights — round-4 feedback) */}
          <stop offset="0%" stopColor="rgba(255,60,50,0.30)" />
          <stop offset="100%" stopColor="rgba(255,60,50,0)" />
        </linearGradient>
      </defs>
      <rect className="mask-area-gradient" x={0} y={0} width={canvasWidth} height={canvasHeight} fill={`url(#${gradId})`} />
      {guide(x0, y0, 'mask-area-line mask-area-line-100', 'mask-area-line-100')}
      {guide(mx, my, 'mask-area-line mask-area-line-50', 'mask-area-line-50')}
      {guide(x1, y1, 'mask-area-line mask-area-line-0', 'mask-area-line-0')}
    </g>
  );
}
