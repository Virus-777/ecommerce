// Marketly API client for the web apps. REST types are generated from docs/api/openapi.json
// (npm run gen:api); GraphQL screen queries run through createGraphql. See web-shared/docs/API.md.
export { ApiProvider, useApi, useSessionState } from './provider';
export { call, newIdempotencyKey, type Api } from './client';
export { ApiError, errorMessage, toApiError } from './errors';
export type { Audience, SessionSnapshot, SessionTokens, TokenClaims, TokenKind } from './session';
export type { paths, components } from './openapi';
export { useAppConfig, useMarket, APP_CONFIG_KEY, type AppConfig, type PublicMarket, type DeliveryLocation } from './appConfig';
export { uploadMedia, useUploads, assetPreview, fileSize, mediaFileName, type MediaAsset, type UploadItem, type UploadPurpose } from './uploads';
export {
  useProductImageSpec, ProductImageRatio, resolveProductImageSpec, validateProductImageSetting, parseRatio, renditionUrl, sizeText, productImageSpecKey,
  DEFAULT_PRODUCT_IMAGE_SETTING, DEFAULT_PRODUCT_IMAGE_SPEC, PRODUCT_IMAGE_LIMITS, type ProductImageSetting, type ProductImageSpec, type Size,
} from './imageSpec';
