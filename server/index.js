import { config } from './config.js';
import { prisma } from './db.js';
import { createApp } from './app.js';
import { startJobJanitor } from './services/cpqJobs.ts';
import { checkStoredCredentials } from './services/connection.service.js';

startJobJanitor();
await checkStoredCredentials().catch((err) => console.error('[crypto] credential check failed:', err.message));

const app = await createApp();
const server = app.listen(config.port, () => {
  console.log(`CPQ to RCA listening on ${config.appUrl} (port ${config.port}, ${config.env})`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
