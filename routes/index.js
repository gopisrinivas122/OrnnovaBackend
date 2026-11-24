const registerHandlers = require('./handlers');
const authRoutes = require('./auth.routes');
const registerImportRoutes = require('./import.routes');
const registerOfferRoutes = require('./offer.routes');

module.exports = (app) => {
  app.use(authRoutes);
  registerHandlers(app);
  registerImportRoutes(app);
  registerOfferRoutes(app);
};
