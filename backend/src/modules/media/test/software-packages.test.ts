/** Software packages (purpose software_package, departments phase 3): staff-only, private, streamed, no renditions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { EICAR } from '../providers/scanner.js';
import { callers, mediaApp, mediaTable, startUpload, uploadFile, type MediaTestApp } from './helpers.js';

let t: MediaTestApp;
beforeAll(async () => {
  t = await mediaApp();
});
afterAll(async () => {
  await t?.app.close();
});

const PLATFORM = { kind: 'platform' as const };
const bytes = (n: number, fill = 0x50) => Buffer.alloc(n, fill);

describe('software packages', () => {
  it('stores an app package uploaded by staff: private, kind software, no renditions, typed by its extension', async () => {
    const staff = callers.staff();
    const { asset } = await uploadFile(t, 'admin', staff, { purpose: 'software_package', fileName: 'PixelCraft-Studio-3.4.1.apk', contentType: 'application/octet-stream', body: bytes(4096) });
    expect(asset).toMatchObject({ status: 'ready', kind: 'software', purpose: 'software_package', visibility: 'private', sizeBytes: 4096, contentType: 'application/vnd.android.package-archive', owner: { kind: 'platform' } });
    expect(asset.renditions ?? []).toEqual([]);
    expect(await mediaTable(t.app, 'renditions').find({ asset_id: asset.id })).toEqual([]);

    // attached as a software_file; other usages refuse it
    await t.media.attach(asset.id, { module: 'software', kind: 'software_file', refId: newId(), refLabel: 'PixelCraft Studio' }, PLATFORM);
    await expect(t.media.attach(asset.id, { module: 'content', kind: 'content_block', refId: newId() }, PLATFORM)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // downloads are attachments, never inline
    const link = await t.media.signedDownload(asset.id, { kind: 'customer', accountId: newId() } as never, 'software download');
    expect(link).toMatchObject({ fileName: 'PixelCraft-Studio-3.4.1.apk', sizeBytes: 4096 });
    expect(new URL(link.url).searchParams.get('cd')).toBe('attachment; filename="PixelCraft-Studio-3.4.1.apk"');
  });

  it('accepts databases and installers by content type or extension, up to 4 GB, and refuses other types', async () => {
    const staff = callers.staff();
    for (const [fileName, contentType] of [
      ['presets.sqlite', 'application/vnd.sqlite3'],
      ['luts.db', 'application/octet-stream'],
      ['Setup.exe', 'application/x-msdownload'],
      ['app.dmg', 'application/x-apple-diskimage'],
      ['bundle.7z', 'application/x-7z-compressed'],
      ['tool.AppImage', 'application/octet-stream'],
    ]) {
      const res = await startUpload(t, 'admin', staff, { purpose: 'software_package', fileName, contentType, sizeBytes: 4 * 1024 ** 3 });
      expect(res.statusCode, `${fileName}: ${res.body}`).toBe(201);
      expect(res.json().maxBytes).toBe(4 * 1024 ** 3);
      expect((await t.media.getAsset(res.json().assetId))?.kind).toBe('software');
    }
    let res = await startUpload(t, 'admin', staff, { purpose: 'software_package', fileName: 'big.zip', contentType: 'application/zip', sizeBytes: 4 * 1024 ** 3 + 1 });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    res = await startUpload(t, 'admin', staff, { purpose: 'software_package', fileName: 'icon.png', contentType: 'image/png', sizeBytes: 1000 });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    // a package is never a product image or a bulk file
    res = await startUpload(t, 'admin', staff, { purpose: 'bulk_file', fileName: 'data.zip', contentType: 'application/zip', sizeBytes: 1000 });
    expect(res.json().error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('is staff-only', async () => {
    expect((await startUpload(t, 'seller', callers.seller(), { purpose: 'software_package', fileName: 'a.zip', contentType: 'application/zip' })).json().error.code).toBe('PURPOSE_NOT_ALLOWED');
    expect((await startUpload(t, 'store', callers.customer(), { purpose: 'software_package', fileName: 'a.zip', contentType: 'application/zip' })).json().error.code).toBe('PURPOSE_NOT_ALLOWED');
  });

  it('scans the package as a stream and rejects malware, also across chunk boundaries', async () => {
    const staff = callers.staff();
    // the signature straddles the 64 KiB chunks the stores read in
    const body = Buffer.concat([bytes(65_536 - 20), Buffer.from(EICAR, 'latin1'), bytes(10_000)]);
    const scanner = t.media.providers.scanner;
    const whole = scanner.scan;
    scanner.scan = async () => {
      throw new Error('software packages are scanned as a stream');
    };
    try {
      const { asset } = await uploadFile(t, 'admin', staff, { purpose: 'software_package', fileName: 'Setup.zip', contentType: 'application/zip', body });
      expect(asset).toMatchObject({ status: 'rejected', rejectionReason: expect.stringMatching(/Malware found/) });
    } finally {
      scanner.scan = whole;
    }
  });
});
