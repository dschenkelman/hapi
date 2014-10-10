// Load modules

var Events = require('events');
var Http = require('http');
var Https = require('https');
var Os = require('os');
var Path = require('path');
var Boom = require('boom');
var Heavy = require('heavy');
var Hoek = require('hoek');
var LruCache = require('lru-cache');
var Shot = require('shot');
var Statehood = require('statehood');
var Vision = require('vision');
var Auth = require('./auth');
var Defaults = require('./defaults');
var Ext = require('./ext');
var Headers = require('./response/headers');
var Realm = require('./realm');
var Request = require('./request');
var Response = require('./response');
var Route = require('./route');
var Router = require('./router');
var Schema = require('./schema');
var Utils = require('./utils');
// Pack delayed required inline


// Declare internals

var internals = {};


exports = module.exports = internals.Server = function (/* host, port, options */) {        // all optional

    Hoek.assert(this.constructor === internals.Server, 'Server must be instantiated using new');

    var Pack = require('./pack');           // Delayed required to avoid circular dependencies

    // Register as event emitter

    Events.EventEmitter.call(this);

    // Validate arguments

    Hoek.assert(arguments.length <= 4, 'Too many arguments');          // 4th is for internal Pack usage

    var argMap = {
        string: 'host',
        number: 'port',
        object: 'options'
    };

    var args = {};
    for (var a = 0, al = arguments.length; a < al; ++a) {
        var argVal = arguments[a];
        if (argVal === undefined) {
            continue;
        }

        if (argVal instanceof Pack) {
            args.pack = arguments[a];
            continue;
        }

        var type = typeof argVal;

        if (type === 'string' && isFinite(+argVal)) {
            type = 'number';
            argVal = +argVal;
        }

        var key = argMap[type];
        Hoek.assert(key, 'Bad server constructor arguments: no match for arg type:', type);
        Hoek.assert(!args[key], 'Bad server constructor arguments: duplicated arg type:', type, '(values: `' + args[key] + '`, `' + argVal + '`)');
        args[key] = argVal;
    }

    this._realm = new Realm(args.options);
    this.settings = this._realm.settings;

    // Set basic configuration

    this._unixDomainSocket = (args.host && args.host.indexOf('/') !== -1);
    this._windowsNamedPipe = (args.host && args.host.indexOf('\\\\.\\pipe\\') === 0);
    Hoek.assert(!this._unixDomainSocket || args.port === undefined, 'Cannot specify port with a UNIX domain socket');
    Hoek.assert(!this._windowsNamedPipe || args.port === undefined, 'Cannot specify port with a Windows named pipe');
    this._host = (args.host ? (this._unixDomainSocket ? Path.resolve(args.host) : (this._windowsNamedPipe ? args.host : args.host.toLowerCase())) : '');
    this._port = (args.port !== undefined ? args.port : (this.settings.tls ? 443 : 80));
    this._onConnection = null;          // Used to remove event listener on stop

    // Server facilities

    this._started = false;
    this.auth = this._realm.auth;
    this._etags = this._realm._etags;
    this._views = this._realm._views;
    this._router = this._realm._router;

    this._heavy = new Heavy(this.settings.load);
    this.load = this._heavy.load;
    this._ext = this._realm._ext;

    this._stateDefinitions = this._realm._stateDefinitions;
    this._registrations = {};

    if (args.pack) {
        this.pack = args.pack;
    }
    else {
        this.pack = new Pack({ cache: this.settings.cache, debug: this.settings.debug });
        this.pack._server(this);
    }

    this.plugins = {};                                      // Registered plugin APIs by plugin name
    this.app = {};                                          // Place for application-specific state without conflicts with hapi, should not be used by plugins
    this.methods = this.pack._methods.methods;              // Method functions

    // Create server

    if (this.settings.tls) {
        this.listener = Https.createServer(this.settings.tls, this._dispatch());
    }
    else {
        this.listener = Http.createServer(this._dispatch());
    }

    // Server information

    this.info = {
        host: this._host || '0.0.0.0'
    };

    if (this._unixDomainSocket ||
        this._windowsNamedPipe) {

        this.info.port = 0;
        this.info.protocol = (this._unixDomainSocket ? 'unix' : 'windows');
        this.info.uri = this.info.protocol + ':' + this._host;
    }
    else {
        this.info.port = this._port || 0;
        this.info.protocol = (this.settings.tls ? 'https' : 'http');

        if (this.info.port) {
            this.info.uri = this.info.protocol + '://' + (this._host || Os.hostname() || 'localhost') + ':' + this.info.port;
        }
    }
};

Hoek.inherits(internals.Server, Events.EventEmitter);


