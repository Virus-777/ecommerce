import type { FastifyRequest } from 'fastify';
import type { WebhookVerifier } from '../../../kernel/auth/chain.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/departments.js';
import type { DepartmentsService } from '../service.js';

/** The provider name a verified game key gives the request: game:<gameId> */
const GAME_PROVIDER = /^game:([0-9a-f-]{36})$/i;

/**
 * Game partners authenticate with their game's server key in X-Game-Key (no signature: the key is the credential,
 * made in Admin › Departments › Play center and kept as a hash). A missing, unknown or revoked key answers 401. The
 * provider is game:<id>, so each game has its own webhook rate limit.
 */
export const gameKeyVerifier =
  (service: DepartmentsService): WebhookVerifier =>
  async (request: FastifyRequest) => {
    const header = request.headers['x-game-key'];
    const gameId = await service.gameOfKey(typeof header === 'string' ? header : undefined);
    return gameId ? { provider: `game:${gameId}` } : false;
  };

/** The game the request's key belongs to */
const gameOf = (request: FastifyRequest): string => {
  const id = GAME_PROVIDER.exec(request.auth?.provider?.name ?? '')?.[1];
  if (!id) throw new AppError('UNAUTHORIZED', 'Send the game server key in X-Game-Key', { reason: 'signature_invalid' });
  return id;
};

/**
 * Webhooks: /webhooks/departments/…  (docs/api/modules/departments.md)
 * Game partners' servers post their players' scores.
 */
export const webhooksRoutes = (service: DepartmentsService) =>
  routes(endpoints, 'webhooks', {
    /** POST /play/scores: A game partner's server posts a customer's score */
    postGameScore: async ({ body, request }) => service.postGameScore(gameOf(request), body),
  });
