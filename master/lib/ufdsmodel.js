/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Helpers for modeling data in UFDS (i.e. handling list/get/create/delete)
 * with routes something like this:
 *    list:      GET /pub/:login/$modelname
 *    create:    PUT /pub/:login/$modelname/:field
 *    get:       GET /pub/:login/$modelname/:field
 *    delete: DELETE /pub/:login/$modelname/:field
 *
 * In all the functions below `Model` is expected to be a model constructor
 * function with the following interface (see comments in the model
 * implementations for details):
 *
 *     function Foo(name, data) {...}
 *     Foo.raw   # the raw data that is put in the UFDS database
 *     Foo._modelName = "foo";
 *     Foo._objectclass = "amonfoo";
 *     Foo.validateName = function (name) {...}
 *     Foo.validate = function (raw) {...}
 *     Foo.dnFromRequest = function (req) {...}
 *     Foo.parentDnFromRequest = function (req) {...}
 *     Foo.nameFromRequest = function (req) {...}
 *     Foo.prototype.serialize = function serialize() {...}  # output for API responses
 */

var ldap = require('ldapjs');
var restify = require('restify');
var RestCodes = restify.RestCodes;



//---- generic list/create/get/delete model helpers

/**
 * Model.list
 *
 * ...
 * @param callback {Function} `function (err, items)` where err is a
 *    restify.RESTError instance on error.
 */
function modelList(app, Model, parentDn, log, callback) {
  var opts = {
    filter: '(objectclass=' + Model._objectclass + ')',
    scope: 'sub'
  };
  app.ufds.search(parentDn, opts, function(err, result) {
    var items = [];
    result.on('searchEntry', function(entry) {
      try {
        items.push((new Model(app, entry.object)).serialize());
      } catch(err2) {
        if (err2 instanceof restify.RESTError) {
          log.warn("Ignoring invalid %s (dn='%s'): %s", Model._modelName,
            entry.object.dn, err2)
        } else {
          log.error("Unknown error with %s entry: %s %o\n%s", Model._modelName,
            err2, entry.object, err2.stack)
        }
      }
    });
    result.on('error', function(err) {
      return callback(new restify.InternalError(
        sprintf("Error searching UFDS: %s (opts: %s)",
          err, JSON.stringify(opts))));
    });
    result.on('end', function(result) {
      if (result.status !== 0) {
        return callback(new restify.InternalError(
          sprintf("Non-zero status from UFDS search: %s (opts: %s)",
            result, JSON.stringify(opts))));
      }
      log.trace('%s items: %o', Model._modelName, items);
      return callback(null, items);
    });
  });
}


function modelCreate(app, Model, dn, name, data, log, callback) {
  var item;
  try {
    item = new Model(app, name, data);
  } catch (e) {
    return callback(e);
  }
  
  app.ufds.add(dn, item.raw, function(err) {
    if (err) {
      if (err instanceof ldap.EntryAlreadyExistsError) {
        return callback(new restify.InternalError(
          "XXX DN already exists. Can't nicely update "
          + "(with LDAP modify/replace) until "
          + "<https://github.com/mcavage/node-ldapjs/issues/31> is fixed."));
        //XXX Also not sure if there is another bug in node-ldapjs if
        //    "objectclass" is specified in here. Guessing it is same bug.
        //var change = new ldap.Change({
        //  operation: 'replace',
        //  modification: item.raw
        //});
        //client.modify(dn, change, function(err) {
        //  if (err) console.warn("client.modify err: %s", err)
        //  client.unbind(function(err) {});
        //});
      } else {
        log.error("Error saving (dn=%s): %s", err);
        return callback(new restify.InternalError());
      }
    } else {
      if (log.trace()) {
        log.trace('<%s> create: item=%o', Model._modelName, item.serialize());
      }
      return callback(null, item);
    }
  });
}


/**
 * Model.get
 *
 * ...
 * @param callback {Function} `function (err, item)` where err is a
 *    restify.RESTError instance on error.
 */
