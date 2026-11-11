import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { unauthorized } from '../lib/errors.js';

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax',
  path: '/',
});

export function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, tv: user.tokenVersion }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    algorithm: 'HS256',
  });
  const { exp } = jwt.decode(token);
  res.cookie(config.jwt.cookieName, token, { ...cookieOptions(), expires: new Date(exp * 1000) });
}

export function clearSession(res) {
  res.clearCookie(config.jwt.cookieName, cookieOptions());
}

/** Guards a route: requires a valid session cookie whose tokenVersion is still current. */
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[config.jwt.cookieName];
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch {
    clearSession(res);
    throw unauthorized('Session expired, please log in again');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, username: true, tokenVersion: true, createdAt: true },
  });
  if (!user || user.tokenVersion !== payload.tv) {
    clearSession(res);
    throw unauthorized('Session expired, please log in again');
  }

  req.user = user;
  next();
}
