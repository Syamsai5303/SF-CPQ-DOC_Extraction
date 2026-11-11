// Prints fresh values for JWT_SECRET and ENCRYPTION_KEY. Usage: npm run gen:secrets
import crypto from 'node:crypto';

console.log(`JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
