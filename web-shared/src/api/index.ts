// Marketly API client for the web apps. REST types are generated from docs/api/openapi.json
// (npm run gen:api); GraphQL screen queries run through createGraphql. See web-shared/docs/API.md.
export { ApiProvider, useApi, useSessionState } from './provider';
export { call, newIdempotencyKey, type Api } from './client';
export { ApiError, errorMessage, toApiError } from './errors';
export type { Audience, SessionSnapshot, SessionTokens, TokenClaims, TokenKind } from './session';
export type { paths, components } from './openapi';
export { uploadMedia, useUploads, assetPreview, fileSize, type MediaAsset, type UploadItem, type UploadPurpose } from './uploads';
