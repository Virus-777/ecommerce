# Backend update: product image crop and sizes

Requested by the web apps on 2026-10-16. The Customer Store, Seller Center and Admin Center are already built against this contract. Until the backend has it, they use the defaults in §2 and keep working.

**Goal.** Every product image has the same aspect ratio and only the two sizes a phone needs:

- **detail** — the product page and its gallery;
- **thumbnail** — search, category, cards, cart, orders, wishlist and the app's lists.

Staff set the ratio and both sizes in the Admin Center.

## 1. How it fits together

```
Seller Center (or Admin)                 Backend                                    Store / Android app
------------------------                 -------                                    -------------------
pick photo
crop to the spec ratio (ImageCropper) ──► POST /media/uploads (product_image)
resize to detail size, WebP/JPEG          upload bytes, complete
upload that file                          media.process:
                                            check ratio + size (§5)
                                            keep the file as the original
                                            build renditions: detail, thumb (§4) ──►  MediaRef.detailUrl / thumbUrl (§6)
Admin Center › Settings › Product images
POST /settings/changes media.productImage ► settings (approval) ──► GET /media/image-specs (§3) ──► every app
```

The client already sends the cropped image at exactly the detail size. The backend still has to:

1. make the thumbnail;
2. re-encode both sizes at the configured quality;
3. reject product images from any client (old app versions, scripts) that don't fit the spec;
4. tell every response which URL is which.

## 2. Setting `media.productImage`

Add it to the media module's settings (next to `renditionWidths`, which is read in `modules/media/service.ts` in the `renditions` step).

| Field | Value |
|---|---|
| key | `media.productImage` |
| section | `media` |
| label | Product images |
| valueType | `json` |
| default | `{"aspectRatio":"1:1","detailWidth":800,"thumbnailWidth":320,"quality":80}` |
| approval | `second_reviewer` (same as other media settings) |
| applyScopes | `new_only` |
| sellerVisible | `true` (sellers need the ratio and sizes; see §3) |
| editable | `true` |

Validate the value and answer `VALIDATION_FAILED` with field errors. These are the same rules the Admin Center checks in `web-shared/src/api/imageSpec.ts` (`validateProductImageSetting`):

- **`aspectRatio`:** `"W:H"`, whole numbers 1–32. Height ÷ width must be between 0.5 and 2, so 2:1 (wide) to 1:2 (tall).
- **`detailWidth`:** a whole number, 480–2048.
- **`thumbnailWidth`:** a whole number, 120–640, and smaller than `detailWidth`.
- **`quality`:** a whole number, 50–95.

Heights always follow from the ratio: `height = round(width × H ÷ W)`.

**Why these defaults.** A phone shows a full-width product image at about 390 points, which is 780 px on 2× screens. List cards are about 170 points, which is 340 px. So 800 px and 320 px are the smallest sizes that stay sharp, at about 75 KB and 12 KB as WebP.

**The Admin Center saves it** with the existing change flow. It sends `POST /api/admin/settings/changes` with `{ items: [{ key: 'media.productImage', value }], effectiveAt, applyScope: 'new_only', reason }`, then `POST /api/admin/settings/changes/{id}/submit`. No new admin endpoint is needed.

## 3. Read endpoint: `GET /api/{store|seller|admin}/media/image-specs`

All three areas need it:

- the store sets the frame ratio for cards and the gallery;
- the Seller Center sets up the cropper;
- the Admin Center shows the current values.

It needs the usual token (visitor, seller or staff), with no permission check: it's public product configuration. Answer:

```json
{
  "productImage": {
    "aspectRatio": "1:1",
    "detailWidth": 800,
    "thumbnailWidth": 320,
    "quality": 80,
    "ratio": { "width": 1, "height": 1 },
    "detail": { "width": 800, "height": 800 },
    "thumbnail": { "width": 320, "height": 320 }
  }
}
```

- The apps read the four setting fields and compute the rest themselves. Sending `ratio`, `detail` and `thumbnail` helps other clients, such as the Android app.
- The apps cache it for 10 minutes.
- **A 404 means "not built yet":** the apps fall back to the defaults. The fallback is in `fetchSpec`, `web-shared/src/api/imageSpec.ts`.
- Add it to the OpenAPI spec (`media.ProductImageSpec`) and the GraphQL `AppConfig` if the app reads its config there.

## 4. Renditions for product images

**Today:**

- `processImage` (`modules/media/service.ts`, steps `strip` → `renditions` → `check`) builds `thumb/small/medium/large/zoom` by width from `renditionWidths`.
- Only the development processor exists (`modules/media/providers/processing/dev.ts`), and it doesn't resize: every "rendition" holds the original bytes.

**Change for purposes `product_image`, plus `variant_image` and `offer_photo` usages that take product_image uploads:**

1. **Add `detail` to the size enum.** `Rendition.size` and the `refs()` size parameter become `thumb | small | medium | large | zoom | detail | poster | video_*`. Keep the old sizes for other purposes.
2. **Build exactly two renditions from the stripped original:**
   - `detail` at `detailWidth × detailHeight`;
   - `thumb` at `thumbnailWidth × thumbnailHeight`.

   Use cover fit, centred. That is a safety net only: correct uploads already have the ratio. Encode WebP at `quality`, with a JPEG fallback as today, and never enlarge. If the original is smaller than a size, the check in §5 has already refused it.
