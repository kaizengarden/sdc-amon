// Copyright 2011 Joyent, Inc.  All rights reserved.
var assert = require('assert');
var restify = require('restify');

var amon_common = require('amon-common');

var Check = require('./model/check');
var Event = require('./model/event');

var Constants = amon_common.Constants;
var Messages = amon_common.Messages;

var log = restify.log;
var _error = restify.newError;
var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;

var _message = Messages.message;

function _sendInternalError(res) {
  var e = _error({httpCode: HttpCodes.InternalError,
                  restCode: RestCodes.UnknownError
                 });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}

function _sendMissingArgument(res, arg) {
  var e = _error({httpCode: HttpCodes.Conflict,
                  restCode: RestCodes.MissingParameter,
                  message: _message(Messages.MissingParameter, arg)
                 });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}


function _sendNoCheck(res, check) {
  var e = _error({httpCode: HttpCodes.NotFound,
                  restCode: RestCodes.InvalidArgument,
                  message: _message(Messages.UnknownCheck, check)
                 });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}

function _sendInvalidCustomer(res, customer, check) {
  var e = _error({httpCode: HttpCodes.Conflict,
                  restCode: RestCodes.InvalidArgument,
                  message: _message(Messages.CustomerInvalidForCheck,
                                    customer, check)
                 });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}

function _sendInvalidZone(res, zone, check) {
  var e = _error({httpCode: HttpCodes.Conflict,
                  restCode: RestCodes.InvalidArgument,
                  message: _message(Messages.ZoneInvalidForCheck, zone, check)
                 });
  if (log.debug()) {
    log.debug('sending error: ' + e);
  }
  res.sendError(e);
}


module.exports = {

  handle: function handle(req, res, next) {
    if (res._eventResultSent) return next();
    assert.ok(req._amonEvent);
    log.debug('events.handle: event=%o, params=%o',
              req._amonEvent, req.params);

    if (!req.params.check) {
      _sendMissingArgument(res, 'check');
      return next();
    }

    if (!req.params.zone) {
      _sendMissingArgument(res, 'zone');
      return next();
    }

    if (!req.params.customer) {
      _sendMissingArgument(res, 'customer');
      return next();
    }

    var check = new Check({
      redis: req._redis,
      id: req.params.check
    });

    check.load(function(err, loaded) {
      if (err) {
        log.warn('Error loading check from redis: ' + err);
        res.send(500);
        return next();
      }
      if (!loaded) {
        log.debug('Check %s not found', req.params.check);
        _sendNoCheck(res, req.params.check);
        return next();
      }

      if (check.customer !== req.params.customer) {
        log.debug('Check %s is for customer %s. Request asked for customer %s',
                  check.id, check.customer, req.params.customer);
        _sendInvalidCustomer(res, req.params.customer, check.id);
        return next();
      }

      if (check.zone !== req.params.zone) {
        log.debug('Check %s is for zone %s. Request asked for zone %s',
                  check.id, check.zone, req.params.zone);
        _sendInvalidZone(res, req.params.zone, check.id);
        return next();
      }

      var event = new Event({
        redis: req._redis,
        check: check.id,
        customer: req.params.customer,
        event: req._amonEvent,
        zone: req.params.zone
      });

      event.save(function(err) {
        log.debug('event(' + event.id + ').save: err=' + err);
        if (err) {
          _sendInternalError(res);
        } else {
          log.debug('events.handle returning %d, object=%o',
                    HttpCodes.Created, event.toObject());
          res.send(HttpCodes.Created, event.toObject());
        }
        return next();
      });
    });
  }

};