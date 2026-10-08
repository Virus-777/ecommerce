/**
 * The Fastify server every API area runs on: Zod validation, the spec's error format
 * `{ error: { code, message, details } }`, X-Request-Id, and raw bodies for webhook signatures.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from '../config/index.js';
import { AppError } from '../errors/index.js';
import { newId } from '../lib/ids.js';

const isZod = (s: unknown) => typeof s === 'object' && s !== null && '_zod' in s;

export function createServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, ...(config.env === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}) },
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[\w-]{1,100}$/.test(h) ? h : newId();
    },
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: 2 * 1024 * 1024,
  });

  // Spec routes use Zod schemas; plugin routes (GraphQL, /docs) bring plain JSON schemas
  app.setValidatorCompiler((route) => (isZod(route.schema) ? validatorCompiler(route as never) : (data: unknown) => ({ value: data })));
  app.setSerializerCompiler((route) =>
    isZod(route.schema) && config.responseValidation ? serializerCompiler(route as never) : (data: unknown) => JSON.stringify(data),
  );

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // webhook signatures are computed over the raw body
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    try {
      if (request.url.startsWith('/webhooks/')) request.rawBody = body as string;
      done(null, body === '' ? undefined : JSON.parse(body as string));
    } catch (err) {
      done(new AppError('VALIDATION_FAILED', 'Request body is not valid JSON', { issues: [{ path: 'body', message: (err as Error).message }] }) as never, undefined);
    }
  });

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500 && err.code !== 'NOT_IMPLEMENTED') request.log.error({ err }, err.message);
      return reply.code(err.status).send(err.toBody());
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({ path: [err.validationContext, ...String(v.instancePath).split('/').filter(Boolean)].join('.'), message: v.message }));
      return reply.code(400).send(new AppError('VALIDATION_FAILED', 'Some fields are missing or invalid', { issues }).toBody());
    }
    if (isResponseSerializationError(err)) {
      request.log.error({ err, issues: err.cause?.issues }, 'response does not match the spec');
      const details = config.env === 'production' ? undefined : { issues: err.cause?.issues };
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'The response did not match the API spec', ...(details ? { details } : {}) } });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Include the X-Request-Id when reporting it.' } });
    }
    const code = status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 429 ? 'RATE_LIMITED' : 'VALIDATION_FAILED';
    return reply.code(status).send(new AppError(code, err.message, undefined, status).toBody());
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(new AppError('NOT_FOUND', `No route ${request.method} ${request.url.split('?')[0]}`).toBody());
  });
  return app;
}
