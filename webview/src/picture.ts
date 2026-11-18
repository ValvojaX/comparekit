// Pixel comparison in the webview, ported from CompareCraft's
// cc-core/src/picture.rs: the same orientation, scaling, offset handling and
// difference colours.

export type DiffMode = 'tolerance' | 'range';

export interface PictureOptions {
  mode: DiffMode;
  /** Largest per-channel difference that counts as unimportant. */
  tolerance: number;
  ignoreUnimportant: boolean;
  offsetX: number;
  offsetY: number;
  /** Scale the smaller image to the larger one's size. */
  autoScale: boolean;
  /** Clockwise rotation of the right image: 0, 90, 180 or 270. */
  rotateRight: number;
  flipH: boolean;
  flipV: boolean;
}

export const defaultPictureOptions: PictureOptions = { mode: 'tolerance', tolerance: 8, ignoreUnimportant: false, offsetX: 0, offsetY: 0, autoScale: false, rotateRight: 0, flipH: false, flipV: false };

export interface PictureDiff {
  width: number;
  height: number;
  samePixels: number;
  unimportantPixels: number;
  importantPixels: number;
  maxDelta: number;
  identical: boolean;
  /** Within the tolerance: only unimportant differences. */
  equivalent: boolean;
  diffUrl: string;
}

export interface Prepared {
  /** Images as compared (right one oriented, either one scaled). */
  left: HTMLCanvasElement;
  right: HTMLCanvasElement;
  leftUrl: string;
  rightUrl: string;
}

export function loadImage(src: string, label: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${label} could not be decoded as an image.`));
    img.src = src;
  });
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

/** Draws an image rotated clockwise (in 90° steps) and flipped. */
function orient(src: CanvasImageSource, iw: number, ih: number, rotate: number, flipH: boolean, flipV: boolean): HTMLCanvasElement {
  const quarter = (((Math.round(rotate / 90) % 4) + 4) % 4);
  const w = quarter % 2 ? ih : iw;
  const h = quarter % 2 ? iw : ih;
  const [c, ctx] = canvas(w, h);
  ctx.translate(w / 2, h / 2);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(src, -iw / 2, -ih / 2);
  return c;
}

function resized(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/** The two images as they are compared and shown. */
export function prepare(a: HTMLImageElement, b: HTMLImageElement, o: PictureOptions): Prepared {
  let left = orient(a, a.naturalWidth, a.naturalHeight, 0, false, false);
  let right = orient(b, b.naturalWidth, b.naturalHeight, o.rotateRight, o.flipH, o.flipV);
  if (o.autoScale && (left.width !== right.width || left.height !== right.height)) {
    if (left.width * left.height < right.width * right.height) left = resized(left, right.width, right.height);
    else right = resized(right, left.width, left.height);
  }
  return { left, right, leftUrl: left.toDataURL(), rightUrl: right.toDataURL() };
}

export function diffPictures(p: Prepared, o: PictureOptions): PictureDiff {
  const { left: ia, right: ib } = p;
  const dx = o.offsetX, dy = o.offsetY;
  const x0 = Math.min(0, dx), y0 = Math.min(0, dy);
  const x1 = Math.max(ia.width, ib.width + dx), y1 = Math.max(ia.height, ib.height + dy);
  const w = x1 - x0, h = y1 - y0;
  const pa = ia.getContext('2d')!.getImageData(0, 0, ia.width, ia.height).data;
  const pb = ib.getContext('2d')!.getImageData(0, 0, ib.width, ib.height).data;
  const [out, octx] = canvas(w, h);
  const img = octx.createImageData(w, h);
  const px = img.data;
  let same = 0, unimp = 0, imp = 0, maxDelta = 0;
  const tol = o.tolerance;
  for (let py = 0; py < h; py++) {
    const y = py + y0;
    for (let qx = 0; qx < w; qx++) {
      const x = qx + x0;
      const ai = x >= 0 && y >= 0 && x < ia.width && y < ia.height ? (y * ia.width + x) * 4 : -1;
      const bx = x - dx, by = y - dy;
      const bi = bx >= 0 && by >= 0 && bx < ib.width && by < ib.height ? (by * ib.width + bx) * 4 : -1;
      const o4 = (py * w + qx) * 4;
      let r = 0, g = 0, b = 0, a = 0;
      if (ai >= 0 && bi >= 0) {
        const d = Math.max(Math.abs(pa[ai] - pb[bi]), Math.abs(pa[ai + 1] - pb[bi + 1]), Math.abs(pa[ai + 2] - pb[bi + 2]), Math.abs(pa[ai + 3] - pb[bi + 3]));
        if (d > maxDelta) maxDelta = d;
        const luma = ((pa[ai] * 3 + pa[ai + 1] * 6 + pa[ai + 2]) / 10) | 0;
        a = 255;
        if (o.mode === 'range') {
          if (d === 0) same++;
          else if (d <= tol) unimp++;
          else imp++;
          r = g = d;
        } else {
          const gray = 96 + ((luma / 3) | 0);
          if (d === 0 || (o.ignoreUnimportant && d <= tol)) {
            if (d === 0) same++;
            else unimp++;
            r = g = b = gray;
          } else if (d <= tol) {
            unimp++;
            r = 40;
            g = 90;
            b = 160 + Math.min(d, 95);
          } else {
            imp++;
            r = Math.min(255, 160 + ((d / 3) | 0));
            g = 30;
            b = 40;
          }
        }
      } else if (ai >= 0 || bi >= 0) {
        imp++;
        r = 200;
        g = 40;
        b = 160;
        a = 255;
      }
      px[o4] = r;
      px[o4 + 1] = g;
      px[o4 + 2] = b;
      px[o4 + 3] = a;
    }
  }
  octx.putImageData(img, 0, 0);
  return { width: w, height: h, samePixels: same, unimportantPixels: unimp, importantPixels: imp, maxDelta, identical: imp === 0 && unimp === 0, equivalent: imp === 0, diffUrl: out.toDataURL() };
}
