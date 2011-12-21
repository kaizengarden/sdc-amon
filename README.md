# Amon (SDC Monitoring and Alarming)

Where: <git@git.joyent.com:amon.git>, <https://mo.joyent.com/amon>
Who: Trent Mick, Mark Cavage, Yunong Xiao
Pitch: <https://hub.joyent.com/wiki/display/dev/SDC+Monitoring+and+Alarming>
API Docs: <https://head.no.de/docs/amon>
XMPP/Jabber: <monitoring@groupchat.joyent.com>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/MON>
CI builds: <https://jenkins.joyent.us/job/amon>, <https://stuff.joyent.us/stuff/builds/amon/>


Amon is a monitoring and alarming system for SmartDataCenter (SDC). It has
three components: a central master, a tree of relays and agents. Monitors
(grouping of probes and contacts), probes (things to check and alarm on) and
contacts (who and how to contact when there is an alarm) are configured on
the master (i.e. on the "Amon Master API"). Probe data is passed from the
master, via the relays to the appropriate agent where the probe is run. When
a probe fails/trips it raises and event, which passes through the relays up
to the master. The master handles events by creating or updating alarms and
sending notifications to the configured contacts, if appropriate (suppression
and de-duplication rules can mean a notification is not always sent).


# Design Overview

There is an "Amon Master" HTTP server that runs in the amon smartdc zone.
This is the endpoint for the "Amon Master API". The Amon Master stores
long-lived Amon system data (monitors, contacts, probes) in UFDS and
shorter-lived data (alarms and events) in redis (a separate "redis" smartdc
zone).

There is an "Amon Relay" (which could be a tree of Amon Relays if necessary)
running on each node global zone to ferry (1) probe/monitor configuration
down to Amon Agents where probes are run; and (2) events up from agents
to the master for handling. This is installed with the agents shar (which
includes all SDC agents) on each node.

There is an "Amon Agent" running at each location where the supported probes
need to run. For starters we only require an agent in each node global zone.
This is installed with the agents shar (which includes all SDC agents) on
each node. Eventually we may include an agent inside zones (communicating out
via a zsocket) and VMs (not sure how communicating out, HTTP?) to support
probes that must run inside.


# Code Layout

    master/         Amon master (node.js package)
    relay/          Amon relay (node.js package)
    agent/          Amon agent (node.js package)
    plugins/        "amon-plugins" node.js package that holds probe type
                    plugins (e.g. "logscan.js" implements the "logscan"
                    probe type).
    common/         Node.js module to share code between the above packages.
    zwatch/         Zonecfg watcher daemon. Intended to be used by relay to
                    setup watch zone state transitions to setup/teardown
                    zsockets to agents running on zones. However, the first
                    Amon release will only have agents in the GZ so the relay
                    won't need this yet. May be used by *agent* to have a
                    "zone state" probe type.
    
    bin/            Some convenience scripts to run local builds of node, etc.
    docs/           The API doc file. Uses <https://github.com/trentm/restdown>.
                    Dev builds served here: <https://head.no.de/docs/amon>.
    deps/           Git submodule deps.
    examples/       Example data for loading into your dev Amon.
    support/        General support stuff for development of amon.
    sandbox/        Play area. Go crazy.


# Development

Current status:
- Not quite yet running in COAL. For dev: use UFDS in coal and run
  amon master, relay and agent on your Mac.
- Haven't run lint in a long while.


## Mac Setup

To be able to run `make lint` you'll need to install "gjslint" yourself
manually. See:
<http://code.google.com/closure/utilities/docs/linter_howto.html>.

Get the source and build:

    git clone git@git.joyent.com:amon.git
    cd amon
    make all

And start running (see section below).


## COAL Setup

Setup and install the necessary dev tools in the global zone:

    /usbkey/scripts/mount-usb.sh; \
    /usbkey/devtools/devmode.sh; \
    pkgin -y install gmake scmgit gcc-compiler-4.5.2 gcc-runtime-4.5.2 \
          binutils python26 grep pkg_alternatives patch mtail; \
    ln -sf /opt/local/bin/python2.6 /opt/local/bin/python; \
    export PATH=/opt/local/bin:$PATH && \
    export CC=gcc

And if you swing MarkC's way, you can do a `pkgin install emacs-nox11` to be
"awesome".

