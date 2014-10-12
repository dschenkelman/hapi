// Export public modules

exports.version = require('../package.json').version;
exports.error = exports.Error = exports.boom = exports.Boom = require('boom');
exports.Server = require('./xxx');
exports.Pack = require('./server');

exports.state = {
    prepareValue: require('statehood').prepareValue
};

exports.createServer = function () {

    return new exports.Server(arguments[0], arguments[1], arguments[2]);
};
