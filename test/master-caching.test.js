/**
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * Test ufds.caching=true handling in the master.
 */

var debug = console.log;
var fs = require('fs');
var http = require('http');
var format = require('util').format;
var test = require('tap').test;
var async = require('async');

var common = require('./common');



//---- globals

var masterClient = common.createAmonMasterClient('master-caching');
var prep = JSON.parse(fs.readFileSync('/var/tmp/amontest/prep.json', 'utf8'));
var ulrich = prep.ulrich;
var odin = prep.odin;

var FIXTURES = {
  ulrich: {
    monitors: {
      whistle: {
        contacts: ['email'],
        probes: {
          whistlelog: {
            'type': 'logscan',
            'machine': prep.amontestzone.name,
            'config': {
              'path': '/tmp/whistle.log',
              'regex': 'tweet',
              'threshold': 1,
              'period': 60
            }
          }
        }
      }
    }
  }
};



//---- test: monitors

test('monitors: list empty', function (t) {
  masterClient.get('/pub/amontestuserulrich/monitors',
                   function (err, req, res, obj) {
    t.ifError(err);
    t.ok(Array.isArray(obj));
    t.equal(obj.length, 0);

    // Second time should be fast.
    masterClient.get('/pub/amontestuserulrich/monitors',
                     function (err2, req2, res2, obj2) {
      t.ifError(err2);
      t.equal(obj2.length, 0);
      // Testing x-response-time is a poor metric for 'was it cached', but
      // don't want to add hacks to server for an 'X-Amon-Cached: true' or
      // something.
      t.ok(Number(res2.headers['x-response-time']) < 50,
           'faster cached response');
      t.end();
    });
  });
});

test('monitors: get a monitor not yet added', function (t) {
  async.forEach(Object.keys(FIXTURES.ulrich.monitors), function (name, next) {
    // var data = FIXTURES.ulrich.monitors[name];
    var url = '/pub/amontestuserulrich/monitors/' + name;
    masterClient.get(url, function (err, req, res, obj) {
      t.equal(err.httpCode, 404, 'should be 404 for GET ' + url);
      t.equal(err.restCode, 'ResourceNotFound');
      next();
    });
  }, function (err) {
    t.end();
  });
});

test('monitors: create', function (t) {
  async.forEach(Object.keys(FIXTURES.ulrich.monitors), function (name, next) {
    var data = common.objCopy(FIXTURES.ulrich.monitors[name]);
    delete data['probes']; // 'probes' key holds probe objects to add (later);
    masterClient.put('/pub/amontestuserulrich/monitors/'+name, data,
      function (err, req, res, obj) {
        t.ifError(err);
        t.equal(obj.name, name);
        t.equal(obj.contacts.sort().join(','),
          data.contacts.sort().join(','),
          format('monitor.contacts: %s === %s', obj.contacts, data.contacts));
        next();
      });
  }, function (err) {
    t.end();
  });
});

// That create should have invalidated the cache. The next fetch should have
// the new value.
test('monitors: list', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  masterClient.get('/pub/amontestuserulrich/monitors',
                   function (err, req, res, obj) {
    t.ifError(err);
    t.ok(Array.isArray(obj));
    t.equal(obj.length, Object.keys(monitors).length);

    // Second time should be fast.
    masterClient.get('/pub/amontestuserulrich/monitors',
                     function (err2, req2, res2, obj2) {
      t.ifError(err2);
      t.equal(obj2.length, obj.length);
      t.ok(Number(res2.headers['x-response-time']) < 50,
        format('faster cached response (< 50ms, actually took %sms)',
          res2.headers['x-response-time']));
      t.end();
    });
  });
});

test('monitors: get', function (t) {
  async.forEach(Object.keys(FIXTURES.ulrich.monitors), function (name, next) {
    var data = FIXTURES.ulrich.monitors[name];
    masterClient.get('/pub/amontestuserulrich/monitors/'+name,
                     function (err, req, res, obj) {
      t.ifError(err);
      t.equal(obj.contacts.sort().join(','),
        data.contacts.sort().join(','),
        format('monitor.contacts: %s === %s', obj.contacts, data.contacts));

      // Second time should be fast.
      masterClient.get('/pub/amontestuserulrich/monitors/'+name,
                       function (err2, req2, res2, obj2) {
        t.ifError(err2);
        t.equal(obj2.contacts.sort().join(','),
          data.contacts.sort().join(','),
          format('monitor.contacts: %s === %s', obj2.contacts, data.contacts));
        t.ok(Number(res2.headers['x-response-time']) < 50,
             'faster cached response');
        next();
      });
    });
  }, function (err) {
    t.end();
  });
});


//---- test HeadAgentProbes before any probes

var sulkyzoneContentMD5;

