import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  call, errorMessage, parseRatio, PRODUCT_IMAGE_LIMITS, productImageSpecKey, resolveProductImageSpec, sizeText, useApi, useProductImageSpec, validateProductImageSetting,
  type ProductImageSetting,
} from '@marketly/web-shared/api';
import { Alert, announce, Badge, Button, Card, Field, Select, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date } from '@/app/parts';
import { effectiveInstant } from './staff';
import { dayFromToday, type SettingChange, type SettingDetail } from './settings';

// Settings › Product images (designed in React; no design file): the aspect ratio every product image is cropped
// to, the product-page and thumbnail sizes the backend keeps, and the encoder quality. Saved as the setting
// `media.productImage` through the settings change flow (draft → submit with a reason; a second reviewer
// approves, as the definition says). The current values come from GET media/image-specs; the definition
// (GET settings/values/media.productImage) gives the notice period (minLeadDays), and GET settings/changes?key=…
// lists changes waiting for approval or scheduled. Existing images are rebuilt or flagged for re-crop by the
// backend's job once the change takes effect.

const SETTING_KEY = 'media.productImage';

const RATIOS = [
  { value: '1:1', label: '1:1 Square' },
  { value: '4:5', label: '4:5 Portrait' },
  { value: '3:4', label: '3:4 Portrait' },
  { value: '4:3', label: '4:3 Landscape' },
  { value: '16:9', label: '16:9 Wide' },
  { value: 'custom', label: 'Custom…' },
];

/** Rough WebP size at this many pixels and quality (about 0.12 bytes per pixel at quality 80). */
const approxKb = (w: number, h: number, q: number) => Math.max(1, Math.round((w * h * 0.12 * (q / 80)) / 1024));

interface Form {
  ratio: string;
  custom: string;
  detailWidth: string;
  thumbnailWidth: string;
  quality: string;
}

const toForm = (s: ProductImageSetting): Form => {
  const preset = RATIOS.some((r) => r.value === s.aspectRatio);
  return { ratio: preset ? s.aspectRatio : 'custom', custom: preset ? '' : s.aspectRatio, detailWidth: String(s.detailWidth), thumbnailWidth: String(s.thumbnailWidth), quality: String(s.quality) };
};
const fromForm = (f: Form): ProductImageSetting => ({
  aspectRatio: (f.ratio === 'custom' ? f.custom : f.ratio).replace(/\s/g, ''),
  detailWidth: Number(f.detailWidth),
  thumbnailWidth: Number(f.thumbnailWidth),
  quality: Number(f.quality),
});

function Frame({ label, w, h, max }: { label: string; w: number; h: number; max: number }) {
  // Drawn to scale against the larger image (max px wide).
  const k = 120 / Math.max(max, 1);
  return (
    <figure className="stack gap-1" style={{ margin: 0 }}>
      <div className="imgph tint-2" style={{ width: Math.max(18, w * k), aspectRatio: `${w} / ${h}` }} aria-hidden="true" />
      <figcaption className="xs muted">
        <span className="small strong u-c-text">{label}</span>
        <br />
        <span className="num">{sizeText({ width: w, height: h })} px</span>
      </figcaption>
    </figure>
  );
}

