import express, { Router } from 'express';
import { prisma } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { getLogoForUser, MAX_LOGO_BYTES, validateLogo } from '../services/branding.js';

const router = Router();
router.use(requireAuth);

/** GET /api/branding/logo — the logo used in generated documents (custom or company default). */
router.get('/logo', async (req, res) => {
  const logo = await getLogoForUser(req.user.id);
  if (!logo) throw notFound('No logo configured');
  res.setHeader('Content-Type', logo.type === 'png' ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Logo-Source', logo.source);
  res.end(logo.data);
});

router.get('/logo/info', async (req, res) => {
  const logo = await getLogoForUser(req.user.id);
  res.json({ source: logo?.source ?? 'none', width: logo?.width ?? null, height: logo?.height ?? null });
});

/** PUT /api/branding/logo — raw PNG/JPEG body (Content-Type image/png or image/jpeg), max 2 MB. */
router.put('/logo', express.raw({ type: ['image/png', 'image/jpeg'], limit: MAX_LOGO_BYTES }), async (req, res) => {
  const { error, info } = validateLogo(req.body);
  if (error) throw badRequest(error);
  await prisma.user.update({
    where: { id: req.user.id },
    data: { logoImage: info.data, logoMime: info.type === 'png' ? 'image/png' : 'image/jpeg', logoUpdatedAt: new Date() },
  });
  res.json({ source: 'custom', width: info.width, height: info.height });
});

/** DELETE /api/branding/logo — revert to the company default logo. */
router.delete('/logo', async (req, res) => {
  await prisma.user.update({ where: { id: req.user.id }, data: { logoImage: null, logoMime: null, logoUpdatedAt: null } });
  res.json({ source: 'default' });
});

export default router;