test('ListAgentProbes before any probes', function (t) {
  // var probe = FIXTURES.ulrich.monitors.whistle.probes.whistlelog;
  masterClient.get('/agentprobes?agent=' + prep.amontestzone.name,
    function (err, req, res, obj) {
      t.ifError(err);
      sulkyzoneContentMD5 = res.headers['content-md5'];
      t.ok(Array.isArray(obj), 'ListAgentProbes response is an array');
      t.equal(obj.length, 0);
      t.end();
    }
  );
});

test('HeadAgentProbes before any probes', function (t) {
  // var probe = FIXTURES.ulrich.monitors.whistle.probes.whistlelog;
  masterClient.head('/agentprobes?agent=' + prep.amontestzone.name,
    function (err, headers, res) {
      t.ifError(err);
      t.equal(res.headers['content-md5'], sulkyzoneContentMD5);

      // Second time should be fast.
      masterClient.head('/agentprobes?agent=' + prep.amontestzone.name,
        function (err2, req2, res2) {
          t.ifError(err2);
          t.equal(res2.headers['content-md5'], sulkyzoneContentMD5);
          t.ok(Number(res2.headers['x-response-time']) < 50,
               'faster cached response');
          t.end();
        }
      );
    }
  );
});



//---- test: probes

test('probes: list empty', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(Object.keys(monitors), function (monitorName, next) {
    // var probes = monitors[monitorName].probes;
    masterClient.get(
      format('/pub/amontestuserulrich/monitors/%s/probes', monitorName),
      function (err, req, res, obj) {
        t.ifError(err);
        t.ok(Array.isArray(obj));
        t.equal(obj.length, 0);

        // Second one from cache should be fast.
        masterClient.get(
          format('/pub/amontestuserulrich/monitors/%s/probes', monitorName),
          function (err2, req2, res2, obj2) {
            t.ifError(err2);
            t.equal(obj2.length, 0);
            t.ok(Number(res2.headers['x-response-time']) < 50,
                 'faster cached response');
            next();
          }
        );
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: get a probe not yet added', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(Object.keys(monitors), function (monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function (probeName, nextProbe) {
      // var probe = probes[probeName];
      masterClient.get(format('/pub/amontestuserulrich/monitors/%s/probes/%s',
                              monitorName, probeName),
        function (err, req, res, obj) {
          t.equal(err.httpCode, 404);
          t.equal(err.restCode, 'ResourceNotFound');
          nextProbe();
        }
      );
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    t.end();
  });
});

test('probes: create', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(Object.keys(monitors), function (monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function (probeName, nextProbe) {
      var probe = probes[probeName];
      var path = format('/pub/amontestuserulrich/monitors/%s/probes/%s',
                        monitorName,
                        probeName);
      masterClient.put(path, probe, function (err, req, res, obj) {
        t.ifError(err, 'error PUT\'ing '+path);
        t.equal(obj.name, probeName);
        t.equal(obj.machine, probe.machine);
        t.equal(obj.agent, probe.machine);
        t.equal(obj.type, probe.type);
        Object.keys(obj.config).forEach(function (k) {
          t.equal(obj.config[k], probe.config[k]);
        });
        nextProbe();
      });
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    t.end();
  });
});


// That create should have invalidated the cache. The next fetch should have
// the new value.
test('probes: list', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(Object.keys(monitors), function (monitorName, next) {
    var probes = monitors[monitorName].probes;
    masterClient.get(
      format('/pub/amontestuserulrich/monitors/%s/probes', monitorName),
      function (err, req, res, obj) {
        t.ifError(err);
        t.ok(Array.isArray(obj), 'listProbes response is an array');
        t.equal(obj.length, Object.keys(probes).length);

        // Second time should be fast.
        masterClient.get(
          format('/pub/amontestuserulrich/monitors/%s/probes', monitorName),
          function (err2, req2, res2, obj2) {
            t.ifError(err2);
            t.equal(obj2.length, obj.length);
            t.ok(Number(res2.headers['x-response-time']) < 50,
                 'faster cached response');
            next();
          }
        );
      }
    );
  }, function (err) {
    t.end();
  });
});

test('probes: get', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(Object.keys(monitors), function (monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function (probeName, nextProbe) {
      var probe = probes[probeName];
      masterClient.get(
        format('/pub/amontestuserulrich/monitors/%s/probes/%s', monitorName,
               probeName),
        function (err, req, res, obj) {
          t.ifError(err);
          t.equal(obj.name, probeName);
          t.equal(obj.machine, probe.machine);
          t.equal(obj.type, probe.type);
          Object.keys(obj.config).forEach(function (k) {
            t.equal(obj.config[k], probe.config[k]);
          });

          // Second time should be faster.
          masterClient.get(
            format('/pub/amontestuserulrich/monitors/%s/probes/%s',
                   monitorName,
                   probeName),
            function (err2, req2, res2, obj2) {
              t.ifError(err);
              t.equal(obj2.name, probeName);
              t.equal(obj2.machine, probe.machine);
              t.equal(obj2.type, probe.type);
              Object.keys(obj2.config).forEach(function (k) {
                t.equal(obj2.config[k], probe.config[k]);
              });
              t.ok(Number(res2.headers['x-response-time']) < 50,
                   'faster cached response');
              nextProbe();
            }
          );
        }
      );
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    t.end();
  });
});


