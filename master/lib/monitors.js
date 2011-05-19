/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Amon Master controller for '/public/:customer/monitors/...' endpoints.
 */

var assert = require('assert');
var restify = require('restify');
var Messages = require('amon-common').Messages;

var utils = require('./utils');
var Check = require('./model/check');
var Contact = require('./model/contact');
var Monitor = require('./model/monitor');



//--- globals

var log = restify.log;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;





//---- internal support routines

///**
// * Resolve `Contact` model instances for each of the given contact names.
// *
// * Calls `callback(err, contacts)` on complete. On success, `contacts` is
// * an array (in order) of `Contact`. On error `err` looks like:
// *
// *    {
// *      "code": ...,
// *      "message": ...
// *    }
// *
// * Where "code" is one of "UnknownContact" or "InternalError".
// */
//function _getContacts(contactNames, callback) {
//  var contacts = [];
//  for (var i=0; i < contactNames.length; i++) {
//    var name = contactNames[i];
//    contact = "<Contact "+name+">"; // HACK
//    //var contact = _hackdb.contactFromName[name];
//    //if (!contact) {
//    //  callback({
//    //    code: "UnknownContact",
//    //    message: Messages.message("contact '%s' is unknown", name)
//    //  });
//    //  return;
//    //}
//    contacts.push(contact);
//  }
//  callback(null, contacts);
//}

function _validateContact(req, c, callback) {
  var contact = new Contact({
    riak: req._riak,
    customer: c.customer,
    name: c.name
  });
  contact.exists(function(err, exists) {
    return callback(!(err || !exists));
  });
}


function _validateCheck(req, c, callback) {
  var check = new Check({
    riak: req._riak,
    customer: c.customer,
    name: c.name
  });
  check.exists(function(err, exists) {
    return callback(!(err || !exists));
  });
}




//---- controllers

var exports = module.exports;

// GET /public/:customer/monitors
exports.list = function(req, res, next) {
  log.debug('monitors.list entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var monitor = new Monitor({
    riak: req._riak
  });
  monitor.findByCustomer(req.uriParams.customer, function(err, monitors) {
    if (err) {
      log.warn('Error finding monitors: ' + err);
      res.send(500);
    } else {
      log.debug('monitors.list returning %d, obj=%o', 200, monitors);
      res.send(200, monitors);
    }
    return next();
  });
};


// PUT /public/:customer/monitors/:name
exports.put = function(req, res, next) {
  log.debug('monitors.put entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  var contacts = req.params.contacts;
  var checks = req.params.checks;
  if (!contacts) {
    utils.sendMissingArgument(res, 'contacts');
    return next();
  }
  if (!checks) {
    utils.sendMissingArgument(res, 'checks');
    return next();
  }


  function _putMonitor() {
    var monitor = new Monitor({
      riak: req._riak,
      customer: req.uriParams.customer,
      name: req.uriParams.name,
      contacts: contacts,
      checks: checks
    });

    monitor.save(function(err) {
      if (err) {
        log.warn('monitor.put: error saving: ' + err);
        res.send(500);
      } else {
        var data = monitor.serialize();
        log.debug('monitor.put returning %d, object=%o', 200, data);
        res.send(200, data);
      }
      return next();
    });

  }


  var i = 0;
  var j = 0;
  var checksFinished = 0;
  var contactsFinished = 0;

  function _checkCb(valid) {
    if (!valid) {
      utils.sendNoCheck(res, checks[j].name);
      return next();
    }
    if (++checksFinished >= checks.length) {
      if (contactsFinished >= contacts.length) {
        return _putMonitor();
      }
    }
  }
  for (j = 0; j < checks.length; j++)
    _validateCheck(req, checks[j], _checkCb);


  function _contactCb(valid) {
    if (!valid) {
      utils.sendNoContact(res, contacts[i].name);
      return next();
    }
    if (++contactsFinished >= contacts.length) {
      if (checksFinished >= checks.length) {
        return _putMonitor();
      }
    }
  }
  for (i = 0; i < contacts.length; i++)
    _validateContact(req, contacts[i], _contactCb);
};


// GET /public/:customer/monitors/:monitor
exports.get = function(req, res, next) {
  log.debug('monitors.get entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  res.send(500);
  return next();
  //TODO:
  //var monitor = new Monitor({
  //  riak: req._riak
  //});
  //
  //monitor.load(req.uriParams.monitor, function(err, loaded) {
  //  if (err) {
  //    log.warn('Error loading: ' + err);
  //    res.send(500);
  //  } else {
  //    if (!loaded) {
  //      _sendNoCheck(res, req.uriParams.id);
  //    } else {
  //      var obj = monitor.serialize();
  //      log.debug('checks.get returning %d, obj=%o', 200, obj);
  //      res.send(200, obj);
  //    }
  //  }
  //  return next();
  //});
};


// DELETE /public/:customer/monitors/:monitor
exports.del = function(req, res, next) {
  log.debug('monitors.del entered: params=%o, uriParams=%o',
            req.params, req.uriParams);

  //TODO
  res.send(500);
  return next();
};
