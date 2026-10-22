import { useCallback, useRef, useState } from 'react';
import { endIfUnauthorized } from './client';
import { ApiError, errorMessage, toApiError } from './errors';
import type { components } from './openapi';
import { useApi } from './provider';
import type { Session } from './session';

// File uploads through the media module (docs/api/modules/media.md, "Upload flow"), for every app:
//   POST /api/<area>/media/uploads → send the bytes to the ticket URL → POST …/uploads/{id}/complete
//   → poll GET …/assets/{id} until processing (scan, metadata strip, renditions) makes it ready.

export type MediaAsset = components['schemas']['media.MediaAsset'];

/** Upload purposes (media/domain/rules.ts). Store: review_photo, message_attachment, return_evidence,
 *  case_evidence, verification_document. Seller and admin areas add product_image, content_image, … */
export type UploadPurpose =
  | 'review_photo'
  | 'message_attachment'
  | 'return_evidence'
  | 'case_evidence'
  | 'verification_document'
  | 'product_image'
  | 'content_image'
  | (string & {});

interface Ticket {
  uploadId: string;
  assetId: string;
  url: string;
  method: 'PUT' | 'POST';
  headers?: Record<string, unknown>;
  fields?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(session: Session, method: string, path: string, body?: unknown): Promise<T> {
  const send = async (token: string) =>
    fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'X-Client': 'web', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res = await send(await session.token());
  if (res.status === 401) res = await send(await session.refresh());
  if (res.status === 401) endIfUnauthorized(session, 401, await res.clone().json().catch(() => undefined));
  if (!res.ok) throw await toApiError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Sends the bytes with XMLHttpRequest so the caller sees upload progress (fetch can't report it); answers like fetch. */
function sendWithProgress(url: string, method: string, headers: Headers | undefined, body: BodyInit, onProgress: (sent: number, total: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    headers?.forEach((v, k) => x.setRequestHeader(k, v));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    x.onload = () => resolve(new Response([101, 204, 205, 304].includes(x.status) ? null : x.responseText, { status: x.status, statusText: x.statusText, headers: { 'Content-Type': x.getResponseHeader('Content-Type') ?? 'application/json' } }));
    x.onerror = () => reject(new TypeError('Failed to fetch'));
    x.onabort = () => reject(new TypeError('Upload cancelled'));
    x.send(body as XMLHttpRequestBodyInit);
  });
}

/**
 * Uploads one file and resolves with the ready asset (its `id` goes into `mediaIds`/`imageIds`).
 * Development storage receives the bytes through the API itself (/api/<area>/media/uploads/{id}/content,
 * same origin through the dev proxy, with the session token); provider storage gets a pre-signed URL.
 * onProgress reports the bytes sent (large files such as software packages); the asset is then checked and processed.
 */
export async function uploadMedia(session: Session, file: File, purpose: UploadPurpose, o: { alt?: string; timeoutMs?: number; onProgress?: (sent: number, total: number) => void } = {}): Promise<MediaAsset> {
  const base = `/api/${session.audience}/media`;
  // Browsers on Windows report .csv as application/vnd.ms-excel: spreadsheets are typed by their extension.
  const contentType = /\.csv$/i.test(file.name) ? 'text/csv' : /\.xlsx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : file.type || 'application/octet-stream';
  const spec = { purpose, fileName: file.name, contentType, sizeBytes: file.size, ...(o.alt ? { alt: o.alt } : {}) };
  // The admin area wraps the upload and names the owner (platform content).
  const ticket = await api<Ticket>(session, 'POST', `${base}/uploads`, session.audience === 'admin' ? { upload: spec, ownerKind: 'platform' } : spec);

  const target = new URL(ticket.url, window.location.origin);
  const own = target.pathname.startsWith('/api/');
  const headers = new Headers(Object.fromEntries(Object.entries(ticket.headers ?? {}).map(([k, v]) => [k, String(v)])));
  let body: BodyInit = file;
  if (own) {
    headers.set('Authorization', `Bearer ${await session.token()}`);
    headers.set('X-Client', 'web');
    // The API's content route consumes application/octet-stream only (the ticket's image/* header gets 415;
    // reported in BACKEND-REQUESTS.md). The file's type was declared when the upload started.
    headers.set('Content-Type', 'application/octet-stream');
  } else if (ticket.method === 'POST' && ticket.fields && Object.keys(ticket.fields).length) {
    const form = new FormData();
    Object.entries(ticket.fields).forEach(([k, v]) => form.append(k, String(v)));
    form.append('file', file);
    body = form;
  }
  const sendTo = own ? target.pathname + target.search : ticket.url;
  const sendHeaders = ticket.method === 'POST' && !own ? undefined : headers;
  const sent = o.onProgress ? await sendWithProgress(sendTo, ticket.method, sendHeaders, body, o.onProgress) : await fetch(sendTo, { method: ticket.method, headers: sendHeaders, body });
  if (!sent.ok) throw await toApiError(sent);

  // The seller and admin areas answer {asset, usages, …}; the store area answers the asset itself.
  const unwrap = (r: MediaAsset | { asset: MediaAsset }): MediaAsset => ('asset' in r && r.asset ? r.asset : (r as MediaAsset));
  let asset = unwrap(await api<MediaAsset | { asset: MediaAsset }>(session, 'POST', `${base}/uploads/${ticket.uploadId}/complete`));
  const until = Date.now() + (o.timeoutMs ?? 90_000);
  while (asset.status === 'processing' || asset.status === 'pending_upload') {
    if (Date.now() > until) throw new ApiError(504, 'UPLOAD_TIMEOUT', `${file.name} is taking too long to process. Try again in a moment.`);
    await sleep(1500);
    asset = unwrap(await api<MediaAsset | { asset: MediaAsset }>(session, 'GET', `${base}/assets/${ticket.assetId}`));
  }
  if (asset.status !== 'ready') throw new ApiError(422, 'UPLOAD_REJECTED', asset.rejectionReason || `${file.name} couldn’t be used. Try another file.`);
  return asset;
}

/** Best preview URL of a ready image asset (product images keep `detail` and `thumb`; other images `small` too). */
export const assetPreview = (a: Pick<MediaAsset, 'renditions' | 'url'>): string =>
  a.renditions?.find((r) => r.size === 'thumb')?.url ?? a.renditions?.find((r) => r.size === 'small')?.url ?? a.renditions?.[0]?.url ?? a.url ?? '';

/**
 * The name to show for an uploaded file (attachments, evidence, documents): the API's `fileName` (MediaRef and
 * MediaAsset, G31d). Only records without one fall back to the last segment of the URL's path (signed URLs carry
 * a storage key there, not the uploaded name).
 */
export function mediaFileName(m: { fileName?: string | null; url?: string | null }, fallback = 'File'): string {
  if (m.fileName) return m.fileName;
  try {
    const last = new URL(m.url ?? '', 'http://x').pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : fallback;
  } catch {
    return fallback;
  }
}

/** "212 KB" */
export const fileSize = (bytes?: number | null): string =>
  !bytes ? '' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'failed';
  assetId?: string;
  url?: string;
  error?: string;
}

/**
 * A list of files uploading for one form field; uploads start when files are picked.
 *   const photos = useUploads('case_evidence');
 *   <FileDrop onFiles={photos.add} /> … mediaIds: photos.assetIds
 */
export function useUploads(purpose: UploadPurpose, opts: { max?: number; maxBytes?: number; accept?: RegExp; onReady?: (item: UploadItem) => void } = {}) {
  const { session } = useApi();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const count = useRef(0);
  const { max = 5, maxBytes = 10 * 1024 * 1024, accept, onReady } = opts;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const update = (key: string, patch: Partial<UploadItem>) => setItems((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const add = useCallback(
    (files: File[]) => {
      const ok = files.filter((f) => f.size <= maxBytes && (!accept || accept.test(f.name) || accept.test(f.type)));
      const room = Math.max(0, max - count.current);
      const take = ok.slice(0, room);
      setError(ok.length < files.length ? 'Some files were skipped: check the file type and size.' : ok.length > room ? `You can attach up to ${max} files.` : '');
      const added = take.map((f) => ({ key: `u${++seq.current}`, name: f.name, size: f.size, status: 'uploading' as const }));
      count.current += added.length;
      setItems((current) => [...current, ...added]);
      added.forEach((a, i) => {
        uploadMedia(session, take[i], purpose).then(
          (asset) => {
            const done = { ...a, status: 'ready' as const, assetId: asset.id, url: assetPreview(asset) || undefined };
            update(a.key, done);
            onReadyRef.current?.(done);
          },
          (e) => update(a.key, { status: 'failed', error: errorMessage(e) }),
        );
      });
    },
    [session, purpose, max, maxBytes, accept],
  );

  const remove = useCallback((key: string) => {
    count.current = Math.max(0, count.current - 1);
    setItems((l) => l.filter((x) => x.key !== key));
  }, []);
  const clear = useCallback(() => {
    count.current = 0;
    setItems([]);
    setError('');
  }, []);

  return {
    items,
    error,
    add,
    remove,
    clear,
    /** Asset ids of the files that finished processing. */
    assetIds: items.filter((i) => i.status === 'ready').map((i) => i.assetId!),
    uploading: items.some((i) => i.status === 'uploading'),
    failed: items.some((i) => i.status === 'failed'),
  };
}