function modelGet(app, Model, name, parentDn, log, callback) {
  try {
    Model.validateName(name);
  } catch (err) {
    callback(err);
  }
  
  var opts = {
    //TODO: is this better? '(&(amonfooname=$name)(objectclass=amonfoo))'
    filter: '(' + Model._objectclass + 'name=' + name + ')',
    scope: 'sub'
  };
  app.ufds.search(parentDn, opts, function(err, result) {
    var items = [];
    result.on('searchEntry', function(entry) {
      try {
        items.push((new Model(app, entry.object)).serialize());
      } catch(err2) {
        if (err2 instanceof restify.RESTError) {
          log.warn("Ignoring invalid %s (dn='%s'): %s", Model._modelName,
            entry.object.dn, err2)
        } else {
          log.error("Unknown error with %s entry: %s %o\n%s", Model._modelName,
            err2, entry.object, err2.stack)
        }
      }
    });

    result.on('error', function(err) {
      return callback(new restify.InternalError(
        sprintf("Error searching UFDS: %s (opts: %s)",
          err, JSON.stringify(opts))));
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        return callback(new restify.InternalError(
          sprintf("Non-zero status from UFDS search: %s (opts: %s)",
            result, JSON.stringify(opts))));
      }
      log.trace('%s items: %o', Model._modelName, items);
      switch (items.length) {
      case 0:
        return callback(new restify.ResourceNotFoundError());
        break;
      case 1:
        return callback(null, items[0]);
        break;
      default:
        return callback(new restify.InternalError(
          sprintf("unexpected number of %s (%d): %s",
            Model._modelName, items.length, JSON.stringify(items))));
      }
    });
  });
}


function modelDelete(app, Model, dn, log, callback) {
  //TODO: could validate the 'dn'
  app.ufds.del(dn, function(err) {
    if (err) {
      if (err instanceof ldap.NoSuchObjectError) {
        return callback(new restify.ResourceNotFoundError());
      } else {
        log.error("Error deleting '%s' from UFDS: %s", dn, err);
        return callback(new restify.InternalError());
      }
    } else {
      return callback();
    }
  });
}



//---- request/response wrappers around the above helpers

function requestList(req, res, next, Model) {
  req._log.debug('<%s> list entered: params=%o, uriParams=%o',
    Model.name, req.params, req.uriParams);
  var parentDn = Model.parentDnFromRequest(req)
  modelList(req._app, Model, parentDn, req._log, function (err, items) {
    if (err) {
      res.sendError(err);
    } else {
      res.send(200, items);
    }
    return next();
  });
}


function requestCreate(req, res, next, Model) {
  req._log.debug('<%s> create entered: params=%o, uriParams=%o',
    Model._modelName, req.params, req.uriParams);
  var dn = Model.dnFromRequest(req);
  var name = Model.nameFromRequest(req);
  modelCreate(req._app, Model, dn, name, req.params, req._log, function(err, item) {
    if (err) {
      res.sendError(err);
    } else {
      res.send(200, item.serialize());
    }
    return next();
  });
}


function requestGet(req, res, next, Model) {
  req._log.debug('<%s> get entered: params=%o, uriParams=%o',
    Model.name, req.params, req.uriParams);
  var name = Model.nameFromRequest(req);
  var parentDn = Model.parentDnFromRequest(req)
  modelGet(req._app, Model, name, parentDn, req._log, function (err, item) {
    if (err) {
      res.sendError(err);
    } else {
      res.send(200, item);
    }
    return next();
  });
}


function requestDelete(req, res, next, Model) {
  req._log.debug('<%s> delete entered: params=%o, uriParams=%o',
    req.params, req.uriParams);
  var dn = Model.dnFromRequest(req);
  modelDelete(req._app, Model, dn, req._log, function(err) {
    if (err) {
      res.sendError(err);
    } else {
      res.send(204);
    }
    return next();
  });
}



//---- exports

module.exports = {
  modelList: modelList,
  modelCreate: modelCreate,
  modelGet: modelGet,
  modelDelete: modelDelete,
  requestList: requestList,
  requestCreate: requestCreate,
  requestGet: requestGet,
  requestDelete: requestDelete
};