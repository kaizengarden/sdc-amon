/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * The Amon Master app. It defines the master API endpoints.
 */

var p = console.log;
var http = require('http');
var assert = require('assert-plus');
var debug = console.log;
var format = require('util').format;

var restify = require('restify');
var sdcClients = require('sdc-clients'),
    CNAPI = sdcClients.CNAPI,
    VMAPI = sdcClients.VMAPI;
var UFDS = require('ufds');
var Cache = require('expiring-lru-cache');
var LRU = require('lru-cache');
var redis = require('redis');
var async = require('async');
var bunyan = require('bunyan');
var once = require('once');
var backoff = require('backoff');

var amonCommon = require('amon-common'),
    Constants = amonCommon.Constants,
    objCopy = amonCommon.utils.objCopy;
var Contact = require('./contact');
var alarms = require('./alarms'),
    createAlarm = alarms.createAlarm,
    Alarm = alarms.Alarm;
var audit = require('./audit');
var maintenances = require('./maintenances');
var probes = require('./probes'),
    Probe = probes.Probe;
var probegroups = require('./probegroups'),
    ProbeGroup = probegroups.ProbeGroup;
var agentprobes = require('./agentprobes');
var events = require('./events');
var errors = require('./errors');



//---- globals

/* JSSTYLED */
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Ensure login doesn't have LDAP search meta chars.
// Note: this regex should conform to `LOGIN_RE` in
// <https://mo.joyent.com/ufds/blob/master/schema/sdcperson.js>.
var VALID_LOGIN_CHARS = /^[a-zA-Z][a-zA-Z0-9_\.@]+$/;



//---- internal support stuff

/**
 * "GET /ping"
 */
function ping(req, res, next) {
    var log = req.log;
    if (req.query.error !== undefined) {
        var restCode = req.query.error || 'InternalError';
        if (restCode.slice(-5) !== 'Error') {
            restCode += 'Error';
        }
        var err = new restify[restCode](req.params.message || 'pong');
        next(err);
    } else {
        var data = {
            ping: 'pong',
            pid: process.pid  // used by test suite
        };
        req._app.getRedisClient(function (cerr, client) {
            if (cerr) {
                log.error(cerr, 'error getting redis client');
                return next(cerr);
            }
            client.info(function (infoErr, info) {
                if (infoErr) {
                    data.redisErr = infoErr;
                } else {
                    data.redis = info.match(/^redis_version:(.*?)$/m)[1];
                }
                res.send(data);
                next();
            });
        });
    }
}

function apiGetUser(req, res, next) {
    var user = objCopy(req._user);
    delete user.controls;
    delete user.objectclass;
    res.send(user);
    return next();
}

/**
 * Handle redis connection/reconnection.
 *
 * Problem: By default (node_redis 0.7.1) when the redis connection goes down
 * (e.g. the redis-server stops) the node_redis client will start a
 * backoff-retry loop to reconnect. The retry interval grows unbounded
 * (unless max_attempts or connection_timeout are given) resulting
 * eventually in *looooong* or possibly hung
 * (https://github.com/mranney/node_redis/pull/132) Amon Master API
 * requests (timeout) when using redis. We don't want that.
 *
 * Solution: Lacking a mechanism to notice when RedisClient.connection_gone()
 * has given up (without polling it, lame), the only solution is to disable
 * node_redis reconnection logic via `max_attempts = 1` and recycle our
 * `_redisClient` on the "end" event.
 *
 * Limitations: While redis is unavailable, requesters receive errors.
 */
function RedisReconnector(host, port, log) {
    this.host = host;
    this.port = port;
    this.log = log.child({redis:true}, true);
    this._client = null;
    this._connect();
}

RedisReconnector.prototype._connect = function () {
    if (this._client || this._quit) {
        return;
    }

    var self = this;

    function postConnect(client) {
        if (self._quit) {
            // Catch cases where quit was requested during connection
            client.quit();
            return;
        }
        client.select(1); // Amon uses DB 1 in redis.
        client.removeAllListeners('error');
        client.on('error', function (err) {
            self.log.warn(err, 'redis client error during connect');
            client.end();
        });
        client.on('drain', function () {
            self.log.debug('redis client drain');
        });
        client.on('idle', function () {
            self.log.debug('redis client idle');
        });
        client.on('end', function () {
            self.log.debug('redis client end');
            self._client = null;
            self._connect();
        });
        self._connecting = null;
        self._client = client;
        self.log.info('redis client ready');
    }

    var retry = backoff.exponential({
        initialDelay: 100,
        maxDelay: 10000
    });
    retry.on('ready', function (num) {
        if (self._quit) {
            return;
        }
        self.log.debug('redis connect attempt %d', num);
        var client = new redis.createClient(
            self.port,
            self.host,
            {
                max_attempts: 1,
                enable_offline_queue: false
            });
        client.on('ready', function () {
            postConnect(client);
        });
        client.on('error', function (err) {
            self.log.warn(err, 'redis client error during connect');
            client.end();
            retry.backoff(err);
        });
    });
    this._connecting = retry;
    retry.backoff();
};

