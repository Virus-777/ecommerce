/**
 * The Fastify server every API area runs on: the spec's error format `{ error: { code, message, details } }`,
 * X-Request-Id, and raw bodies for webhook signatures. Spec routes bring their own Zod compilers
 * (register.ts); everything else (GraphQL, /docs) keeps Fastify's defaults.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import type { Config } from '../config/index.js';
import { AppError, codeForStatus, isNotImplemented } from '../errors/index.js';
import { newId } from '../lib/ids.js';
import { installSecurity } from './security.js';

/** Trust the nearest n proxies (TRUST_PROXY=<n>) */
const hops = (n: number) => (_address: string, hop: number) => hop < n;

export function createServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // tokens, proofs and cookies never reach the logs
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-app-proof"]'],
            ...(config.env === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
          },
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[\w-]{1,100}$/.test(h) ? h : newId();
    },
    routerOptions: { ignoreTrailingSlash: true },
    // the client IP for rate limits comes through the proxies named in TRUST_PROXY, never from a spoofable header otherwise
    trustProxy: typeof config.trustProxy === 'number' ? hops(config.trustProxy) : config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });
  installSecurity(app, config);

  // Fastify's JSON parser (with its prototype-poisoning protection), keeping the raw text for webhook signatures
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (request.url.startsWith('/webhooks/')) request.rawBody = body as string;
    if (body === '') return done(null, undefined);
    parseJson(request, body as string, done);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500 && !isNotImplemented(err)) request.log.error({ err }, err.message);
      const retryAfter = err.status === 429 ? retryAfterSeconds(err.details) : undefined;
      if (retryAfter) reply.header('retry-after', String(retryAfter));
      return reply.code(err.status).send(err.toBody());
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({ path: [err.validationContext, ...String(v.instancePath).split('/').filter(Boolean)].join('.'), message: v.message }));
      return reply.code(400).send(new AppError('VALIDATION_FAILED', 'Some fields are missing or invalid', { issues }).toBody());
    }
    if (isResponseSerializationError(err)) {
      request.log.error({ err, issues: err.cause?.issues }, 'response does not match the spec');
      const details = config.env === 'production' ? undefined : { issues: err.cause?.issues };
      return reply.code(500).send(new AppError('INTERNAL_ERROR', 'The response did not match the API spec', details, 500).toBody());
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send(new AppError('INTERNAL_ERROR', 'Something went wrong. Include the X-Request-Id when reporting it.', undefined, 500).toBody());
    }
    return reply.code(status).send(new AppError(codeForStatus(status), err.message, undefined, status).toBody());
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(new AppError('NOT_FOUND', `No route ${request.method} ${request.url.split('?')[0]}`).toBody());
  });
  return app;
}

/**
 * Retry-After (seconds) for a 429: the middleware's and modules' `details.retryAfterSeconds`, or a
 * lock's `details.lockedUntil`. Nothing when the refusal doesn't say when to retry.
 */
function retryAfterSeconds(details: unknown): number | undefined {
  const d = details as { retryAfterSeconds?: unknown; lockedUntil?: unknown } | undefined;
  if (typeof d?.retryAfterSeconds === 'number' && d.retryAfterSeconds > 0) return Math.ceil(d.retryAfterSeconds);
  if (typeof d?.lockedUntil === 'string') {
    const s = Math.ceil((Date.parse(d.lockedUntil) - Date.now()) / 1000);
    if (s > 0) return s;
  }
  return undefined;
}