var newSulkyzoneContentMD5;
test('HeadAgentProbes changed after probe added',
     {timeout: 5000},
     function (t) {
  // var probe = FIXTURES.ulrich.monitors.whistle.probes.whistlelog;
  masterClient.head('/agentprobes?agent=' + prep.amontestzone.name,
    function (err, headers, res) {
      t.ifError(err);
      newSulkyzoneContentMD5 = res.headers['content-md5'];
      t.ok(newSulkyzoneContentMD5 !== sulkyzoneContentMD5,
        'expect amontestzone Content-MD5 to have changed');

      // Second time should be fast.
      masterClient.head('/agentprobes?agent=' + prep.amontestzone.name,
        function (err2, req2, res2) {
          t.ifError(err2, '/agentprobes?agent=' + prep.amontestzone.name);
          t.equal(res2.headers['content-md5'], newSulkyzoneContentMD5);
          t.ok(Number(res2.headers['x-response-time']) < 50,
               'faster cached response');
          t.end();
        }
      );
    }
  );
});

test('ListAgentProbes', function (t) {
  // var probe = FIXTURES.ulrich.monitors.whistle.probes.whistlelog;
  masterClient.get('/agentprobes?agent=' + prep.amontestzone.name,
    function (err, req, res, obj) {
      t.ifError(err);
      t.equal(res.headers['content-md5'], newSulkyzoneContentMD5);
      t.ok(Array.isArray(obj), 'GetAgentProbes response is an array');
      t.equal(obj.length, 1);
      t.end();
    }
  );
});



//---- test deletes (and clean up test data)

test('probes: delete', function (t) {
  var monitors = FIXTURES.ulrich.monitors;
  async.forEach(Object.keys(monitors), function (monitorName, nextMonitor) {
    var probes = monitors[monitorName].probes;
    async.forEach(Object.keys(probes), function (probeName, nextProbe) {
      // var probe = probes[probeName];
      masterClient.del(
        format('/pub/amontestuserulrich/monitors/%s/probes/%s', monitorName,
               probeName),
        function (err, headers, res) {
          t.ifError(err);
          t.equal(res.statusCode, 204);
          nextProbe();
        }
      );
    }, function (err) {
      nextMonitor();
    });
  }, function (err) {
    // Give riak some time to delete this so don't get 'UFDS:
    // NotAllowedOnNonLeafError' error deleting the parent monitor below.
    setTimeout(function () { t.end(); }, 3000);
  });
});


//TODO: test probe deletion from cache here.


test('monitors: delete', function (t) {
  async.forEach(Object.keys(FIXTURES.ulrich.monitors), function (name, next) {
    // var data = FIXTURES.ulrich.monitors[name];
    masterClient.del('/pub/amontestuserulrich/monitors/'+name,
                     function (err, headers, res) {
      t.ifError(err);
      t.equal(res.statusCode, 204);
      next();
    });
  }, function (err) {
    t.end();
  });
});


//---- test that list/get are now empty again

test('monitors: list empty again', function (t) {
  masterClient.get('/pub/amontestuserulrich/monitors',
                   function (err, req, res, obj) {
    t.ifError(err);
    t.ok(Array.isArray(obj));
    t.equal(obj.length, 0);

    // Second time should be fast.
    masterClient.get('/pub/amontestuserulrich/monitors',
                     function (err2, req2, res2, obj2) {
      t.ifError(err2);
      t.equal(obj2.length, 0);
      // Testing x-response-time is a poor metric for 'was it cached', but
      // don't want to add hacks to server for an 'X-Amon-Cached: true' or
      // something.
      t.ok(Number(res2.headers['x-response-time']) < 50,
           'faster cached response');
      t.end();
    });
  });
});

test('monitors: get a monitor now removed', function (t) {
  async.forEach(Object.keys(FIXTURES.ulrich.monitors), function (name, next) {
    // var data = FIXTURES.ulrich.monitors[name];
    masterClient.get('/pub/amontestuserulrich/monitors/'+name,
                     function (err, req, res, obj) {
      t.ok(err);
      t.equal(err.httpCode, 404);
      t.equal(err.restCode, 'ResourceNotFound');
      next();
    });
  }, function (err) {
    t.end();
  });
});
