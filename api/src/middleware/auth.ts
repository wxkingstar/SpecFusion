import type { FastifyRequest, FastifyReply } from 'fastify';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token';

export function verifyAdminToken(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_TOKEN}`) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
