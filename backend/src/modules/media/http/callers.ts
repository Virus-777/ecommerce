/** Who owns what a caller uploads, and which files the caller reaches (record scope). */
import type { FastifyRequest } from 'fastify';
import { signInRequired, type Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import type { MediaOwner } from '../../../spec/media.js';
import type { Uploader } from '../domain/rules.js';
import type { OwnerFilter } from '../ports.js';
import type { UploadArea, UploadTarget } from '../service.js';

export interface Caller {
  uploader: Uploader;
  owner: MediaOwner;
  /** Record scope: only files of this owner */
  filter: OwnerFilter;
  createdBy: { kind: string; id: string | null };
}

/** Store: customer uploads belong to the customer account, guest uploads to the guest session */
export function storeCaller(scope: Scope, principal: Principal): Caller {
  if (scope.kind === 'customer') {
    return { uploader: 'customer', owner: { kind: 'customer', id: scope.accountId }, filter: { kind: 'customer', id: scope.accountId }, createdBy: { kind: 'customer', id: scope.accountId } };
  }
  if (scope.kind === 'visitor') {
    return { uploader: 'guest', owner: { kind: 'guest', id: scope.visitorSessionId }, filter: { kind: 'guest', id: scope.visitorSessionId }, createdBy: { kind: 'visitor', id: principal.sessionId } };
  }
  throw signInRequired();
}

/** Seller Center: files belong to the seller account (any member with media.assets.upload), never to the person */
export function sellerCaller(sellerId: string, principal: Principal): Caller {
  return { uploader: 'seller', owner: { kind: 'seller', id: sellerId }, filter: { kind: 'seller', id: sellerId }, createdBy: { kind: 'seller', id: principal.accountId ?? null } };
}

/** Where an upload ticket sends the bytes when storage is served by the API: this area's PUT /uploads/{id}/content, at the address the caller used */
export function uploadTarget(area: UploadArea, request: FastifyRequest): UploadTarget {
  return { area, origin: `${request.protocol}://${request.host}` };
}