internals.Server.prototype._dispatch = function (options) {

    var self = this;

    options = options || {};

    return function (req, res) {

        // Create request

        var request = new Request(self, req, res, options);

        // Check load

        if (!self._heavy.check()) {
            self.log(['hapi', 'load'], self.load);
            request._reply(Boom.serverTimeout('Server under heavy load', self.load));
        }
        else {

            // Execute request lifecycle

            request._protect.domain.run(function () {

                request._execute();
            });
        }
    };
};


internals.Server.prototype.table = function (host) {

    return this._router.table(host);
};


internals.Server.prototype.start = function (callback) {

    this.pack.start(callback);
};


internals.Server.prototype._start = function (callback) {

    if (this._started) {
        return Hoek.nextTick(callback)();
    }

    this._started = true;

    this._init(callback);       // callback is called after this.listener.listen()

    if (this._unixDomainSocket ||
        this._windowsNamedPipe) {

        this.listener.listen(this._host);
    }
    else {
        this.listener.listen(this._port, this._host);
    }
};


internals.Server.prototype._init = function (callback) {

    var self = this;

    // Load measurements

    this._heavy.start();

    // Setup listener

    this._connections = {};
    var onListening = function () {

        // Update the host, port, and uri with active values

        if (!self._unixDomainSocket ||
            !self._windowsNamedPipe) {

            var address = self.listener.address();
            self.info.host = self._host || address.address || '0.0.0.0';
            self.info.port = address.port;
            self.info.uri = self.info.protocol + '://' + (self._host || Os.hostname() || 'localhost') + ':' + self.info.port;
        }

        return callback();
    };

    this.listener.once('listening', onListening);

    this._onConnection = function (connection) {

        var key = connection.remoteAddress + ':' + connection.remotePort;
        self._connections[key] = connection;

        connection.once('close', function () {

            delete self._connections[key];
        });
    };

    this.listener.on('connection', this._onConnection);

    return this.listener;
};


internals.Server.prototype.stop = function (options, callback) {

    this.pack.stop(options, callback);
};


internals.Server.prototype._stop = function (options, callback) {

    var self = this;

    options = options || {};
    options.timeout = options.timeout || 5000;                                              // Default timeout to 5 seconds

    if (!this._started) {
        return Hoek.nextTick(callback)();
    }

    this._started = false;
    this._heavy.stop();

    var timeoutId = setTimeout(function () {

        Object.keys(self._connections).forEach(function (key) {

            self._connections[key].destroy();
        });
    }, options.timeout);

    this.listener.close(function () {

        self.listener.removeListener('connection', self._onConnection);
        clearTimeout(timeoutId);
        callback();
    });
};


internals.Server.prototype.log = function (tags, data, timestamp) {

    this.pack.log(tags, data, timestamp, this);
};


internals.Server.prototype.ext = function (event, func, options) {

    return this._ext.add(event, func, options, { views: this._views });
};


internals.Server.prototype._ext = function () {

    return this._ext.add.apply(this._ext, arguments);
};


internals.Server.prototype.route = function (configs) {

    this._route(configs);
};


internals.Server.prototype._route = function (configs, env) {

    Router.add(this, configs, env);
};


internals.Server.prototype.state = function (name, options) {

    Schema.assert('state', options, name);
    this._stateDefinitions.add(name, options);
};


internals.Server.prototype.views = function (options) {

    Hoek.assert(!this._views, 'Cannot set server views manager more than once');
    this._views = this._realm._views = new Vision.Manager(options, Response);
};


internals.Server.prototype.render = function (template, context /*, options, callback */) {

    var options = arguments.length === 4 ? arguments[2] : {};
    var callback = arguments.length === 4 ? arguments[3] : arguments[2];

    Hoek.assert(this._views, 'Missing server views manager');
    return this._views.render(template, context, options, callback);
};


internals.Server.prototype.cache = function (name, options) {

    Schema.assert('cachePolicy', options, name);
    Hoek.assert(!options.segment, 'Cannot override segment name in server cache');
    return this.pack._provisionCache(options, 'server', name);
};


internals.Server.prototype.inject = function (options, callback) {

    var settings = options;
    if (settings.credentials) {
        settings = Utils.shallow(options);              // options can be reused
        delete settings.credentials;
    }

    var needle = this._dispatch({ credentials: options.credentials });
    Shot.inject(needle, settings, function (res) {

        if (res.raw.res._hapi) {
            res.result = res.raw.res._hapi.result;
            delete res.raw.res._hapi;
        }
        else {
            res.result = res.payload;
        }

        return callback(res);
    });
};


internals.Server.prototype.method = function () {

    return this.pack._method.apply(this.pack, arguments);
};


internals.Server.prototype.handler = function () {

    return this.pack._handler.apply(this.pack, arguments);
};


internals.Server.prototype.location = function (uri, request) {

    return Headers.location(uri, this, request);
};