RedisReconnector.prototype.getClient = function (cb) {
    if (this._quit) {
        return cb(new Error('redis has quit'));
    }
    if (this._client) {
        return cb(null, this._client);
    }
    return cb(new Error('redis not available'));
};

RedisReconnector.prototype.quit = function () {
    this._quit = true;
    if (this._client) {
        this._client.quit();
    } else if (this._connecting) {
        this._connecting.reset();
        this._connecting = null;
    }
};


//---- exports

/**
 * Create the app.
 *
 * @param config {Object} The amon master config object.
 * @param log {Bunyan Logger instance}
 * @param callback {Function} `function (err, app) {...}`.
 */
function createApp(config, log, callback) {
    if (!config) throw new TypeError('config (Object) required');
    if (!config.cnapi) throw new TypeError('config.cnapi (Object) required');
    if (!config.vmapi) throw new TypeError('config.vmapi (Object) required');
    if (!config.redis) throw new TypeError('config.redis (Object) required');
    if (!config.ufds) throw new TypeError('config.ufds (Object) required');
    if (!log) throw new TypeError('log (Bunyan Logger) required');
    if (!callback) throw new TypeError('callback (Function) required');

    var cnapiClient = new CNAPI({
        url: config.cnapi.url
    });
    var vmapiClient = new VMAPI({
        url: config.vmapi.url
    });

    try {
        var app = new App(config, cnapiClient, vmapiClient, log);
        return callback(null, app);
    } catch (e) {
        return callback(e);
    }
}


/**
 * Constructor for the amon 'application'.
 *
 * @param config {Object} Config object.
 * @param cnapiClient {sdc-clients.CNAPI} CNAPI client.
 * @param vmapiClient {sdc-clients.VMAPI} VMAPI client.
 * @param log {Bunyan Logger instance}
 */
