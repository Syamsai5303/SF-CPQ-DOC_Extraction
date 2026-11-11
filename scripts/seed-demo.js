/**
 * Local demo data: a demo user with two Salesforce connections (UAT + Production).
 * Pair it with CPQ_DEMO_ORG=true so "Extract CPQ catalog" reads a synthetic CPQ org
 * instead of Salesforce. Development only.
 *
 *   npm run seed:demo
 *   Log in as:  demo  /  demo-password-1
 */
import bcrypt from 'bcrypt';
import { config } from '../server/config.js';
import { prisma } from '../server/db.js';
import { encryptJson } from '../server/lib/crypto.js';

if (config.isProd) {
  console.error('Refusing to seed demo data with NODE_ENV=production');
  process.exit(1);
}

const DEMO = { email: 'demo@cpq2rca.test', username: 'demo', password: 'demo-password-1' };

let user = await prisma.user.findUnique({ where: { email: DEMO.email } });
if (!user) {
  user = await prisma.user.create({
    data: { email: DEMO.email, username: DEMO.username, passwordHash: await bcrypt.hash(DEMO.password, config.bcryptRounds) },
  });
}

for (const [name, env] of [
  ['Acme UAT', 'UAT'],
  ['Acme Production', 'PRODUCTION'],
]) {
  const exists = await prisma.salesforceConnection.findFirst({ where: { userId: user.id, name } });
  if (exists) {
    // Re-seal the dummy secret with the current ENCRYPTION_KEY (fixes demo rows after a key change).
    await prisma.salesforceConnection.update({
      where: { id: exists.id },
      data: { encryptedCredentials: encryptJson({ password: 'demo', securityToken: '' }, config.encryptionKey, user.id), status: 'ACTIVE', lastError: null },
    });
    continue;
  }
  const c = await prisma.salesforceConnection.create({
    data: {
      userId: user.id,
      name,
      environmentType: env,
      authType: 'USERNAME_PASSWORD',
      loginUrl: env === 'PRODUCTION' ? 'https://login.salesforce.com' : 'https://test.salesforce.com',
      sfUsername: `integration@acme.${env.toLowerCase()}`,
      // Dummy secret, encrypted like real ones. Demo mode never sends it anywhere.
      encryptedCredentials: encryptJson({ password: 'demo', securityToken: '' }, config.encryptionKey, user.id),
      status: 'ACTIVE',
      orgId: '00DDEMO00000001',
      instanceUrl: 'https://demo.my.salesforce.com',
      lastVerified: new Date(),
    },
  });
  if (!user.activeConnectionId) user = await prisma.user.update({ where: { id: user.id }, data: { activeConnectionId: c.id } });
}

console.log(`Demo user ready: log in as "${DEMO.username}" (password in scripts/seed-demo.js). Start the app with CPQ_DEMO_ORG=true.`);
await prisma.$disconnect();
