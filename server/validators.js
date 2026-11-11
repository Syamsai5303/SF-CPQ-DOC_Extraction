import { z } from 'zod';

const trimmed = (max = 255) => z.string().trim().max(max);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  // bcrypt only uses the first 72 bytes
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes');

export const registerSchema = z.object({
  email: trimmed().toLowerCase().pipe(z.string().email('Enter a valid email')),
  username: trimmed(50)
    .min(3, 'Username must be at least 3 characters')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain letters, numbers, dot, dash and underscore')
    .transform((u) => u.toLowerCase()),
  password: passwordSchema,
});

export const loginSchema = z.object({
  identifier: trimmed().min(1, 'Email or username is required').transform((s) => s.toLowerCase()),
  password: z.string().min(1, 'Password is required').max(200),
});

export const forgotPasswordSchema = z.object({
  email: trimmed().toLowerCase().pipe(z.string().email('Enter a valid email')),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

// ---- Salesforce ----
// Secrets are optional here: when blank and credentials are already saved,
// the stored (encrypted) value is reused. Completeness is checked after merging.
const optionalSecret = z.string().max(500).optional().default('');

export const usernamePasswordSchema = z.object({
  authType: z.literal('USERNAME_PASSWORD'),
  loginUrl: trimmed(500).min(1, 'Login URL is required'),
  username: trimmed().min(1, 'Salesforce username is required'),
  password: optionalSecret,
  securityToken: optionalSecret,
});

export const clientCredentialsSchema = z.object({
  authType: z.literal('OAUTH_CLIENT_CREDENTIALS'),
  tokenUrl: trimmed(500).min(1, 'Auth/Token URL is required'),
  clientId: trimmed(500).min(1, 'Client ID is required'),
  clientSecret: optionalSecret,
});

export const credentialInputSchema = z.discriminatedUnion('authType', [usernamePasswordSchema, clientCredentialsSchema]);

export const ENVIRONMENT_TYPES = ['PRODUCTION', 'SANDBOX', 'UAT', 'DEVELOPER', 'OTHER'];

export const connectionMetaSchema = z.object({
  name: trimmed(60).min(1, 'Connection name is required'),
  environmentType: z.enum(ENVIRONMENT_TYPES, { errorMap: () => ({ message: 'Choose an environment type' }) }),
});

/** Ad-hoc test: credentials plus an optional connectionId whose saved secrets fill blank fields. */
export const testInputSchema = z.intersection(credentialInputSchema, z.object({ connectionId: z.string().optional() }));

export const extractCatalogSchema = z.object({
  connectionId: z.string().optional(), // defaults to the user's active connection
  includeInactive: z.boolean().optional().default(true),
});

export const generateAssessmentSchema = z.object({
  extractionId: z.string().min(1, 'extractionId is required'),
});