function App(config, cnapiClient, vmapiClient, log) {
    var self = this;
    if (!config) throw TypeError('config is required');
    if (!config.port) throw TypeError('config.port is required');
    if (!config.ufds) throw new TypeError('config.ufds (Object) required');
    if (!cnapiClient) throw TypeError('cnapiClient is required');
    if (!vmapiClient) throw TypeError('vmapiClient is required');

    this.log = log;
    this.config = config;
    this.cnapiClient = cnapiClient;
    this.vmapiClient = vmapiClient;
    this._ufdsCaching = (config.ufds.caching === undefined
        ? true : config.ufds.caching);
    this._getUfdsClient(config.ufds);
    this._redisReconnector = new RedisReconnector(
        this.config.redis.host || '127.0.0.1',
        this.config.redis.port || 6379,   // redis default port
        this.log.child({redis: true}, true));

    this.notificationPluginFromType = {};
    if (config.notificationPlugins) {
        for (var i = 0; i < config.notificationPlugins.length; i++) {
            var plugin = config.notificationPlugins[i];
            var repr = JSON.stringify(plugin);
            assert.string(plugin.type, '"type" field in ' + repr);
            assert.string(plugin.path, '"path" field in ' + repr);
            assert.object(plugin.config, '"config" field in ' + repr);
            var type = plugin.type;
            log.info('Loading "%s" notification plugin.', type);
            var NotificationType = require(plugin.path);
            self.notificationPluginFromType[type] = new NotificationType(
                log.child({notification_type: type}, true),
                plugin.config,
                config.datacenterName);
        }
    }

    // Cache of login/uuid (aka username) -> full user record.
    this.userCache = new Cache({
        size: config.userCache.size,
        expiry: config.userCache.expiry * 1000,
        log: log,
        name: 'user'
    });
    this.isOperatorCache = new Cache({size: 100, expiry: 300000,
        log: log, name: 'isOperator'});
    this.cnapiServersCache = new Cache({size: 100, expiry: 300000,
        log: log, name: 'cnapiServers'});

    // Caches for server response caching. This is centralized on the app
    // because it allows the interdependant cache-invalidation to be
    // centralized.
    this._cacheFromScope = {
        ProbeGroupGet: new Cache({
            size:100,
            expiry:300000,
            log:log,
            name:'ProbeGroupGet'
        }),
        ProbeGroupList: new Cache({
            size:100,
            expiry:300000,
            log:log,
            name:'ProbeGroupList'
        }),
        ProbeGet: new Cache({
            size:100,
            expiry:300000,
            log:log,
            name:'ProbeGet'
        }),
        ProbeList: new Cache({
            size:100,
            expiry:300000,
            log:log,
            name:'ProbeList'
        }),
        /*
         * Cache size: 1 million, the design max num VMs in an SDC.
         * - the data stored is small and
         * - we expect `headAgentProbes` calls for *all* machines (the key)
         *   regularly so an LRU-cache is pointless.
         * See MON-252 for discussion.
         */
        headAgentProbes: new LRU(1000000)
    };

    var serverName = 'Amon Master/' + Constants.ApiVersion;
    var server = this.server = restify.createServer({
        name: serverName,
        log: log
    });
    server.use(restify.requestLogger());
    server.use(restify.queryParser({mapParams: false}));
    server.use(restify.bodyParser({mapParams: false}));
    server.on('after', function (req, res, route, err) {
        // Skip logging some high frequency or unimportant endpoints to key
        // log noise down.
        var method = req.method;
        var pth = req.path();
        if (method === 'GET' || method === 'HEAD') {
            if (pth === '/ping') {
                return;
            }
        }
        // Successful GET res bodies are uninteresting and *big*.
        var body = !(method === 'GET' &&
            Math.floor(res.statusCode / 100) === 2);

        audit.auditLogger({
            log: req.log.child({route: route && route.name}, true),
            body: body
        })(req, res, route, err);
    });
    server.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    function setup(req, res, next) {
        req._app = self;

        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', serverName);
            res.header('Request-Id', req.getId());
            var t = now - req.time();
            res.header('Response-Time', t);
        });

        // Handle ':user' in route: add `req._user` or respond with
        // appropriate error.
        var userId = req.params.user;
        if (userId) {
            self.userFromId(userId, function (err, user) {
                if (err) {
                    //TODO: does this work with an LDAPError?
                    next(err);
                } else if (! user) {
                    next(new restify.ResourceNotFoundError(
                        format('no such user: "%s"', userId)));
                } else {
                    req._user = user;
                    next();
                }
            });
        } else {
            next();
        }
    }

    server.use(setup);

    // Debugging/dev/testing endpoints.
    server.get({path: '/ping', name: 'Ping'}, ping);
    server.get({path: '/pub/:user', name: 'GetUser'}, apiGetUser);
    // TODO Kang-ify (https://github.com/davepacheco/kang)
    server.get({path: '/state', name: 'GetState'}, function (req, res, next) {
        res.send(self.getStateSnapshot());
        next();
    });
    server.post({path: '/state', name: 'UpdateState'},
        function apiDropCaches(req, res, next) {
            if (req.query.action !== 'dropcaches')
                return next();
            self.userCache.reset();
            self.isOperatorCache.reset();
            self.cnapiServersCache.reset();
            Object.keys(self._cacheFromScope).forEach(function (scope) {
                self._cacheFromScope[scope].reset();
            });
            res.send(202);
            next(false);
        },
        function invalidAction(req, res, next) {
            if (req.query.action)
                return next(new restify.InvalidArgumentError(
                    '"%s" is not a valid action', req.query.action));
            return next(new restify.MissingParameterError(
                '"action" is required'));
        });

    probegroups.mountApi(server);
    probes.mountApi(server);
    alarms.mountApi(server);
    maintenances.mountApi(server);
    agentprobes.mountApi(server);
    events.mountApi(server);
}


/**
 * Poll UFDS to get a bound client. This sets `this.ufdsClient` as a
 * side-effect. It returns right away.
 */
App.prototype._getUfdsClient = function _getUfdsClient(ufdsConfig) {
    var self = this;

    var config = objCopy(ufdsConfig);
    var log = config.log = self.log.child({'ufdsClient': true}, true);
    config.cache = false;  // for now at least, no caching in the client
    config.failFast = true;
    config.connectTimeout = 5000;
    var ufdsClient = self.ufdsClient = new UFDS(config);

    ufdsClient.once('connect', function () {
        ufdsClient.on('error', function (err) {
            log.warn(err, 'UFDS: unexpected error occurred');
        });

        ufdsClient.on('close', function () {
            log.warn('UFDS: disconnected');
        });

        ufdsClient.on('connect', function () {
            log.info('UFDS: reconnected');
        });

        log.info('UFDS: connected');
    });

    ufdsClient.once('destroy', function (err) {
        if (err) {
            log.fatal(err, 'UFDS: client destroyed');
        }
    });
};



/**
 * Get a redis client.
 *
 * @returns {redis.RedisClient}
 *
 */
App.prototype.getRedisClient = function getRedisClient(cb) {
    this._redisReconnector.getClient(cb);
};


/**
 * Some redis data checkers to be defensive with possible bogus responses
 * from node_redis. See MON-239 for details.
 */
