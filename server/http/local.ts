import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context } from 'hono';

/**
 * The request comes from this machine (directly or through the Vite dev proxy), addressed to a local
 * name: a web page that rebinds its own domain to 127.0.0.1 still sends that domain as Host.
 */
export function isLocal(c: Context) {
  const host = (c.req.header('host') ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return /^(127\.|::1$|::ffff:127\.)/.test(getConnInfo(c).remote.address ?? '') && ['localhost', '127.0.0.1', '::1'].includes(host);
}
