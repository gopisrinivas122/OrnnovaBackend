const app = require('./app');
const { PORT } = require('./config/env');
const logger = require('./utils/logger');

const server = app.listen(PORT, () => {
  logger.info(`Listening to Port ${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. Stop the other process first:`);
    logger.error(`  lsof -ti:${PORT} | xargs kill -9`);
    process.exit(1);
  }
  throw err;
});