App.prototype.assertRedisObject = function assertRedisObject(d) {
    try {
        assert.object(d, format('redis reply is not an object: %j', d));
    } catch (err) {
        return new errors.InternalError(err, 'unexpected db (redis) value');
    }
    return null;
};
App.prototype.assertRedisArrayOfNumber = function assertRedisArrayOfNumber(d) {
    try {
        assert.arrayOfString(d);
        for (var i = 0; i < d.length; i++) {
            assert.ok(!isNaN(Number(d[i])),
                format('item %d (%j) is NaN, full array is %j', i, d[i], d));
        }
    } catch (err) {
        return new errors.InternalError(err, 'unexpected db (redis) value');
    }
    return null;
};
App.prototype.assertRedisArrayOfString = function assertRedisArrayOfString(d) {
    try {
        assert.arrayOfString(d,
            format('redis data is not an array of strings: %j', d));
    } catch (err) {
        return new errors.InternalError(err, 'unexpected db (redis) value');
    }
    return null;
};



/**
 * Quit the redis client (if we have one) gracefully.
 */
App.prototype.quitRedisClient = function () {
    this._redisReconnector.quit();
};


/**
 * Gets Application up and listening.
 *
 * @param callback {Function} `function (err)`.
 */
App.prototype.listen = function (callback) {
    this.server.listen(this.config.port, '0.0.0.0', callback);
};


App.prototype.cacheGet = function (scope, key) {
    if (! this._ufdsCaching) {
        return null;
    }
    var hit = this._cacheFromScope[scope].get(key);
    //this.log.trace('App.cacheGet scope="%s" key="%s": %s', scope, key,
    //  (hit ? 'hit' : "miss"));
    return hit;
};


App.prototype.cacheSet = function (scope, key, value) {
    if (! this._ufdsCaching)
        return;
    //this.log.trace('App.cacheSet scope="%s" key="%s"', scope, key);
    this._cacheFromScope[scope].set(key, value);
};


App.prototype.cacheDel = function (scope, key) {
    if (! this._ufdsCaching)
        return;
    this._cacheFromScope[scope].del(key);
};

/**
 * Invalidate caches as appropriate for the given DB object create/update.
 */
App.prototype.cacheInvalidateWrite = function (modelName, item) {
    if (! this._ufdsCaching)
        return;
    var log = this.log;

    var dn = item.dn;
    assert.ok(dn);
    log.trace('App.cacheInvalidateWrite modelName="%s" dn="%s" agent=%s',
        modelName, dn, (modelName === 'Probe' ? item.agent : '(N/A)'));

    // Reset the '${modelName}List' cache.
    // Note: This could be improved by only invalidating the item for this
    // specific user. We are being lazy for starters here.
    var scope = modelName + 'List';
    this._cacheFromScope[scope].reset();

    // Delete the '${modelName}Get' cache item with this dn (possible because
    // we cache error responses).
    this._cacheFromScope[modelName + 'Get'].del(dn);

    // Furthermore, if this is a probe, then need to invalidate the
    // `headAgentProbes` for this probe's agent.
    if (modelName === 'Probe') {
        this._cacheFromScope.headAgentProbes.del(item.agent);
    }
};


/**
 * Invalidate caches as appropriate for the given DB object delete.
 */
App.prototype.cacheInvalidateDelete = function (modelName, item) {
    if (! this._ufdsCaching)
        return;
    var log = this.log;

    var dn = item.dn;
    assert.ok(dn);
    log.trace('App.cacheInvalidateDelete modelName="%s" dn="%s" agent=%s',
        modelName, dn, (modelName === 'Probe' ? item.agent : '(N/A)'));

    // Reset the '${modelName}List' cache.
    // Note: This could be improved by only invalidating the item for this
    // specific user. We are being lazy for starters here.
    var scope = modelName + 'List';
    this._cacheFromScope[scope].reset();

    // Delete the '${modelName}Get' cache item with this dn.
    this._cacheFromScope[modelName + 'Get'].del(dn);

    // Furthermore, if this is a probe, then need to invalidate the
    // `headAgentProbes` for this probe's agent.
    if (modelName === 'Probe') {
        this._cacheFromScope.headAgentProbes.del(item.agent);
    }
};


/**
 * Gather JSON repr of live state.
 */
App.prototype.getStateSnapshot = function () {
    var self = this;
    var snapshot = {
        cache: {
            user: this.userCache.dump(),
            isOperator: this.isOperatorCache.dump(),
            cnapiServers: this.cnapiServersCache.dump()
        },
        log: { level: this.log.level() }
    };

    Object.keys(this._cacheFromScope).forEach(function (scope) {
        snapshot.cache[scope] = self._cacheFromScope[scope].dump();
    });

    return snapshot;
};


/**
 * UFDS get
 *
 * @param dn {String}
 * @param callback {Function} `function (err, items)`
 */
