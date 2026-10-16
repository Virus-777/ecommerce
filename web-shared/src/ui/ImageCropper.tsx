import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { sizeText, type ProductImageSpec } from '../api/imageSpec';
import { encode, loadImage, renamed, renderCrop, type CropRect, type LoadedImage } from '../lib/crop';
import { useElementWidth } from '../lib/hooks';
import { Alert } from './Structure';
import { Button } from './Button';
import { Dialog } from './Overlays';

// Product image cropper (designed in React; no design file). The frame has the configured aspect ratio; the seller
// drags the photo to place it and zooms with the slider (or arrow keys and +/−). "Use this crop" cuts the area,
// scales it to the product-page size and makes the thumbnail, so the upload is already the right shape and size.

export interface ProcessedImage {
  /** The product-page image to upload (exactly spec.detail, WebP or JPEG). */
  file: File;
  /** Object URL of the thumbnail made from the same crop, for an instant preview. */
  thumbUrl: string;
  sourceName: string;
  crop: CropRect;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

/**
 * Crops a queue of photos one at a time. `onProcessed` is called for each photo the person confirms; `onSkip` when
 * they skip one; `onClose` when the queue is done or cancelled.
 */
export function ImageCropper({ files, spec, onProcessed, onSkip, onClose }: { files: File[]; spec: ProductImageSpec; onProcessed: (img: ProcessedImage) => void; onSkip?: (file: File, reason?: string) => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const file = files[index];
  const next = () => (index + 1 < files.length ? setIndex(index + 1) : onClose());

  return (
    <Dialog
      open={!!file}
      onClose={onClose}
      title={files.length > 1 ? `Crop image ${index + 1} of ${files.length}` : 'Crop image'}
      size="lg"
      dismissable={false}
    >
      {file && (
        <CropStep
          key={`${index}-${file.name}`}
          file={file}
          spec={spec}
          last={index + 1 >= files.length}
          onDone={(img) => {
            onProcessed(img);
            next();
          }}
          onSkip={(reason) => {
            onSkip?.(file, reason);
            next();
          }}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}

function CropStep({ file, spec, last, onDone, onSkip, onCancel }: { file: File; spec: ProductImageSpec; last: boolean; onDone: (img: ProcessedImage) => void; onSkip: (reason?: string) => void; onCancel: () => void }) {
  const [img, setImg] = useState<LoadedImage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Created and revoked in the same effect: React's development double mount would otherwise revoke a URL
  // that the component keeps using (broken image).
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  useEffect(() => {
    let live = true;
    loadImage(file).then(
      (l) => (live ? setImg(l) : l.bitmap.close()),
      (e: Error) => live && setLoadError(e.message),
    );
    return () => {
      live = false;
    };
  }, [file]);
  useEffect(() => () => img?.bitmap.close(), [img]);

  const [stageRef, frameW] = useElementWidth<HTMLDivElement>();
  const frameH = frameW ? (frameW * spec.ratio.height) / spec.ratio.width : 0;

  // Scale = displayed px per source px. Cover the frame at least; zoom in only while the visible area still has
  // the product-page resolution (no upscaling).
  const minScale = img && frameW ? Math.max(frameW / img.width, frameH / img.height) : 1;
  const maxScale = img && frameW ? Math.min(frameW / spec.detail.width, frameH / spec.detail.height) : 1;
  const tooSmall = !!img && frameW > 0 && maxScale < minScale - 1e-9;
  const top = Math.max(minScale, maxScale);

  const [view, setView] = useState<View | null>(null);
  const clamp = (v: View): View => {
    if (!img) return v;
    const scale = Math.min(Math.max(v.scale, minScale), top);
    const w = img.width * scale;
    const h = img.height * scale;
    return { scale, x: Math.min(0, Math.max(frameW - w, v.x)), y: Math.min(0, Math.max(frameH - h, v.y)) };
  };
  // Start centred at "cover"; re-fit when the frame is resized.
  useEffect(() => {
    if (!img || !frameW) return;
    setView((v) => {
      if (!v) return clamp({ scale: minScale, x: (frameW - img.width * minScale) / 2, y: (frameH - img.height * minScale) / 2 });
      return clamp(v);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, frameW]);

  const zoomTo = (scale: number) =>
    setView((v) => {
      if (!v) return v;
      // Zoom around the frame centre.
      const cx = frameW / 2;
      const cy = frameH / 2;
      const k = scale / v.scale;
      return clamp({ scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
    });

  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!view) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX - view.x, y: e.clientY - view.y };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !view) return;
    setView(clamp({ ...view, x: e.clientX - d.x, y: e.clientY - d.y }));
  };
  const onPointerUp = () => (drag.current = null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!view) return;
    const step = e.shiftKey ? 50 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      setView(clamp({ ...view, x: view.x + moves[e.key][0], y: view.y + moves[e.key][1] }));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomTo(view.scale * 1.1);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomTo(view.scale / 1.1);
    }
  };

  const rect = (v: View): CropRect => ({ x: -v.x / v.scale, y: -v.y / v.scale, width: frameW / v.scale, height: frameH / v.scale });
  const sliderPct = view && top > minScale ? Math.round(((view.scale - minScale) / (top - minScale)) * 100) : 0;

  const confirm = async () => {
    if (!img || !view) return;
    setBusy(true);
    setError('');
    try {
      const r = rect(view);
      const detail = await encode(renderCrop(img, r, spec.detail), spec.quality);
      const thumb = await encode(renderCrop(img, r, spec.thumbnail), spec.quality);
      onDone({ file: new File([detail], renamed(file.name, detail.type), { type: detail.type }), thumbUrl: URL.createObjectURL(thumb), sourceName: file.name, crop: r });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const ratioText = `${spec.ratio.width}:${spec.ratio.height}`;
  const imgStyle = (k = 1): CSSProperties | undefined =>
    view && img ? { width: img.width * view.scale * k, height: img.height * view.scale * k, transform: `translate(${view.x * k}px, ${view.y * k}px)` } : undefined;
  const preview = (label: string, size: { width: number; height: number }, w: number) => (
    <figure className="crop-prev">
      <div className="crop-prev-frame" style={{ width: w, aspectRatio: `${spec.ratio.width} / ${spec.ratio.height}` }}>
        {view && url && <img src={url} alt="" style={imgStyle(w / frameW)} draggable={false} />}
      </div>
      <figcaption className="xs muted">
        {label}
        <br />
        <span className="num">{sizeText(size)}</span>
      </figcaption>
    </figure>
  );

  return (
    <div className="stack gap-4">
      <p className="small sub">
        {file.name} · product images are {ratioText}. Drag the photo to place the product, and zoom with the slider. It is saved at {sizeText(spec.detail)} for the product page and {sizeText(spec.thumbnail)} for lists.
      </p>
      {loadError ? (
        <Alert tone="danger" title="This image can’t be used">
          {loadError}
        </Alert>
      ) : tooSmall && img ? (
        <Alert tone="danger" title="This image is too small">
          It is {sizeText(img)}; a {ratioText} crop needs at least {sizeText(spec.detail)} so it stays sharp on phones. Choose a larger photo.
        </Alert>
      ) : null}
      {!loadError && (
        <div className="crop-body">
          <div
            ref={stageRef}
            className="crop-stage"
            // Width follows the screen height too, so a tall ratio (4:5) still fits without distorting the frame.
            style={{ aspectRatio: `${spec.ratio.width} / ${spec.ratio.height}`, maxWidth: `calc(60vh * ${spec.ratio.width} / ${spec.ratio.height})` }}
            role="application"
            aria-label={`Crop area, ${ratioText}. Drag or use the arrow keys to move the photo; plus and minus zoom.`}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            {view && img && url ? <img src={url} alt="" style={imgStyle()} draggable={false} /> : <span className="spinner" aria-label="Loading image" />}
            <span className="crop-grid" aria-hidden="true" />
          </div>
          <div className="stack gap-3 crop-side">
            <label className="stack gap-1">
              <span className="small strong">Zoom</span>
              <input
                type="range"
                className="crop-range"
                min={0}
                max={100}
                value={sliderPct}
                disabled={!view || tooSmall || top <= minScale}
                onChange={(e) => zoomTo(minScale + ((top - minScale) * Number(e.target.value)) / 100)}
                aria-valuetext={`${sliderPct}%`}
              />
            </label>
            {frameW > 0 && (
              <div className="row gap-3 items-end">
                {preview('Product page', spec.detail, 112)}
                {preview('Lists', spec.thumbnail, 64)}
              </div>
            )}
            {view && img && !tooSmall && <p className="xs muted">Visible area: {sizeText({ width: Math.round(frameW / view.scale), height: Math.round(frameH / view.scale) })} of {sizeText(img)} px</p>}
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="row between wrap gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <div className="row gap-2">
          <Button variant="secondary" onClick={() => onSkip(loadError || (tooSmall ? 'too small' : undefined))} disabled={busy}>
            {last ? 'Skip' : 'Skip this image'}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || !view || !!loadError || tooSmall}>
            {busy ? 'Preparing…' : 'Use this crop'}
          </Button>
        </div>
      </div>
    </div>
  );
}
