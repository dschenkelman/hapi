// Load modules

var Hoek = require('hoek');
var LruCache = require('lru-cache');
var Statehood = require('statehood');
var Vision = require('vision');
var Auth = require('./auth');
var Defaults = require('./defaults');
var Ext = require('./ext');
var Router = require('./router');
var Schema = require('./schema');


// Declare internals

var internals = {};


exports = module.exports = internals.Realm = function (options) {

    this.settings = Hoek.applyToDefaultsWithShallow(Defaults.server, options || {}, ['app', 'plugins']);
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
    this._router = null;
    Router.create(this);        // Sets this._router

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

    this.settings.cors = Hoek.applyToDefaults(Defaults.cors, this.settings.cors);
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

    this.settings.security = Hoek.applyToDefaults(Defaults.security, this.settings.security);
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


internals.Realm.prototype.table = function (host) {

    return this._router.table(host);
};


internals.Realm.prototype.ext = function (event, func, options) {

    return this._ext.add(event, func, options, { views: this._views });
};


internals.Realm.prototype._ext = function () {

    return this._ext.add.apply(this._ext, arguments);
};


internals.Realm.prototype.route = function (configs) {

    this._route(configs);
};


internals.Realm.prototype._route = function (configs, env) {

    Router.add(this, configs, env);
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