App.prototype.ufdsGet = function ufdsGet(dn, callback) {
    var self = this;
    var log = this.log;

    log.trace({dn: dn}, 'ufdsGet');
    self.ufdsClient.search(dn, {scope: 'base'}, function (err, items) {
        if (err) {
            if (err.restCode === 'ResourceNotFound') {
                callback(new errors.ResourceNotFoundError('not found'));
            } else {
                // 503: presuming this is a "can't connect to UFDS" error.
                callback(new errors.ServiceUnavailableError(err,
                        'service unavailable'));
            }
            return;
        }

        if (items.length !== 1) {
            log.error({items: items, dn: dn},
                'multiple hits in UFDS for one dn');
            return callback(new errors.InternalError(
                'conflicting items in database'));
        }
        callback(null, items[0]);
    });
};


/**
 * UFDS search
 *
 * @param base {String}
 * @param opts {String} Search options for `ufdsClient.search()`
 * @param callback {Function} `function (err, items)`
 */
App.prototype.ufdsSearch = function ufdsSearch(base, opts, callback) {
    var self = this;
    var log = this.log;

    log.trace({filter: opts.filter}, 'ldap search');
    self.ufdsClient.search(base, opts, function (sErr, items) {
        if (sErr) {
            // 503: presuming this is a "can't connect to UFDS" error.
            return callback(new errors.ServiceUnavailableError(sErr,
                'service unavailable'));
        }
        callback(null, items);
    });
};

/**
 * Add an item to UFDS
 *
 * @param dn {String}
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
App.prototype.ufdsAdd = function ufdsAdd(dn, data, callback) {
    var self = this;

    self.ufdsClient.add(dn, data, function (addErr) {
        if (addErr) {
            if (addErr.name === 'EntryAlreadyExistsError') {
                return callback(new errors.InternalError(addErr,
                    'DN "'+ dn + '" already exists.'));
            }
            return callback(new errors.InternalError(addErr, 'error saving'));
        }
        callback();
    });
};

/**
 * Modify an item on UFDS
 *
 * @param dn {String}
 * @param data {Object}
 * @param callback {Function} `function (err)`
 */
App.prototype.ufdsModify = function ufdsModify(dn, data, callback) {
    var self = this;

    var change = {
        operation: 'replace',
        modification: data
    };

    self.ufdsClient.modify(dn, change, function (err) {
        if (err) {
            return callback(new errors.InternalError(err, 'error modifying'));
        }
        callback();
    });
};

/**
 * Delete an item from UFDS
 *
 * @param dn {String}
 * @param callback {Function} `function (err)`
 */
App.prototype.ufdsDelete = function ufdsDelete(dn, callback) {
    var self = this;


    self.ufdsClient.del(dn, function (delErr) {
        if (delErr) {
            if (delErr.restCode === 'ResourceNotFound') {
                callback(new errors.ResourceNotFoundError('not found'));
            } else {
                callback(new errors.InternalError(delErr,
                    'could not delete item'));
            }
        } else {
            callback();
        }
    });
};


/**
 * Facilitate getting user info (and caching it) from a login/username.
 *
 * @param userId {String} UUID or login (aka username) of the user to get.
 * @param callback {Function} `function (err, user)`. 'err' is a restify
 *    RestError instance if there is a problem. 'user' is null if no
 *    error, but no such user was found.
 */
App.prototype.userFromId = function (userId, callback) {
    var log = this.log;

    // Validate args.
    if (!userId) {
        log.error('userFromId: "userId" is required');
        callback(new restify.InternalError());
        return;
    }
    if (!callback || typeof (callback) !== 'function') {
        log.error('userFromId: "callback" must be a function: %s',
            typeof (callback));
        callback(new restify.InternalError());
        return;
    }

    // Check cache. 'cached' is `{err: <error>, user: <user>}`.
    var cached = this.userCache.get(userId);
    if (cached) {
        if (cached.err) {
            callback(cached.err);
            return;
        }
        callback(null, cached.user);
        return;
    }

    // UUID or login?
    var uuid = null, login = null;
    if (UUID_REGEX.test(userId)) {
        uuid = userId;
    } else if (VALID_LOGIN_CHARS.test(login)) {
        login = userId;
    } else {
        callback(new restify.InvalidArgumentError(
            format('user id is not a valid UUID or login: "%s"', userId)));
        return;
    }

    var self = this;
    function cacheAndCallback(err, user) {
        var obj = {err: err, user: user};
        if (user) {
            // On success, cache for both the UUID and login.
            self.userCache.set(user.uuid, obj);
            self.userCache.set(user.login, obj);
        } else {
            self.userCache.set(userId, obj);
        }
        callback(err, user);
    }

    // Look up the user, cache the result and return.
    var searchOpts = {
        filter: (uuid
            ? '(&(uuid=' + uuid + ')(objectclass=sdcperson))'
            : '(&(login=' + login + ')(objectclass=sdcperson))'),
        scope: 'one'
    };
    this.ufdsSearch('ou=users, o=smartdc', searchOpts, function (sErr, users) {
        if (sErr) {
            if (sErr.statusCode === 503) {
                return callback(sErr);  // don't cache 503
            } else {
                return cacheAndCallback(sErr);
            }
        }
        switch (users.length) {
        case 0:
            cacheAndCallback(null, null);
            break;
        case 1:
            cacheAndCallback(null, users[0]);
            break;
        default:
            log.error({searchOpts: searchOpts, users: users},
                'unexpected number of users (%d) matching user id "%s"',
                users.length, userId);
            cacheAndCallback(new restify.InternalError(
                format('error determining user for "%s"', userId)));
            break;
        }
    });
};