3. **Keep aliases for old readers until every module asks for `detail`/`thumb`:** `small` → `thumb`, `medium`/`large`/`zoom` → `detail`. That means no extra files, only URLs pointing at the same keys.
4. **Implement a real processor** with libvips/sharp, as the media module doc already plans: decode (HEIC too), auto-orient, strip, resize, encode. The dev processor can keep copying bytes, but should then record the real output size it pretends to have.
5. **Store the spec used** on the asset: `processing_spec: { aspectRatio, detailWidth, thumbnailWidth, quality, settingsVersion }`. Later rebuilds (§7) then know what to redo.

## 5. Checks at upload (`check` step, `evaluateImage`)

For `product_image`, pass the spec into `evaluateImage` instead of `{ aspectRatios: [] }`:

| Check | Rule | Code | Seller message |
|---|---|---|---|
| Ratio | \|w/h − W/H\| ÷ (W/H) > 1% | `wrong_aspect` | "Crop the image to 4:5. The Seller Center crops it for you when you upload." |
| Size | w < detailWidth or h < detailHeight | `too_small` | "The image must be at least 800 × 1000." |

- **Both reject the asset** (`media.asset.rejected`, `rejectionReason` set), the same as other blocking checks. The Seller Center shows `rejectionReason` next to the image.
- **Category standards:** `ImageStandard.aspectRatios` on categories (catalog) conflicts with the global ratio. Either drop the per-category ratio, or treat it as "must also match the global ratio". The apps follow only the global spec.
- **No server-side crop rectangle.** The browser sends the cropped file, so the upload spec needs no `crop` field.

## 6. Which size each response uses

`MediaRef` (common) gains two optional fields for product images, and keeps `url` for old readers:

```ts
interface MediaRef { id; url; alt; width; height; thumbUrl?: string | null; detailUrl?: string | null }
```

The apps already read them through `renditionUrl(media, 'thumb' | 'detail')` in `web-shared/src/api/imageSpec.ts`. They fall back to `renditions[].size`, then to `url`.

| Where | Size | Code |
|---|---|---|
| Product page gallery (REST product, GraphQL `Product.images`, `variants[].images`) | `detail` in `url` plus `thumbUrl` for the thumbnail strip | `catalog/service/views.ts` (refsMap, now `'medium'` by default) |
| Search hits, category and brand grids, collections, deals, home sections, similar products, storefront products | `thumb` | search index documents (image URL at index time), `content/service/base.ts` (`'large'` → `'thumb'` for product tiles) |
| Cart, checkout lines, order lines, returns, wishlist, recently viewed, Seller Center and Admin lists | `thumb` | cart/checkout/orders views, `customers/service/recently-viewed.ts` (`'small'` → `'thumb'`) |
| Seller and Admin product editors | `detail` plus `thumbUrl` | catalog seller/admin product views |

The search index stores image URLs, so it needs re-indexing after the change (`search.process-dirty` for all products, or a one-off job).

## 7. When staff change the setting

The change takes effect at `effectiveAt`, after approval. The `new_only` scope means new uploads use it. For existing images:

- **New sizes or quality, same ratio:**
  - run a job, `media.rebuild-product-renditions`, in batches, rate-limited. It rebuilds `detail` and `thumb` from each stored original.
  - never make a rendition larger than the original; if the original is smaller, keep its size and record it.
  - re-index search afterwards.
  - URLs can stay the same (overwrite the keys), with `Cache-Control` as today, or include a version.
- **New ratio:** existing images can't be re-cropped without the seller.
  - add the check result `wrong_aspect` (not blocking) to every product image with the old ratio.
  - show it on the seller's product, as "Re-crop images", and in the Admin catalog's "Missing content" tab.
  - keep the product live; the store's frames use the new ratio, and old images are shown cover-cropped.
  - send sellers a notification topic: `catalog.images.recrop_needed`.
- **Audit:** the settings change is already audited. Log the rebuild job's counts as well.

## 8. Tests to add

- **Setting validation:** each rule in §2, including thumbnail ≥ detail, 3:1 and 0:1.
- **Read endpoint:** visitor, seller and staff tokens get the same answer; there's no anonymous access.
- **Processing:**
  - an 800 × 800 upload gives `detail` 800 × 800 and `thumb` 320 × 320, in WebP and JPEG;
  - a 4:3 upload under a 1:1 spec gives `wrong_aspect`;
  - a 600 × 600 upload gives `too_small`;
  - HEIC decodes.
- **`refs()`:** `detail`/`thumb` sizes, the aliases, and `thumbUrl`/`detailUrl` filled for product images only.
- **Rebuild job:** a changed width rebuilds both sizes; no enlargement; it is idempotent.
- **Ratio change:** old images are flagged; products stay live.

## 9. What the apps already do (for reference)

- **Shared code** (`web-shared`):
  - `src/api/imageSpec.ts`: the spec types, defaults, validation, `useProductImageSpec()` and `renditionUrl()`, plus `ProductImageRatio`, which sets the CSS variable `--product-ratio`.
  - `src/lib/crop.ts`: decode with orientation, crop, step-down resize, WebP/JPEG encode.
  - `src/ui/ImageCropper.tsx`: the crop dialog (drag, zoom, keyboard, previews of both sizes). It refuses images smaller than the detail size.
- **Seller Center:** the new-product page (`seller-center/src/pages/ProductNew.tsx`) crops every picked image, uploads the detail-sized file and shows the local thumbnail until the server answers.
- **Admin Center:** Settings › Product images (`admin-center/src/pages/admin/data/product-image-settings.tsx`) edits the setting through the change flow.
- **Store:**
  - card and gallery frames use `--product-ratio` (`web-shared/src/styles/app.css`);
  - the product page asks for `detail` for the main image and `thumb` for gallery thumbnails, variant swatches and similar products (`frontend/src/pages/store/Product.tsx`).
