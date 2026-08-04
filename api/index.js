// Vercel serverless function entry point.
// Re-exports the Express app defined in server.js.
const app = require('../server.js');

module.exports = app;