/**
 * Is the given user UUID an operator.
 *
 * @param userUuid {String}
 * @param callback {Function} `function (err, isOperator)`
 * @throws {TypeError} if invalid args are given.
 */
App.prototype.isOperator = function (userUuid, callback) {
    var log = this.log;

    // Validate args.
    if (typeof (userUuid) !== 'string')
        throw new TypeError('userUuid (String) required');
    if (!UUID_REGEX.test(userUuid))
        throw new TypeError(format('userUuid is not a valid UUID: %s',
            userUuid));
    if (typeof (callback) !== 'function')
        throw new TypeError('callback (Function) required');

    // Check cache. 'cached' is `{isOperator: <isOperator>}`.
    var cached = this.isOperatorCache.get(userUuid);
    if (cached) {
        return callback(null, cached.isOperator);
    }

    // Look up the user, cache the result and return.
    var self = this;
    var base = 'cn=operators, ou=groups, o=smartdc';
    var searchOpts = {
        filter: format('(uniquemember=uuid=%s, ou=users, o=smartdc)',
            userUuid),
        scope: 'base',
        attributes: ['dn']
    };
    log.trace('search if user is operator: search opts: %s',
        JSON.stringify(searchOpts));
    this.ufdsSearch(base, searchOpts, function (searchErr, entries) {
        if (searchErr) {
            return callback(searchErr);
        }
        var isOperator = (entries.length > 0);
        self.isOperatorCache.set(userUuid, {isOperator: isOperator});
        return callback(null, isOperator);
    });
    return true;
};

/**
 * Does the given server UUID exist (in CNAPI).
 *
 * @param serverUuid {String}
 * @param callback {Function} `function (err, serverExists)`
 * @throws {TypeError} if invalid args are given.
 */
App.prototype.serverExists = function (serverUuid, callback) {
    var log = this.log;

    // Validate args.
    if (typeof (serverUuid) !== 'string')
        throw new TypeError('serverUuid (String) required');
    if (!UUID_REGEX.test(serverUuid))
        throw new TypeError(format('serverUuid is not a valid UUID: %s',
            serverUuid));
    if (typeof (callback) !== 'function')
        throw new TypeError('callback (Function) required');

    // Check cache. 'cached' is `{server-uuid-1: true, ...}`.
    var cached = this.cnapiServersCache.get('servers');
    if (cached) {
        return callback(null, (cached[serverUuid] !== undefined));
    }

    // Look up the user, cache the result and return.
    var self = this;
    return this.cnapiClient.listServers(function (err, servers) {
        if (err) {
            log.fatal('Failed to call cnapiClient.listServers (%s)', err);
            return callback(err);
        }
        var serverMap = {};
        for (var i = 0; i < servers.length; i++) {
            serverMap[servers[i].uuid] = true;
        }
        self.cnapiServersCache.set('servers', serverMap);
        return callback(null, (serverMap[serverUuid] !== undefined));
    });
};


/**
 * Handle the expiry and/or deletion of a maintenance window. The maintenance
 * window has been deleted from the db when this is called.
 *
 * @param maintenance {maintenances.Maintenance}
 * @param callback {Function} `function (err)`
 */
App.prototype.handleMaintenanceEnd = function (maintenance, callback) {
    if (!maintenance) throw new TypeError('"maintenance" is required');
    if (!callback) throw new TypeError('"callback" is required');
    var log = this.log;

    log.info({maintenance: maintenance.user + ':' + maintenance.id},
        'TODO: handle maintenance end');
    //XXX for each alarm for this user: if there are maint faults and aren't
    // covered by any current maintenance windows, then moved them to
    // "faults"... and notify as appropriate.

    callback();
};


/**
 * Handle an incoming event.
 *
 * @param ufds {ldapjs client} UFDS client.
 * @param event {Object} The event object.
 * @param callback {Function} `function (err) {}` called on completion.
 *    'err' is undefined (success) or a restify Error instance (failure).
 *
 * XXX TODO: inability to send a notification should result in an alarm for
 *   the owner of the probe/probegroup.
 */