Then get the Amon code to work with:

    cd /opt && \
    export GIT_SSL_NO_VERIFY=true && \
    git clone git@git.joyent.com:amon.git && \
    cd amon && \
    make all

And start running (see next section).


## Running

Config and run the amon-master:

    cd master
    cp config.mac.json config.json
    # Tweak config.json if you like.
    # See: <https://head.no.de/docs/amon/#master-configuration>
    
    ../bin/node-dev main.js -v -f config.json

Note that "node-dev" (https://github.com/fgnass/node-dev) is a tool for
running a node server and watching its source files. It'll restart the
server whenever a used source file changes. You can just use "../bin/node"
directly if you like.


In a separate shell run an amon-relay:

    cd .../amon/relay
    mkdir -p tmp/db   # a location for caching probe data
    
    # Here we are:
    # - connecting to the master at "localhost:8080"
    # - listening on port 8081 (-s 8081)
    #   (rather than using a Unix domain socket, as is done in production)
    # - polling the master every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/db -m http://localhost:8080 -s 8081 -p 90

    # In production the amon-relay is run as follows, without a '-m' argument
    # so that it has to find the Amon zone in MAPI:
    UFDS_ADMIN_UUID=930896af-bf8c-48d4-885c-6573a94b1853 \
        MAPI_CLIENT_URL=http://10.99.99.8 \
        MAPI_HTTP_ADMIN_USER=admin \
        MAPI_HTTP_ADMIN_PW=xxx \
        ../bin/node-dev main.js -v -D tmp/db -s 8081 -p 90


In a separate shell run an amon-agent:
    
    cd .../amon/agent
    mkdir -p tmp/db   # a location for caching probe data
    
    # Here we are:
    # - connecting to the relay at "localhost:8081"
    # - polling the relay every 90 seconds (-p 90)
    #
    # `../bin/node main.js -h` for details on options.
    #
    ../bin/node-dev main.js -v -D tmp/db -s http://localhost:8081 -p 90


## Adding some data

Get 'sdc-amon' wrapper setup and on your PATH ('sdc-ldap' too). It may
already be there.

    export AMON_URL=http://localhost:8080
    export PATH=.../operator-toolkit/bin:$PATH

In a separate terminal, call the Amon Master API to add some data.
First we need a user to use. I use ldap to directly add this user to UFDS
because that allows us to specify the UUID used, which can be handy.

    sdc-ldap -v add -f examples/user-yunong.ldif
    sdc-ldap -v add -f examples/user-trent.ldif

Amon should now see those users:

    sdc-amon /pub/yunong
    sdc-amon /pub/trent

Add a monitor. We'll call this one "whistle", and just have one contact for
it. A monitor can have any number of contacts (e.g. you might want the
while ops team to know about a particular failure):

    $ cat examples/monitor-whistle.json 
    {
        "contacts": ["email"]
    }
    $ sdc-amon /pub/trent/monitors/whistle -X PUT -d @examples/monitor-whistle.json
    HTTP/1.1 200 OK
    ...
    {
      "name": "whistle",
      "contacts": [
        "email"
      ]
    }

Add a couple probes to this monitor:

    $ sdc-amon /pub/trent/monitors/whistle/probes/whistlelog -X PUT -d @examples/probe-whistlelog.json
    HTTP/1.1 200 OK
    ...
    {
      "name": "whistlelog",
      "machine": "global",
      "type": "logscan",
      "config": {
        "path": "/tmp/whistle.log",
        "regex": "tweet",
        "threshold": 2,
        "period": 60
      }
    }
    $ sdc-amon /pub/trent/monitors/whistle/probes/whistlelog2 -X PUT -d @examples/probe-whistlelog2.json
    HTTP/1.1 200 OK
    ...
    {
      "name": "whistlelog",
      "machine": "global",
      "type": "logscan",
      "config": {
        "path": "/tmp/whistle.log",
        "regex": "tweet",
        "threshold": 2,
        "period": 60
      }
    }

And list probes:

    $ sdc-amon /pub/trent/monitors/whistle/probes
    HTTP/1.1 200 OK
    ...
    [
      {
        "user": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "monitor": "whistle",
        "name": "whistlelog2",
    ...
    ]



## Tickle a probe, get an email

If you have every thing right you should be able to tickle one of those
probes.

    echo "`date`: tweet" > /tmp/whistle.log     # once
    echo "`date`: tweet" > /tmp/whistle.log     # and twice b/c "threshold=2"

What should happen now:

1. The agent should generate an event for the "whistlelog" probe and send
   to the master:
    
        2011-11-22 23:50:19Z INFO: sending event: { probe: 
            { user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            monitor: 'whistle',
            name: 'whistlelog',
            type: 'logscan' },
         type: 'Integer',
         value: 2,
         data: { match: 'Tue Nov 22 15:50:19 PST 2011: tweet' },
         uuid: '4eb28122-db69-42d6-b20a-e83bf6883b8b',
         version: '1.0.0' }

2. The relay should pass this on up to the master:

        2011-11-22 23:50:19Z DEBUG: relaying event: { probe:
        ...

3. The master should send a notification for the event. (Eventually this
   should create or update an "alarm" instance and *possibly* notify.)
   
        2011-11-22 23:50:19Z DEBUG: App.processEvent: { probe: 
        ...
        2011-11-22 23:50:21Z DEBUG: App.processEvent: notify contact 'email'
        2011-11-22 23:50:22Z DEBUG: App.processEvent: contact 'email' notified
        127.0.0.1 - anonymous [22/11/2011:23:50:22 GMT] "POST /events HTTP/1.1" 202 0 2628


## Testing

The test suite is in the 'tst' directory.

First, create the test configuration:

    cd tst && cp config.json.in config.json

Default config notes:

- Presumes you have a usb-headnode.git clone in a sibling dir to your
  amon.git clone. This is used to get "config.coal" info for finding
  MAPI in your COAL.
- Presumes a UFDS running in COAL.
- Master tests use a 'email' notification plugin using the 'testy' module.
- Uses port 7000 to intentionally differ from the master default of 8080,
  which you might already be using for a dev server.

Second, prepare your COAL for testing with a test user, key and zone:

    cd tst
    node prep.js   # creates prep.json used by test suite.

Now run the test suite:

    make test

You can run individual test files to get more detailed output, for example:

    cd tst
    ../bin/node master.test.js

If you are getting spurious errors, it may be that a previous test run
has left crud data in UFDS. Clean it out by running:

    ./tst/clean-test-data.sh   # `make test` doesn't this as well


# MVP

Roughly said:

"The absolute MVP for Monitoring is having the ability to alert when a
VM or Zone goes down, and the ability to alert someone via email."

More detail:

- Only necessary alert medium: email.
- Ability to alert operator when a machine goes down. Presumably only wanted
  when going down is a fault. (Or perhaps not, Trevor is going to ask
  JPC ops guys about that.)
- Ability to alert operator when that machine comes back up (aka a "clear" or "ok").
- Ability to alert customer when their machine goes down.
  Option to distinguish between going down for a fault (FMA) or any reason
  (includes intentional reboots).
  Q: Where does the reboot of a full CN fit in here?
- Ability to alert customer when their machine comes back up (aka a "clear" or "ok").
- Ability to suppress alerts on an open alarm. (Yes, I know there is a
  problem here, quit bugging me about it.)
- Ability to disable a monitor.
- Ability for customer to set a maintenance window on a monitor (alert
  suppression for a pre-defined period of time).
- Ability for operator to set a maintenance window on a CN and on the whole
  cloud. This would disable alerts to operator.
  Q: Disable alerts to customers? How about it adds a "BTW, this is during a
  maint window" ps to each alert?
- Amon Master API integrated into Cloud API.
- Integration of Monitor management into AdminUI and Portal.
- Upgradable amon system.


# Glossary

- A "monitor" is a the main conceptual object that is configured by operators
  and customers using Amon. It includes the details for what checks to
  run and, when a check trips, who and how to notify ("contacts").
- A "probe" is a single thing to check (the atom of physical monitoring
  done by the Amon agents). E.g. "Check the running state of zone X." "Check
  for 3 occurrences of 'ERROR' in 'foo.log' in zone X within 1 minute." A
  monitor includes one or more probes.
- An "event" is a message sent from an Amon agent up to the Amon master that
  might create or update an alarm.
- An open or active "alarm" is the state of a failing monitor. An alarm is
  created when a monitor trips (i.e. one of its checks fails). An alarm can
  be closed by user action (via the API or in the Operator or User Portals)
  or via an Amon clear event -- the failing state is no longer failing, e.g.
  a halted machine has come back up.  An alarm object lives until it is
  closed.
- A "notification" is a message sent for an alarm to one or more contacts
  associated with that monitor. An alarm may result in many notifications
  through its lifetime.



# Use Cases

A few use cases to start to feel out practicalities.

1.  Operator SDC Log monitor. Probe for watching log file of each SDC svc log
    for ERROR, say (need to be specified). Probe watching for ERROR in
    smartdc and core zones' primary service log files.
        
        PUT /my/monitors/logs < {
                "contacts": ["email"]
            }
        PUT /my/monitors/logs/probes/$machine_uuid < {
                "type": "logscan",
                "machine": "$machine_uuid",
                "config": {       // TODO: perhaps back to "config" here, from "data"
                  "path": "/tmp/whistle2.log",
                  "regex": "tweet",
                  "threshold": 1,
                  "period": 60
                }
            }


2. Operator SDC Zones monitor. Probe for SDC zones going up and down.
   Separate from "SDC Log monitor" because zone up/down alarms can clear.
        
        PUT /my/monitors/zones < {
                "contacts": ["email"]
            }
        PUT /my/monitors/zones/probes/$machine_uuid < {
                "type": "machinedown",
                "machine": "$machine_uuid"
                // "runInGlobal": true    // Added by Amon master
            }

3. Operator SDC Services monitor. Probe for SDC zones' and GZ's "smartdc"
   services going up/down.

        PUT /my/monitors/services < {
                "contacts": ["email"]
            }
        PUT /my/monitors/services/probes/$machine_uuid < {
                "type": "smf",
                "machine": "$machine_uuid",
                "config": {
                    "fmri": "$fmri"
                }
            }

4.  Customer "Machine up" monitor. Probe for each of my machines going up
    and down.
   
    Portal UX: This monitor is likely often wanted for *all* my zones.
    However, don't want it on by default. Should portal's page after
    "create new machine" have a big button (or a checkbox) to add this
    monitor for this zone. Nice to have would be to offer checkboxes for
    all monitors on existing zones: "You have monitor A on (some of) your
    other machines. Would you like it on this one too?" Should portal add
    a separate monitor? Or add a probe (or probes?) to the same monitor?
    Probably another probe to the same monitor. Naming (of probe or
    monitor) will be a pain, need to include machine UUID in the name?
    
    Cloud API: You have to add these separately per-machine. That shouldn't
    be so bad.
    
        PUT /my/monitors/machine-up < {
                "contacts": ["email"]
            }
        PUT /my/monitors/machine-up/probes/$machine_uuid < {
                "type": "machinedown",
                "machine": "$machine_uuid"
            }

5.  Customer "Site up" monitor. Probe to "GET /canary" on the site from
    some other source location.
        
        PUT /my/monitors/site < {
                "contacts": ["email"]
            }
        PUT /my/monitors/site/probes/webcheck < {
                "machine": "$machine_uuid",  // <--- this is the machine to run HTTP request from
                "type": "httprequest",
                "config": {
                    "url": "http://example.com/canary.html",
                    "method": "GET",
                    "status": 200  // number or list of HTTP status numbers to expect
                    "regex": "...",   // check for a pattern in returned content
                    "period": 60  // how frequently to check. Should this be exposed?
                }
            }

6.  Operator wants to run a particular "mdb -k" goober (Bryan's words) to
    run a healthcheck on KVM.
    
        PUT /my/monitors/kvmcheck < {
                "contacts": ["email"]
            }
        PUT /my/monitors/kvmcheck/probes/foo < {
                "type": "mdbkernel",
                "machine": "$machine_uuid",
                "runInGlobal": true,   // must be operator to set this
                "config": {
                    // This is essential wide open. That command can presumably
                    // do anything.
                    "command": ...,
                    "regex": "...",   // check for a pattern in returned content?
                    // Something to check exit value?
                    "period": 60  // how frequently to check.
                }
            }

7.  Run a probe on a particular server's GZ. I.e. doesn't have. a particular
    "machine" uuid target. For machine UUIDA we

        machine UUID1 -> "machine": UUID1
        machine UUID2's GZ -> "machine": UUID2, "runInGlobal": true
        server UUID3 GZ -> "server": UUID3, "machine": undefined

    Must be an operator to add probe with 'server' attribute. Add
    "GET /agentprobes?server=:uuid".

    For dev support AMON_DEV=1 to allow `"server": "headnode"` to pick
    headnode.
