// Admin authentication: scrypt password hashes and short-lived signed tokens (JWT, HS256).
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { settings } from './config.js';
import { HttpError } from './errors.js';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(expected, actual);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (data) => createHmac('sha256', settings.jwtSecret).update(data).digest('base64url');

export function issueToken(admin, nowMs = Date.now()) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: admin.id, email: admin.email, role: admin.role, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + settings.tokenHours * 3600 });
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

export function readToken(token, nowMs = Date.now()) {
  const [head, body, sig] = String(token).split('.');
  if (!head || !body || !sig) return null;
  const good = Buffer.from(sign(`${head}.${body}`));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  return claims.exp * 1000 > nowMs ? claims : null;
}

/** Express middleware: requires a valid admin token; optionally a specific role. */
export const requireAdmin = (role) => (req, _res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const claims = m && readToken(m[1]);
  if (!claims) return next(new HttpError(401, 'unauthorized', 'Please sign in again.'));
  if (role && claims.role !== role) return next(new HttpError(403, 'forbidden', 'You do not have permission to do that.'));
  req.admin = claims;
  next();
};

// Patient "manage booking" tokens: random, only their hash is stored.
export const newManageToken = () => randomBytes(18).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export function tokenMatches(token, storedHash) {
  const a = Buffer.from(hashToken(token)), b = Buffer.from(String(storedHash));
  return a.length === b.length && timingSafeEqual(a, b);
}
