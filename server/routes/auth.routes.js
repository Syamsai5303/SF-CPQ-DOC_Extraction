import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { sendPasswordResetEmail } from '../lib/mailer.js';
import { clearSession, issueSession, requireAuth } from '../middleware/auth.js';
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema } from '../validators.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in a few minutes' },
});

// Used to equalise timing when the user does not exist (prevents user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', config.bcryptRounds);

const publicUser = (u) => ({ id: u.id, email: u.email, username: u.username, createdAt: u.createdAt });

router.post('/register', authLimiter, async (req, res) => {
  const { email, username, password } = registerSchema.parse(req.body);

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { email: true },
  });
  if (existing) {
    throw conflict(existing.email === email ? 'An account with this email already exists' : 'This username is taken');
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const user = await prisma.user.create({ data: { email, username, passwordHash } });
  issueSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', authLimiter, async (req, res) => {
  const { identifier, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findFirst({
    where: identifier.includes('@') ? { email: identifier } : { username: identifier },
  });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid email/username or password');

  issueSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  // Same response whether or not the account exists (prevents email enumeration).
  const response = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.json(response);

  const rawToken = randomToken(32);
  const expiresAt = new Date(Date.now() + config.resetTokenTtlMinutes * 60 * 1000);
  await prisma.$transaction([
    // Only the newest link is valid.
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
    prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(rawToken), expiresAt } }),
  ]);

  const resetUrl = `${config.appUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (err) {
    console.error('[forgot-password] failed to send email:', err.message);
  }
  res.json(response);
});

router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest('This reset link is invalid or has expired. Please request a new one.');
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  await prisma.$transaction(async (tx) => {
    // Conditional update guards against the same token being redeemed twice concurrently;
    // throwing rolls the whole transaction back.
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw badRequest('This reset link has already been used.');
    await tx.user.update({
      where: { id: record.userId },
      // Bumping tokenVersion signs out every existing session.
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    await tx.passwordResetToken.deleteMany({ where: { userId: record.userId, id: { not: record.id } } });
  });

  clearSession(res);
  res.json({ ok: true, message: 'Password updated. Please log in with your new password.' });
});

export default router;