App.prototype.processEvent = function (event, callback) {
    var self = this;
    var log = this.log;
    log.debug({event: event}, 'App.processEvent');

    if (event.type === 'probe') {
        /*jsl:pass*/
    } else if (event.type === 'fake') {
        /*jsl:pass*/
    } else {
        return callback(new restify.InternalError(
            format('unknown event type: "%s"', event.type)));
    }

    // Gather available and necessary info for alarm creation and notification.
    var info = {event: event};
    async.series([
            function getUser(next) {
                self.userFromId(event.user, function (uErr, user) {
                    if (uErr) {
                        return next(uErr);
                    } else if (! user) {
                        return next(new restify.InvalidArgumentError(
                            format('no such user: "%s"', event.user)));
                    }
                    info.user = user;
                    next();
                });
            },
            function getProbe(next) {
                if (!event.probeUuid) {
                    return next();
                }
                Probe.get(self, event.user, event.probeUuid,
                    function (pErr, probe) {
                        if (pErr)
                            return next(pErr);
                        info.userUuid = probe.user;
                        info.probe = probe;
                        next();
                    }
                );
            },
            function getProbeGroup(next) {
                if (!info.probe || !info.probe.group) {
                    return next();
                }
                var groupUuid = info.probe.group;
                ProbeGroup.get(self, event.user, groupUuid,
                    function (pgErr, group) {
                        // We don't fail if the group can't be found. Because
                        // we don't have UFDS transactions, it is possible
                        // (unlikely) to have stale probe group references.
                        // The alarm will then just be associated with the
                        // probe.
                        if (pgErr)
                            return next();
                        info.probeGroup = group;
                        next();
                    }
                );
            }
        ], function (err) {
            if (err) {
                return callback(err);
            }
            self.getOrCreateAlarm(info, function (getOrCreateErr, alarm) {
                if (getOrCreateErr) {
                    callback(getOrCreateErr);
                } else if (alarm) {
                    info.alarm = alarm;
                    alarm.handleEvent(self, info, function (evtErr) {
                        callback(evtErr);
                    });
                } else {
                    callback();
                }
            });
        }
    );
};



/**
 * Get a related alarm or create a new one for the given event, if
 * appropriate.
 *
 * @param options {Object}
 *    - `event` {Object} Required. The Amon event.
 *    - `probe` {Probe} The Probe object associated with this event, if any.
 *    - `probeGroup` {ProbeGroup} The probe group object associated with
 *      this event, if any.
 * @param callback {Function} `function (err, alarm)`. If there was an
 *    error, the `err` is an Error instance. Else if `alarm` is either
 *    a related existing alarm, a new alarm, or null (if no new alarm
 *    is appropriate for this event).
 */
App.prototype.getOrCreateAlarm = function (options, callback) {
    var self = this;
    var log = this.log;
    var event = options.event;
    var probe = options.probe;

    // An alarm is associated with a probe group (if it has a `group`
    // attribute) *or* a probe, or with neither if there is no probe involved.
    var associatedProbe = null;
    var associatedProbeGroup = null;
    if (probe) {
        if (probe.group) {
            associatedProbeGroup = probe.group;
        } else {
            associatedProbe = probe.uuid;
        }

        // When the event is associated with a probe and the probe's groupEvents
        // attribute is false, every new event must result in a new alarm
        if (probe.groupEvents === false) {
            log.debug('getOrCreateAlarm: probe.groupEvents is false');
            return createAlarm(self, event.user, associatedProbe,
                associatedProbeGroup, callback);
        }
    }

    // Get all open alarms for this user and probe/probe group.
    log.debug('getOrCreateAlarm: get candidate related alarms');
    Alarm.filter(
        self,
        {
            user: event.user,
            probe: associatedProbe,
            probeGroup: associatedProbeGroup,
            closed: false
        },
        function (err, candidateAlarms) {
            if (err) {
                return callback(err);
            }
            self.chooseRelatedAlarm(candidateAlarms, options,
                function (chooseErr, alarm) {
                    if (chooseErr) {
                        callback(chooseErr);
                    } else if (alarm) {
                        callback(null, alarm);
                    } else if (event.clear) {
                        // A clear event with no related open alarm
                        // should be dropped. Don't create an alarm for this.
                        log.info({event_uuid: event.uuid},
                            'not creating a new alarm for a clear event');
                        callback(null, null);
                    } else {
                        createAlarm(self, event.user, associatedProbe,
                            associatedProbeGroup, callback);
                    }
                }
            );
        }
    );
};


