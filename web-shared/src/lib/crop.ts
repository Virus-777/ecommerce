// Crop and resize images in the browser (canvas), for product images: cut the chosen area out of the photo and
// scale it to an exact size. Used by the image cropper before upload; the backend builds its renditions from
// the cropped file (web-shared/docs/BACKEND-PRODUCT-IMAGES.md).

export interface CropRect {
  /** Source pixels, after the photo's camera orientation is applied. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LoadedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** HEIC/HEIF photos (the iPhone default). Product images don't accept them: the backend answers 415 at upload. */
export const isHeic = (file: Blob): boolean => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test((file as File).name ?? '');

/** What to tell the person when they pick a HEIC photo. */
export const HEIC_NOT_SUPPORTED = 'HEIC photos aren’t supported. Save it as JPG or PNG first (on iPhone: Settings › Camera › Formats › Most Compatible).';

/**
 * Decodes an image file with its EXIF orientation applied. Throws a readable error for HEIC photos (not supported
 * for product images) and for files that can't be opened (damaged files).
 */
export async function loadImage(file: Blob): Promise<LoadedImage> {
  if (isHeic(file)) throw new Error(HEIC_NOT_SUPPORTED);
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    throw new Error('This file couldn’t be opened as an image. Try a JPG, PNG or WebP file.');
  }
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * Draws `rect` of the image at exactly `out` pixels. Large reductions go in halving steps so the result stays
 * sharp (a single big drawImage step aliases).
 */
export function renderCrop(img: LoadedImage, rect: CropRect, out: { width: number; height: number }): HTMLCanvasElement {
  let src: CanvasImageSource = img.bitmap;
  let sx = rect.x;
  let sy = rect.y;
  let sw = rect.width;
  let sh = rect.height;
  while (sw / 2 >= out.width && sh / 2 >= out.height) {
    const step = canvas(Math.round(sw / 2), Math.round(sh / 2));
    const ctx = step.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, step.width, step.height);
    src = step;
    sx = 0;
    sy = 0;
    sw = step.width;
    sh = step.height;
  }
  const c = canvas(out.width, out.height);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  // Transparent PNGs get a white background (product images are shown on white).
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return c;
}

/** Encodes a canvas as WebP (JPEG where the browser can't write WebP). `quality` is 1–100. */
export async function encode(c: HTMLCanvasElement, quality: number): Promise<Blob> {
  const toBlob = (type: string) => new Promise<Blob | null>((res) => c.toBlob(res, type, quality / 100));
  const webp = await toBlob('image/webp');
  if (webp && webp.type === 'image/webp') return webp;
  const jpeg = await toBlob('image/jpeg');
  if (!jpeg) throw new Error('The image couldn’t be prepared in this browser.');
  return jpeg;
}

/** A file name for the processed image: "photo.png" → "photo.webp". */
export function renamed(name: string, type: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'image';
  return `${base}.${type === 'image/webp' ? 'webp' : 'jpg'}`;
}
