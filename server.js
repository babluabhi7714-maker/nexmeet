const path = require('path');

if (require.main === module) {
  require(path.join(__dirname, '..', 'server.js'));
} else {
  module.exports = require(path.join(__dirname, '..', 'server.js'));
}
