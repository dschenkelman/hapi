// Load modules

var Os = require('os');
var Hoek = require('hoek');
var LruCache = require('lru-cache');
var Statehood = require('statehood');
var Vision = require('vision');
var Auth = require('./auth');
var Ext = require('./ext');
var Schema = require('./schema');


// Declare internals

var internals = {};


internals.defaults = {
    server: {

        // TLS

        // tls: {
        //
        //     key: '',
        //     cert: ''
        // },

        maxSockets: Infinity,                           // Sets http/https globalAgent maxSockets value. null is node default.

        // Router

        router: {
            isCaseSensitive: true,                      // Case-sensitive paths
            stripTrailingSlash: false                   // Remove trailing slash from incoming paths
        },

        // State

        state: {
            cookies: {
                parse: true,                            // Parse content of req.headers.cookie
                failAction: 'error',                    // Action on bad cookie - 'error': return 400, 'log': log and continue, 'ignore': continue
                clearInvalid: false,                    // Automatically instruct the client to remove the invalid cookie
                strictHeader: true                      // Require an RFC 6265 compliant header format
            }
        },

        // Location

        location: '',                                   // Base uri used to prefix non-absolute outgoing Location headers ('http://example.com:8080'). Must not contain trailing '/'.

        // Cache header

        cacheControlStatus: [200],                      // Array of HTTP statuc codes for which cache-control header is set

        // Payload

        payload: {
            maxBytes: 1024 * 1024,
            uploads: Os.tmpDir()
        },

        // Validation

        validation: null,                               // Joi validation options

        // JSON

        json: {
            replacer: null,
            space: null,
            suffix: null
        },

        // Files path

        files: {
            relativeTo: '.',                            // Determines what file and directory handlers use to base relative paths off
            etagsCacheMaxSize: 10000                    // Maximum number of etags in the cache
        },

        // timeout limits

        timeout: {
            socket: undefined,                          // Determines how long before closing request socket. Defaults to node (2 minutes)
            client: 10 * 1000,                          // Determines how long to wait for receiving client payload. Defaults to 10 seconds
            server: false                               // Determines how long to wait for server request processing. Disabled by default
        },

        // Debug

        debug: {
            request: ['implementation']
        },

        // Pack

        labels: [],                                     // Server pack labels

        // Optional components

        cors: false,                                    // CORS headers on responses and OPTIONS requests (defaults: exports.cors): false -> null, true -> defaults, {} -> override defaults
        security: false                                 // Security headers on responses (defaults exports.security): false -> null, true -> defaults, {} -> override defaults
    },
    cors: {
        origin: ['*'],
        isOriginExposed: true,                          // Return the list of supported origins if incoming origin does not match
        matchOrigin: true,                              // Attempt to match incoming origin against allowed values and return narrow response
        maxAge: 86400,                                  // One day
        headers: [
            'Authorization',
            'Content-Type',
            'If-None-Match'
        ],
        additionalHeaders: [],
        methods: [
            'GET',
            'HEAD',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
            'OPTIONS'
        ],
        additionalMethods: [],
        exposedHeaders: [
            'WWW-Authenticate',
            'Server-Authorization'
        ],
        additionalExposedHeaders: [],
        credentials: false
    },
    security: {
        hsts: 15768000,
        xframe: 'deny',
        xss: true,
        noOpen: true,
        noSniff: true
    }
};


