// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');
var restify = require('restify');
var uuid = require('node-uuid');

var App = require('../lib/app');
var common = require('./lib/common');

restify.log.level(restify.LogLevel.Debug);

// Globals for tests
var app;
var owner;
var root;
var socket;
var zone;

function _options(path) {
  var options = {
    socketPath: socket,
    method: 'POST',
    path: '/checks/' + uuid(),
    headers: {}
  };
  if (path) options.path += path;
  options.headers['Content-Type'] = 'application/json';
  options.headers['x-api-version'] = '6.1.0';
  return options;
}

//// Tests

exports.setUp = function(test, assert) {
  var self = this;

  socket = '/tmp/.' + uuid();
  owner = uuid();
  zone = uuid();
  root = uuid();

  app = new App({
    zone: uuid(),
    socket: socket,
    owner: uuid(),
    localMode: true,
    configRoot: 'foo'
  });
  assert.ok(app);

  app.listen(function() {
    test.finish();
  });
};

exports.test_missing_status = function(test, assert) {
  http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'MissingParameter');
      test.finish();
    });
  }).end();
};

exports.test_missing_metrics = function(test, assert) {
  http.request(_options('?status=ok'), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'MissingParameter');
      test.finish();
    });
  }).end();
};

exports.test_invalid_status = function(test, assert) {
  var opts = _options('?status=' + uuid() + '&metrics=foo');
  http.request(opts, function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  }).end();
};

exports.test_invalid_metrics_not_object = function(test, assert) {
  http.request(_options('?status=ok&metrics=foo'), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  }).end();
};

exports.test_invalid_metrics_invalid_object = function(test, assert) {
  var req = http.request(_options('?status=ok'), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  });

  req.write(JSON.stringify({metrics: { foo: 'bar'} }));
  req.end();
};

exports.test_success_with_object = function(test, assert) {
  var req = http.request(_options('?status=ok'), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 202);
    test.finish();
  });

  req.write(JSON.stringify({
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};

exports.test_success_with_array = function(test, assert) {
  var req = http.request(_options('?status=ok'), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 202);
    test.finish();
  });

  req.write(JSON.stringify({
    metrics: [{
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }]
  }));
  req.end();
};

exports.tearDown = function(test, assert) {
  app.close(function() {
    test.finish();
  });
};