/**
 * Choose a related alarm of the given candidates for the given event.
 *
 * This essentially is Amon's alarm/notification de-duplication algorithm.
 *
 * @param candidateAlarms {Array}
 * @param options {Object}
 *    - `event` {Object} Required. The Amon event.
 * @param callback {Function} `function (err, alarm)`. If none of the
 *    given candidateAlarms is deemed to be "related", then `alarm` will
 *    be null.
 *
 * First pass at this: Choose the alarm with the most recent
 * `timeLastEvent`. If `event.time - alarm.timeLastEvent > 25 hours` then
 * return none, i.e. not related. Else, return that alarm. A 'clear' event
 * is excluded from this "25 hour" check. 25 hours is chosen because: in
 * our experience 1 hour has been too little for errors with an hourly
 * period (results in many alarms for the same thing); slightly longer than
 * a day allows a failure in a daily job (e.g. a daily cron) to group into
 * the same alarm.
 *
 * TODO:
 * Eventually make this "25 hour" an optional var on probe/probeGroup.
 * Eventually this algo can consider more vars.
 */
App.prototype.chooseRelatedAlarm = function (candidateAlarms,
        options, callback) {
    this.log.debug({event_uuid: options.event.uuid,
        num_candidate_alarms: candidateAlarms.length}, 'chooseRelatedAlarm');
    if (candidateAlarms.length === 0) {
        return callback(null, null);
    }
    var ONE_HOUR = 25 * 60 * 60 * 1000;  // twelve hour in milliseconds
    candidateAlarms.sort(
        // Sort the latest 'timeLastEvent' first (alarms with no 'timeLastEvent'
        // field sort to the end).
        function (x, y) { return y.timeLastEvent - x.timeLastEvent; });
    var a = candidateAlarms[0];
    this.log.debug({alarm: a}, 'best candidate related alarm');
    if (a.timeLastEvent &&
            (options.event.clear ||
             (options.event.time - a.timeLastEvent) < ONE_HOUR)) {
        this.log.debug({alarmId: a.id}, 'related alarm');
        callback(null, a);
    } else {
        this.log.debug('no related alarm');
        callback(null, null);
    }
};


/**
 * Determine the appropriate notification type (email, sms, etc.) from
 * the given contact medium.
 *
 * Because we are using the simple mechanism of
 * an LDAP field name/value pair on a user (objectClass=sdcPerson in UFDS)
 * for a contact, we need conventions on the field *name* to map to a
 * particular plugin for handling the notification. E.g. both 'email'
 * and 'secondaryEmail' will map to the "email" notification type.
 *
 * @throws {errors.InvalidParameterError} if the no appropriate notification
 *    plugin could be determined.
 */
App.prototype.notificationTypeFromMedium = function (medium) {
    var log = this.log;
    var self = this;
    var types = Object.keys(this.notificationPluginFromType);
    for (var i = 0; i < types.length; i++) {
        var type = types[i];
        var plugin = self.notificationPluginFromType[type];
        if (plugin.acceptsMedium(medium)) {
            return type;
        }
    }
    log.warn('Could not determine an appropriate notification plugin '
        + 'for "%s" medium.', medium);
    throw new errors.InvalidParameterError(
        format('Invalid or unsupported contact medium "%s".', medium),
        [ {field: 'medium', code: 'Invalid'} ]);
};


/**
 * Alert the given user about an Amon configuration issue.
 *
 * Currently this will just send an email notification. Eventually this will
 * create a separate alarm instance and notify the given user via the
 * usual alarm handling mechanisms.
 *
 * @param userId {String} UUID or login of user to notify.
 * @param msg {String} Message to send. TODO: spec this out.
 * @param callback {Function} `function (err)`.
 *    TODO: return alarm or alarm id.
 */
App.prototype.alarmConfig = function (userId, msg, callback) {
    var log = this.log;
    log.error('TODO: implement App.alarmConfig');
    callback();
};


/**
 * Send a notification for a probe event.
 *
 * @param options {Object} with:
 *    - @param alarm {alarms.Alarm}
 *    - @param user {Object} User, as from `App.userFromId()`, owning
 *        this probe.
 *    - @param event {Object} The probe event object.
 *    - @param contact {Contact} The contact to notify. A contact is relative
 *        to a user. See 'contact.js' for details. Note that when groups are
 *        in UFDS, this contact could be a person other than `user` here.
 *    - @param probeGroup {ProbeGroup} Probe group for which this
 *        notification is being sent, if any.
 *    - @param probe {Probe} Probe for which this notification is being
 *        sent, if any.
 * @param callback {Function} `function (err) {}`.
 */
App.prototype.notifyContact = function (options, callback) {
    var log = this.log;
    var plugin = this.notificationPluginFromType[
        options.contact.notificationType];
    if (!plugin) {
        var msg = format('notification plugin "%s" not found',
                                         options.contact.notificationType);
        log.error(msg);
        return callback(new Error(msg));
    }
    plugin.notify(options, callback);
};


/**
 * Close this app.
 *
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function (callback) {
    var self = this;
    this.server.on('close', function () {
        self.quitRedisClient();
        self.ufdsPool.drain(function () {
            self.ufdsPool.destroyAllNow();
            callback();
        });
    });
    this.server.close();
};



module.exports.createApp = createApp;
module.exports.App = App;