/** The Settings › Products section (`id` is its anchor for the section list). */
export function ProductImageSettingsCard({ id }: { id?: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canPropose = can('settings.changes.propose');
  const { spec, loading } = useProductImageSpec();
  const current: ProductImageSetting = { aspectRatio: spec.aspectRatio, detailWidth: spec.detailWidth, thumbnailWidth: spec.thumbnailWidth, quality: spec.quality };

  const detail = useQuery({ queryKey: ['settings', 'value', SETTING_KEY], queryFn: () => call(api.GET('/api/admin/settings/values/{key}', { params: { path: { key: SETTING_KEY } } })) as Promise<SettingDetail>, enabled: can('settings.view') });
  const pending = useQuery({
    queryKey: ['settings', 'changes', SETTING_KEY],
    enabled: can('settings.view'),
    queryFn: async () => {
      const [a, b] = await Promise.all(
        (['pending_approval', 'scheduled'] as const).map((status) => call(api.GET('/api/admin/settings/changes', { params: { query: { key: SETTING_KEY, status, limit: 5 } } })) as Promise<{ items: SettingChange[] }>),
      );
      return [...a.items, ...b.items];
    },
  });
  const lead = detail.data?.definition.minLeadDays ?? 0;
  const earliest = dayFromToday(lead);

  const [form, setForm] = useState<Form>(() => toForm(current));
  const [effective, setEffective] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'danger'; title: string; text: string } | null>(null);
  // Load the saved values once they arrive (the card first renders with the app defaults).
  useEffect(() => {
    if (!loading) setForm(toForm(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, spec.aspectRatio, spec.detailWidth, spec.thumbnailWidth, spec.quality]);

  const value = fromForm(form);
  const errors = validateProductImageSetting(value);
  const valid = Object.keys(errors).length === 0;
  const preview = resolveProductImageSpec(valid ? value : current);
  const changed = JSON.stringify(value) !== JSON.stringify(current);
  const set = (k: keyof Form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const effectiveDay = effective && effective > earliest ? effective : earliest;
  const save = useMutation({
    mutationFn: async () => {
      const draft = (await call(
        api.POST('/api/admin/settings/changes', { body: { items: [{ key: SETTING_KEY, value }], effectiveAt: effectiveInstant(effectiveDay), applyScope: 'new_only', reason: reason.trim() } }),
      )) as SettingChange;
      if (draft.impact.blocking.length) {
        // Don't leave a draft behind that can't be submitted.
        await call(api.POST('/api/admin/settings/changes/{id}/cancel', { params: { path: { id: draft.id } }, body: { reason: 'Not saved: blocked by the impact check' } })).catch(() => undefined);
        return draft;
      }
      return (await call(api.POST('/api/admin/settings/changes/{id}/submit', { params: { path: { id: draft.id } }, body: { reason: reason.trim() } }))) as SettingChange;
    },
    onSuccess: (c) => {
      if (c.status === 'draft') {
        setNotice({ tone: 'danger', title: 'The change can’t be saved yet', text: c.impact.blocking.map((b) => (typeof b === 'string' ? b : ((b as { message?: string }).message ?? ''))).join(' ') });
        return;
      }
      const what = `${value.aspectRatio}, product page ${sizeText(preview.detail)}, thumbnail ${sizeText(preview.thumbnail)}, quality ${value.quality}`;
      if (c.status === 'pending_approval') {
        const who = c.impact.approvers.join(' or ') || 'a second reviewer';
        setNotice({ tone: 'info', title: 'Sent for approval', text: `${what}. ${who} approves it; it takes effect ${date(c.effectiveAt)}. Until then the current settings stay in place.` });
      } else {
        setNotice({ tone: 'success', title: 'Product image settings scheduled', text: `${what}. They take effect ${date(c.effectiveAt)}.` });
      }
      announce('Product image settings sent');
      setReason('');
      setTried(false);
      void qc.invalidateQueries({ queryKey: productImageSpecKey('admin') });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'The change wasn’t saved', text: errorMessage(e) }),
  });
  const waiting = pending.data ?? [];
  const valueOf = (c: SettingChange) => {
    const v = c.items.find((i) => i.key === SETTING_KEY)?.to as ProductImageSetting | undefined;
    return v ? `${v.aspectRatio}, product page ${v.detailWidth} px, thumbnail ${v.thumbnailWidth} px, quality ${v.quality}` : c.items.map((i) => i.toText).join(', ');
  };

  const submit = () => {
    setTried(true);
    if (!valid || !reason.trim() || !changed) return;
    setNotice(null);
    save.mutate();
  };

  const ratio = parseRatio(value.aspectRatio);
  const L = PRODUCT_IMAGE_LIMITS;

  return (
    <Card
      id={id}
      className="ac-sect"
      title="Product images"
      titleClassName="h3"
      sub="Every product image is cropped to this ratio when it is uploaded, then kept in two sizes: the product page and the thumbnail used in lists, search, cart, orders and the app."
      actions={
        <>
          {waiting.some((c) => c.status === 'pending_approval') && (
            <Badge tone="warning" icon="hourglass">
              Approval pending
            </Badge>
          )}
          {waiting.some((c) => c.status === 'scheduled') && (
            <Badge tone="warning" icon="calendar-clock">
              Change scheduled
            </Badge>
          )}
          {spec.fromServer ? <Badge tone="success">Saved on the server</Badge> : <Badge tone="warning">App defaults in use</Badge>}
        </>
      }
    >
      <div className="stack gap-4">
        {notice && (
          <Alert tone={notice.tone} title={notice.title}>
            {notice.text}
          </Alert>
        )}
        {!spec.fromServer && !loading && (
          <Alert tone="warning" title="The saved settings couldn’t be loaded">
            The values below are the apps’ defaults (1:1, 800 × 800 and 320 × 320). Reload the page before changing them.
          </Alert>
        )}
        {waiting.map((c) => (
          <Alert key={c.id} tone="info" title={c.status === 'pending_approval' ? `${c.ref} is waiting for approval` : `${c.ref} is scheduled`}>
            {valueOf(c)} · takes effect {date(c.effectiveAt)}
            {c.status === 'pending_approval' ? `. ${c.impact.approvers.join(' or ') || 'A second reviewer'} approves it.` : '.'}
          </Alert>
        ))}
        <div className="grid md2 lg4 gap-3">
          <Field label="Aspect ratio" error={tried && form.ratio !== 'custom' ? errors.aspectRatio : undefined}>
            <Select id="pi-ratio" options={RATIOS} value={form.ratio} onChange={(e) => set('ratio')(e.target.value)} disabled={!canPropose} />
          </Field>
          {form.ratio === 'custom' && (
            <Field label="Custom ratio" hint="width:height, e.g. 2:3" error={tried ? errors.aspectRatio : undefined}>
              <TextInput id="pi-custom" value={form.custom} onChange={(e) => set('custom')(e.target.value)} placeholder="2:3" disabled={!canPropose} />
            </Field>
          )}
          <Field label="Product page width" hint={valid ? `Height ${preview.detail.height} px · ${L.detailWidth.min}–${L.detailWidth.max}` : `${L.detailWidth.min}–${L.detailWidth.max} px`} error={tried ? errors.detailWidth : undefined}>
            <TextInput id="pi-detail" type="number" inputMode="numeric" value={form.detailWidth} onChange={(e) => set('detailWidth')(e.target.value)} disabled={!canPropose} />
          </Field>
          <Field label="Thumbnail width" hint={valid ? `Height ${preview.thumbnail.height} px · ${L.thumbnailWidth.min}–${L.thumbnailWidth.max}` : `${L.thumbnailWidth.min}–${L.thumbnailWidth.max} px`} error={tried ? errors.thumbnailWidth : undefined}>
            <TextInput id="pi-thumb" type="number" inputMode="numeric" value={form.thumbnailWidth} onChange={(e) => set('thumbnailWidth')(e.target.value)} disabled={!canPropose} />
          </Field>
          <Field label="Image quality" hint={`${L.quality.min}–${L.quality.max} · 80 recommended`} error={tried ? errors.quality : undefined}>
            <TextInput id="pi-quality" type="number" inputMode="numeric" value={form.quality} onChange={(e) => set('quality')(e.target.value)} disabled={!canPropose} />
          </Field>
        </div>
        <div className="row gap-6 wrap items-end">
          <Frame label="Product page" w={preview.detail.width} h={preview.detail.height} max={Math.max(preview.detail.width, preview.detail.height)} />
          <Frame label="Thumbnail" w={preview.thumbnail.width} h={preview.thumbnail.height} max={Math.max(preview.detail.width, preview.detail.height)} />
          <p className="xs muted" style={{ maxWidth: 420 }}>
            About {approxKb(preview.detail.width, preview.detail.height, preview.quality)} KB and {approxKb(preview.thumbnail.width, preview.thumbnail.height, preview.quality)} KB per image (WebP). Phones show a
            full-width product image at about 390 points (780 px on 2× screens) and list cards at about 170 points (340 px), so 800 and 320 px are the smallest sizes that stay sharp.
            {ratio && ratio.width !== ratio.height && ' Store frames follow the ratio, so cards change shape too.'}
          </p>
        </div>
        {canPropose ? (
          <div className="grid md2 gap-3 items-end">
            <Field label="Takes effect" hint={lead ? `At least ${lead} days from today, so sellers are told before it starts.` : 'The change can start today.'}>
              <TextInput id="pi-effective" type="date" icon="calendar" min={earliest} value={effectiveDay} onChange={(e) => setEffective(e.target.value)} />
            </Field>
            <Field label="Reason for the change" error={tried && !reason.trim() ? 'Say why, for the change history and the approver.' : undefined}>
              <TextInput id="pi-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Portrait photos for fashion" />
            </Field>
            <div className="row gap-2">
              <Button onClick={submit} disabled={save.isPending || !changed}>
                {save.isPending ? 'Saving…' : 'Save for new uploads'}
              </Button>
              <Button variant="ghost" onClick={() => (setForm(toForm(current)), setTried(false))} disabled={save.isPending || !changed}>
                Reset
              </Button>
            </div>
          </div>
        ) : (
          <p className="xs muted">Changing these needs the “Propose changes” permission (Platform Administrator).</p>
        )}
        <p className="xs muted">
          Applies to images uploaded after the change. A new size rebuilds existing images from their saved files (never larger than they were uploaded); a new ratio asks sellers to re-crop
          existing images.
        </p>
      </div>
    </Card>
  );
}