exports = module.exports = internals.Realm = function (options) {

    this.settings = Hoek.applyToDefaultsWithShallow(internals.defaults.server, options || {}, ['app', 'plugins']);
    Schema.assert('server', this.settings);

    this.settings.labels = Hoek.unique([].concat(this.settings.labels));       // Convert string to array and removes duplicates

    // Set basic configuration

    Hoek.assert(!this.settings.location || this.settings.location.charAt(this.settings.location.length - 1) !== '/', 'Location setting must not contain a trailing \'/\'');
    var socketTimeout = (this.settings.timeout.socket === undefined ? 2 * 60 * 1000 : this.settings.timeout.socket);
    Hoek.assert(!this.settings.timeout.server || !socketTimeout || this.settings.timeout.server < socketTimeout, 'Realm timeout must be shorter than socket timeout');
    Hoek.assert(!this.settings.timeout.client || !socketTimeout || this.settings.timeout.client < socketTimeout, 'Client timeout must be shorter than socket timeout');

    // Realm facilities

    this.auth = new Auth(this);
    this._etags = (this.settings.files.etagsCacheMaxSize ? LruCache({ max: this.settings.files.etagsCacheMaxSize }) : null);
    this._views = null;

    /*
        onRequest:      New request, before handing over to the router (allows changes to the request method, url, etc.)
        onPreAuth:      After cookie parse and before authentication (skipped if state error)
        onPostAuth:     After authentication (and payload processing) and before validation (skipped if auth or payload error)
        onPreHandler:   After validation and body parsing, before route handler (skipped if auth or validation error)
        onPostHandler:  After route handler returns, before sending response (skipped if onPreHandler not called)
        onPreResponse:  Before response is sent (always called)
    */

    this._ext = new Ext(['onRequest', 'onPreAuth', 'onPostAuth', 'onPreHandler', 'onPostHandler', 'onPreResponse']);

    this._stateDefinitions = new Statehood.Definitions(this.settings.state.cookies);

    this.plugins = {};                                      // Registered plugin APIs by plugin name
    this.app = {};                                          // Place for application-specific state without conflicts with hapi, should not be used by plugins

    // Generate CORS headers

    this.settings.cors = Hoek.applyToDefaults(internals.defaults.cors, this.settings.cors);
    if (this.settings.cors) {
        this.settings.cors._headers = this.settings.cors.headers.concat(this.settings.cors.additionalHeaders).join(', ');
        this.settings.cors._methods = this.settings.cors.methods.concat(this.settings.cors.additionalMethods).join(', ');
        this.settings.cors._exposedHeaders = this.settings.cors.exposedHeaders.concat(this.settings.cors.additionalExposedHeaders).join(', ');

        if (this.settings.cors.origin.length) {
            this.settings.cors._origin = {
                any: false,
                qualified: [],
                qualifiedString: '',
                wildcards: []
            };

            if (this.settings.cors.origin.indexOf('*') !== -1) {
                Hoek.assert(this.settings.cors.origin.length === 1, 'Cannot specify cors.origin * together with other values');
                this.settings.cors._origin.any = true;
            }
            else {
                for (var c = 0, cl = this.settings.cors.origin.length; c < cl; ++c) {
                    var origin = this.settings.cors.origin[c];
                    if (origin.indexOf('*') !== -1) {
                        this.settings.cors._origin.wildcards.push(new RegExp('^' + Hoek.escapeRegex(origin).replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$'));
                    }
                    else {
                        this.settings.cors._origin.qualified.push(origin);
                    }
                }

                Hoek.assert(this.settings.cors.matchOrigin || !this.settings.cors._origin.wildcards.length, 'Cannot include wildcard origin values with matchOrigin disabled');
                this.settings.cors._origin.qualifiedString = this.settings.cors._origin.qualified.join(' ');
            }
        }
    }

    // Generate security headers

    this.settings.security = Hoek.applyToDefaults(internals.defaults.security, this.settings.security);
    if (this.settings.security) {
        if (this.settings.security.hsts) {
            if (this.settings.security.hsts === true) {
                this.settings.security._hsts = 'max-age=15768000';
            }
            else if (typeof this.settings.security.hsts === 'number') {
                this.settings.security._hsts = 'max-age=' + this.settings.security.hsts;
            }
            else {
                this.settings.security._hsts = 'max-age=' + (this.settings.security.hsts.maxAge || 15768000);
                if (this.settings.security.hsts.includeSubdomains) {
                    this.settings.security._hsts += '; includeSubdomains';
                }
            }
        }

        if (this.settings.security.xframe) {
            if (this.settings.security.xframe === true) {
                this.settings.security._xframe = 'DENY';
            }
            else if (typeof this.settings.security.xframe === 'string') {
                this.settings.security._xframe = this.settings.security.xframe.toUpperCase();
            }
            else if (this.settings.security.xframe.rule === 'allow-from') {
                if (!this.settings.security.xframe.source) {
                    this.settings.security._xframe = 'SAMEORIGIN';
                }
                else {
                    this.settings.security._xframe = 'ALLOW-FROM ' + this.settings.security.xframe.source;
                }
            }
            else {
                this.settings.security._xframe = this.settings.security.xframe.rule.toUpperCase();
            }
        }
    }

    // Cache-control status map

    this.settings._cacheControlStatus = Hoek.mapToObject(this.settings.cacheControlStatus);
};



internals.Realm.prototype.ext = function (event, func, options) {

    return this._ext.add(event, func, options, { views: this._views });
};


internals.Realm.prototype._ext = function () {

    return this._ext.add.apply(this._ext, arguments);
};


internals.Realm.prototype.state = function (name, options) {

    Schema.assert('state', options, name);
    this._stateDefinitions.add(name, options);
};


internals.Realm.prototype.views = function (options) {

    Hoek.assert(!this._views, 'Cannot set server views manager more than once');
    this._views = new Vision.Manager(options);
};


internals.Realm.prototype.render = function (template, context /*, options, callback */) {

    var options = arguments.length === 4 ? arguments[2] : {};
    var callback = arguments.length === 4 ? arguments[3] : arguments[2];

    Hoek.assert(this._views, 'Missing server views manager');
    return this._views.render(template, context, options, callback);
};
