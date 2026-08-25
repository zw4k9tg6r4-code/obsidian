import cluster from 'node:cluster';

// If discovered and run directly as a test file by node --test runner, exit immediately.
if (!cluster.isWorker) {
  process.exit(0);
}

process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
