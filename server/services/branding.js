import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../db.js';
import { readImageInfo } from './docGenerator.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// client/public in development; client/dist in the production image (Vite copies public/).
const DEFAULT_LOGO_PATHS = [path.join(ROOT, 'client', 'public', 'logo.png'), path.join(ROOT, 'client', 'dist', 'logo.png')];

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

let defaultLogo;
export function getDefaultLogo() {
  if (defaultLogo !== undefined) return defaultLogo;
  const file = DEFAULT_LOGO_PATHS.find((p) => fs.existsSync(p));
  defaultLogo = file ? readImageInfo(fs.readFileSync(file)) : null;
  return defaultLogo;
}

/** The user's uploaded logo if any, else the company default (client/public/logo.png). */
export async function getLogoForUser(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { logoImage: true } });
  if (user?.logoImage) {
    const info = readImageInfo(Buffer.from(user.logoImage));
    if (info) return { ...info, source: 'custom' };
  }
  const def = getDefaultLogo();
  return def ? { ...def, source: 'default' } : null;
}

/** Validates by magic bytes (not the client-supplied content type). */
export function validateLogo(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Upload a PNG or JPEG image' };
  if (buf.length > MAX_LOGO_BYTES) return { error: 'Logo must be 2 MB or smaller' };
  const info = readImageInfo(buf);
  if (!info) return { error: 'Only PNG and JPEG images are supported' };
  if (info.width < 16 || info.height < 16 || info.width > 8000 || info.height > 8000) return { error: 'Logo dimensions look invalid' };
  return { info };
}
