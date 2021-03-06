---
title: Amon (SDC Monitoring and Alarming)
markdown2extras: tables, code-friendly, cuddled-lists, fenced-code-blocks
apisections: Master API: Probe Groups, Master API: Probes, Master API: Alarms, Master API: Maintenance Windows, Master API: Miscellaneous, Relay API, Relay Admin API
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Amon (SDC Monitoring and Alarming)

This is the reference documentation for Amon, the monitoring and alarming
system for SmartDataCenter (SDC). It includes both information relevant
to SDC developers using Amon and internal API details. *End-user docs for SDC
monitoring and alarming are part of the Cloud API documentation.*

For external users (i.e. anyone other than an Amon developer), it is the Amon
Master API (or "Amon API" for short) that is most relevant. This document
also describes the (internal) Relay API and administrative endpoints on the
Master API.

Public endpoints of the Amon Master API are under a "/pub" prefix to
facilitate proxying to Cloud API. For example, the set of open alarms for an
user is:

    GET  /pub/:account/probes        # Amon Master API
    GET  /:login/probes              # Cloud API (**to be determined**)

Where ":account" is typically a user UUID. However, for convenience in
development, ":account" may also be a user's login string. Note that Amon
does no auth. That is up to Cloud API.


## Conventions and Notes

Any content formatted like this:

    $ sdc-amon /ping

is a command-line example that you can run from a shell. All other examples
and information are formatted like this:

    GET /my/stor/foo HTTP/1.1

`sdc-amon` is a light wrapper around `curl` for calling the Amon Master API.
It is available in the GZ ([source
code](https://mo.joyent.com/usb-headnode/blob/master/tools/sdc-amon)). For
example `sdc-amon /ping` translates to:

    curl -sS -i -H accept:application/json -H content-type:application/json \
        --url http://10.2.207.185/ping


## Current Status

- Functional for internal SDC usage, but not yet for customers.
- Running an amon-agent in a zone is not yet supported. Currently there
  are only amon-agents running in the compute node (and headnode) GZs. This
  limits which [types of probes](#probe-types) can be effective run.
  See [MON-29](https://devhub.joyent.com/jira/browse/MON-29).
- Amon is not integrated into cloudapi, portal or adminui.



# Amon Overview

Amon is a monitoring and alarming system for SmartDataCenter (SDC). From
the user point of view Amon provides an API (part of Cloud API) and UI
(in the portals) to configure monitoring. Configuration information is
propagated to an amon-agent running in their zone (a few types of probes
don't require the user to run an amon-agent). On detecting a fault, the
amon-agent will send an event to the central master, typically resulting in
an alarm (an object accessible via the API and portals) and a notification
(email, SMS, webhook, etc.).

Operationally, Amon has three components: a central master ("amon-master"), a
relay agent ("amon relay") in each compute node global zone, agents
("amon-agent") in global zones and, eventually, in zones. See the [Operators
Guide](#operators-guide) for more details.


# Key Concepts

**Probes** (things to check and alarm on) and **probe groups** (optional
grouping of related probes) are configured on the master (i.e. by calling the
"Amon Master API"). Probe data is passed from the master, via the relays to
the appropriate agent where the probe is run. When a probe faults it raises
an event, which passes through the relays up to the master. The master
handles events by creating or updating **alarms** and sending notifications
to the configured contacts, if appropriate. **Maintenance windows** and
de-duplication rules can mean a notification is not always sent). Contact
info lives with the user account in UFDS (extra fields on the "sdcPerson"
LDAP object).


## Contacts

A **contact** provides the data needed to send a notification. Each probe
or probe group has a list of contact names that are all notified for alarms.
Currently, a contact is a name/value pair stored on the "sdcPerson" object in
UFDS. For example, this user (ulrich):

    $ ldapsearch ... login=ulrich
    dn: uuid=deadbeef-1111-1111-1111-111111111111, ou=users, o=smartdc
    cn: Ulrich
    sn: Greunfeld
    email: ulrich@example.com
    login: ulrich
    objectclass: sdcperson
    uuid: 0754aa4c-bdc2-374c-bdc0-32702564210f
    testwebhook: http://10.2.207.2:8000/

Contacts for Ulrich are `email: ulrich@example.com` (notification type
"email") and `testwebhook: http://10.2.207.2:8000/` (notification type
"webhook). The *type* of notification mechanism must be the suffix of the
contact name. (That is lame and will be changed.)

TODO: Describe the new contacts API and handling when implemented (MON-150)


## Probes

A **probe** is a single thing to check. E.g. "Check the running state of vm
X." "Check for 3 occurrences of 'ERROR' in 'foo.log' in vm X within 1
minute." "Check if the average ping (ICMP) time to host X is under 50ms."
A probe has a UUID, a free form name (to assist users with identification,
not guaranteed to be unique), a set of contacts to be notified, and optionally
a probe group to which it belongs. See [Master API:
Probes](#master-api-probes) for how to create/list/delete probes. See
[Probe Types](#probe-types) for a description of supported probe types.


## Probe Groups

Optionally one can group a number of probes into one set. For larger
setups (with many machines, services, probes) this can be helpful:

- The set of contacts for probes in the group is specified on the group,
  rather than separately on each probe.
- Events/notifications for all probes in a group will be grouped under a
  single alarm. That means that related failures will be shown together in
  the portal, notifications and the API.
- Maintenance windows (to suppress notifications) and disabling probes
  can all be done on the group.

Like probes, a probe group has a UUID and a free form name (to assist with
identification, not unique). See [Master API: Probe
Groups](#master-api-probe-groups) for how to create/list/delete probe groups.


## Maintenance Windows

A user can create a **maintenance window** to indicate that disruptive
work is being done and Amon should not send notifications for covered
monitors or machines. A maintenance window has "start" and "end" times
and can be scoped to cover one of: (a) all monitors/machine, (b) a
specific set of monitors, or (c) a specific set of machines. See [Master API:
Maintenance Windows](#master-api-maintenance-windows) for how to
create/list/delete maintenance windows.


## Alarms

A **alarm** is an object created by Amon when a fault is detected by a
running probe. Typically an alarm is associated with a monitor. When
created an alarm is "open" (`closed === false`). An alarm can be closed
either manually via the API or automatically (depending on the type of
probe) when the running probe detects that the problem has gone away. This
is called "clearing" the alarm. Closed alarms are automatically expunged
after a week.

Typically alarm state changes (opening, closing, additional faults detected)
result in notifications per the contact information for the associated
monitor. However, maintenance windows and de-duplication rules can affect
this.

See [Master API: Alarms](#master-api-alarms) for how to list/close/delete
alarms.


## Other common terms

- An **event** is a message sent from an Amon agent up to the Amon master that
  might create or update an alarm.
- An open **alarm** is the state of a failing probe (or probe group). An
  alarm is created when a probe faults. An alarm can be closed by user action
  (via the API or in the Operator or User Portals) or via an Amon *clear*
  event -- the failing state is no longer failing, e.g. a halted machine has
  come back up. An alarm object lives until it is closed.
- A **fault** is a single probe failure (i.e. it finds the condition for
  which it is configured to check). An open alarm has one or more faults: one
  for each probe that reported a fault event.
- A **notification** is a message sent for an alarm to one or more contacts
  associated with that probe (or probe group). An alarm may result in many
  notifications through its lifetime.
- A **machine** is used to represent any of a software VM, a hardware VM
  (i.e. a zone) or a node (i.e. a physical compute node or server). The
  machine value is a UUID.


# API Error Responses

**Warning: Error responses are not well specified yet in Amon. See
[MON-108](https://devhub.joyent.com/jira/browse/MON-108). TODO: Complete list.
Show examples.**

If you get back any error code in the 4xx range, you will receive a formatted
error message of the scheme:

    {
      "code": "CODE",
      "message": "human readable string"
    }

Where the code element is one of:

* InvalidArgument
* InvalidHeader
* MissingParameter
* RequestTooLarge
* ResourceNotFound
* UnknownError
* any of the errors from <http://ldapjs.org/errors.html>

Clients are expected to check HTTP status code first, and if in the 4xx range,
they can leverage the codes above.



# Master API: Probe Groups

A probe group is an optional grouping of probes. When a member of a group,
the groups "contacts" take precedence. Probes in a group can be disabled
as a group, put in a maintenance window as a group, etc. See the [Probe
Groups](#probe-groups) section above for more details.

In the API, a probe group contains the following fields:

| Field    | Type   | Description                                                                    |
| -------- | ------ | ------------------------------------------------------------------------------ |
| user     | String | The UUID of the owning user of this probe group.                               |
| uuid     | UUID   | Unique identifier for this probe group.                                        |
| name     | String | Free form name (max 512 chars).                                                |
| contacts | Array  | Set of contact names that are to be notified when a probe in the group alarms. |


## ListProbeGroups (GET /pub/:account/probegroups)

List all probe groups for this user.

### Inputs

None.

### Returns

An array of probe group objects.

### Errors

TODO: errors

### Example

TODO: example


## GetProbeGroup (GET /pub/:account/probegroups/:uuid)

Get a probe group by name.

### Inputs

None.

### Returns

A probe group object.

### Errors

TODO: errors

### Example

TODO: example


## CreateProbeGroup (POST /pub/:account/probegroups)

Create a probe group.

### Inputs

| Field      | Required? | Type   | Description                                                                            |
| ---------- | --------- | ------ | -------------------------------------------------------------------------------------- |
| user (URL) | -         | String | The user UUID (from UFDS) or username ('login' in UFDS)                                |
| contacts   | required  | Array  | An array of contact names to notify when probes in this group alarm.                   |
| name       | optional  | String | Name of this probe group (max 512 chars). Meant to assist with identifying this group. |

### Returns

A probe group object.

### Errors

TODO: errors

### Example

TODO: example


## PutProbeGroup (PUT /pub/:account/probegroups/:uuid)

Update a probe group.

### Inputs

| Field      | Required? | Type   | Description                                                                            |
| ---------- | --------- | ------ | -------------------------------------------------------------------------------------- |
| user (URL) | -         | String | The user UUID (from UFDS) or username ('login' in UFDS)                                |
| contacts   | required  | Array  | An array of contact names to notify when probes in this group alarm.                   |
| name       | optional  | String | Name of this probe group (max 512 chars). Meant to assist with identifying this group. |


### Returns

The updated probe group object.

### Errors

TODO: errors

### Example

TODO: example


## DeleteProbeGroup (DELETE /pub/:account/probegroups/:uuid)

Delete a probe group.

### Inputs

None.

### Returns

No response payload, only a "204 No Content" response status.

### Errors

TODO: errors

### Example

    $ sdc-amon /pub/bob/probegroups/661b5edf-c41a-8742-b7b0-c304988a0bbe -X DELETE
    HTTP/1.1 204 No Content
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: DELETE
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Date: Fri, 20 Jul 2012 20:07:37 GMT
    Server: Amon Master/1.0.0
    X-Request-Id: dcdbf00e-40de-438f-8882-689b5bda3354
    X-Response-Time: 111



# Master API: Probes

A "probe" object is the config information that tells an amon-agent a single
thing to check or watch for. See the [Probes](#probes) section above for more
details.

In the API, a probe contains the following fields:

| Field       | Type    | Description                                                                                                                                                                                                                                                                                                               |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| uuid        | String  | The UUID of the probe.                                                                                                                                                                                                                                                                                                    |
| user        | String  | The UUID of the owning user.                                                                                                                                                                                                                                                                                              |
| name        | String  | Name of this probe. This is unique for probes on this monitor. It must be 1-512 chars, begin with alphanumeric character and include only alphanumeric, '_', '.' and '-'                                                                                                                                                  |
| type        | String  | One of the supported [probe types](#probe-types).                                                                                                                                                                                                                                                                         |
| config      | Object  | Extra configuration information for the probe, if required. This is specific to the [probe type](#probe-types). Most probe types require some config information.                                                                                                                                                         |
| agent       | String  | The UUID of the agent that will run this probe. An agent UUID is the UUID of the VM or node on which it is running. For some probe types the agent will be the same as "machine", e.g. a log-scan probe, for others it will be a separate, e.g. a ping (ICMP) probe is no use running on the same machine it is checking. |
| machine     | String  | Optional. The UUID of the VM or node being monitored, if applicable. An example where "machine" is not applicable might be an HTTP check against a hostname that handled by multiple webheads behind a load balancer.                                                                                                     |
| contacts    | Array   | Optional. Set of contact names for this probe. If the probe is a member of a group then the group's contacts take precedence.                                                                                                                                                                                             |
| group       | UUID    | Optional. UUID of a probe group to which this probe belongs, if any.                                                                                                                                                                                                                                                      |
| groupEvents | Boolean | Optional. If true, multiple events will be grouped into a single alarm whenever possible (depending on when did the last event happen). If false, there will be a new alarm for every event generated by this probe. Defaults to true.                                                                                    |


## ListProbes (GET /pub/:account/probes)

List all probes for this monitor.

### Inputs

None.

### Returns

An array of probe objects.

### Errors

TODO: errors

### Example

    $ sdc-amon /pub/bob/probes
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 281
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: GET
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Content-MD5: eN8QxNofpn4MIGFuOGiydA==
    Date: Fri, 20 Jul 2012 22:06:09 GMT
    Server: Amon Master/1.0.0
    X-Request-Id: 95b8b5bc-f2e7-4db3-a70e-ef44cb27c811
    X-Response-Time: 149

    [
      {
        "user": "a3046060-e49c-244e-a146-7a769550cbbb",
        "uuid": "660bce77-0e80-c94b-9e6d-6d07b344baef",
        "name": "whistlelog",
        "type": "log-scan",
        "agent": "729dae52-e157-4d8e-9a74-196e228caf58",
        "config": {
          "path": "/tmp/whistle.log",
          "match": {
            "pattern": "tweet"
          },
          "threshold": 1,
          "period": 60
        },
        "machine": "729dae52-e157-4d8e-9a74-196e228caf58"
      }
    ]


## GetProbe (GET /pub/:account/probes/:uuid)

Get a probe by uuid.

### Inputs

None.

### Returns

A probe object.

### Errors

TODO: errors

### Example

    $ sdc-amon /pub/bob/probes/whistlelog
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 279
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: GET
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Content-MD5: 0pIYGXJzPUibNVVpOUz99A==
    Date: Fri, 20 Jul 2012 22:43:28 GMT
    Server: Amon Master/1.0.0
    X-Request-Id: 84f665df-ab21-405b-b36d-40fbfc5cea9b
    X-Response-Time: 78

    {
      "user": "a3046060-e49c-244e-a146-7a769550cbbb",
      "uuid": "660bce77-0e80-c94b-9e6d-6d07b344baef",
      "name": "whistlelog",
      "type": "log-scan",
      "agent": "729dae52-e157-4d8e-9a74-196e228caf58",
      "config": {
        "path": "/tmp/whistle.log",
        "match": {
          "pattern": "tweet"
        },
        "threshold": 1,
        "period": 60
      },
      "machine": "729dae52-e157-4d8e-9a74-196e228caf58"
    }


## CreateProbe (POST /pub/:account/probes)

Create a probe.

### Inputs

| Field       | Required?                       | Type    | Description                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user        | required (in URL)               | String  | The user UUID (from UFDS) or username ('login' in UFDS)                                                                                                                                                                                                                                                     |
| type        | required                        | String  | One of the supported [probe types](#probe-types).                                                                                                                                                                                                                                                           |
| config      | see [Probe Types](#probe-types) | Object  | Extra configuration information for the probe, if required. This is specific to the [probe type](#probe-types). Most probe types require some config information.                                                                                                                                           |
| agent       | required                        | String  | The UUID of the agent that will run this probe. An agent uses the UUID of the VM (`zonename` in a zone, ??? in a virtual machine) or node on which it is running as its UUID.                                                                                                                               |
| machine     | optional                        | String  | The UUID of the VM or node being monitored, if applicable. For some probe types (those that must run locally), "machine" is the same value as the "agent". An example where "machine" is not applicable might be an HTTP check against a hostname that handled by multiple webheads behind a load balancer. |
| contacts    | optional                        | Array   | Set of contact names for this probe. If the probe is a member of a group then the group's contacts take precedence.                                                                                                                                                                                         |
| group       | optional                        | UUID    | UUID of a probe group to which to add this probe.                                                                                                                                                                                                                                                           |
| groupEvents | optional                        | Boolean | If true, multiple events will be grouped into a single alarm whenever possible (depending on when did the last event happen). If false, there will be a new alarm for every event generated by this probe. Defaults to true.                                                                                |
| skipauthz   | optional                        | Boolean | **Internal.** This is an admin-only option to skip PUT authorization. It is accepted only for the special system admin user. It exists to facilitate bootstrapping probe creation during SDC headnode setup when all services required for authZ may not yet be online.                                     |

### Returns

The created probe object.

### Errors

TODO: errors

### Example

TODO: example


## PutProbe (PUT /pub/:account/probes/:uuid)

Update a probe.

TODO: Clarify: Is this just diffs? Or is the whole thing required?

### Inputs

| Field       | Required? | Type                            | Description                                                                                                                                                                                                                                                                                                 |
| ----------- | --------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user (URL)  | -         | String                          | The user UUID (from UFDS) or username ('login' in UFDS)                                                                                                                                                                                                                                                     |
| uuid (URL)  | -         | UUID                            | UUID of the probe.                                                                                                                                                                                                                                                                                          |
| type        | String    | required                        | One of the supported [probe types](#probe-types).                                                                                                                                                                                                                                                           |
| config      | Object    | see [Probe Types](#probe-types) | Extra configuration information for the probe, if required. This is specific to the [probe type](#probe-types). Most probe types require some config information.                                                                                                                                           |
| agent       | String    | required                        | The UUID of the agent that will run this probe. An agent uses the UUID of the VM (`zonename` in a zone, ??? in a virtual machine) or node on which it is running as its UUID.                                                                                                                               |
| machine     | String    | optional                        | The UUID of the VM or node being monitored, if applicable. For some probe types (those that must run locally), "machine" is the same value as the "agent". An example where "machine" is not applicable might be an HTTP check against a hostname that handled by multiple webheads behind a load balancer. |
| contacts    | Array     | optional                        | Set of contact names for this probe. If the probe is a member of a group then the group's contacts take precedence.                                                                                                                                                                                         |
| group       | UUID      | optional                        | UUID of a probe group to which to add this probe.                                                                                                                                                                                                                                                           |
| groupEvents | optional  | Boolean                         | If true, multiple events will be grouped into a single alarm whenever possible (depending on when did the last event happen). If false, there will be a new alarm for every event generated by this probe. Defaults to true.                                                                                |


### Returns

The updated probe object.

### Errors

TODO: errors

### Example

TODO: example


## DeleteProbe (DELETE /pub/:account/probes/:uuid)

Delete a probe.

### Inputs

None.

### Returns

No response payload, only a "204 No Content" response status.

### Errors

TODO: errors

### Example

    $ sdc-amon /pub/bob/probes/2a90d100-1a38-9e46-b890-365cc42e6e14 -X DELETE
    HTTP/1.1 204 No Content
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: DELETE
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Date: Fri, 20 Jul 2012 22:52:09 GMT
    Server: Amon Master/1.0.0
    X-Request-Id: a775e9ae-8e73-40a8-88f2-35b39f042f24
    X-Response-Time: 120




# Master API: Alarms

An alarm is an occurence of a problem situation. Typically an alarm is
associated with a particular monitor. An alarm is opened when one of the
monitor's probes trips. Some probe types (e.g. "machine-up") support
clearing alarms automatically (e.g. when a machine being watched by a
"machine-up" probe comes back up after having been down, it will clear
the alarm for it having been down). Other alarms need to be explicitly
closed.

These APIs provide info on recent alarms for a user. Closed alarms are
only guaranteed to be persisted for a week. I.e. this is mainly about showing
open (i.e. unresolved) alarm situations.

The point of an "alarm" object is (a) to have a persistent object to show
current open alarms (e.g. for Cloud API, Operator Portal and Customer Portal);
(b) for the master to handle de-duplication, i.e. avoid a flood
of duplicate notifications for a stream of events relating to the same
problem; and (c) to support the user suppressing notifications for this
alarm ("Yah, I know it is a problem, but I can't deal with it right now.").



### Alarm Fields

| Field         | Type    | Description                                                                                                |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| user          | String  | The UUID of the user to which this alarm belongs.                                                          |
| id            | Integer | The integer ID of this alarm. Note that this is scoped on `user`.                                          |
| monitor       | String  | The name of the monitor with which this alarm is associated.                                               |
| closed        | Boolean | Whether this alarm has been closed.                                                                        |
| suppressed    | Boolean | Whether notifications for this alarm are currently suppressed.                                             |
| timeOpened    | Integer | Timestamp (milliseconds since the epoch) at which the alarm was opened.                                    |
| timeClosed    | Integer | Timestamp (milliseconds since the epoch) at which the alarm was closed or null if the alarm is not closed. |
| timeLastEvent | Integer | Timestamp (milliseconds since the epoch) at which the last event for this alarm occurred.                  |
| v             | Integer | The version of this Alarm object schema. Currently this is only exposed via the internal APIs.             |

An example alarm (TODO: update this example):

    {
      "user": "deadbeef-5555-5555-5555-555555555555",
      "id": "1",
      "monitor": "isup",
      "closed": false,
      "timeOpened": 1332870155860,
      "timeClosed": null,
      "timeLastEvent": 1332870615162,
      "numNotifications": 0,
      "v": 1
    }


## ListAllAlarms (GET /alarms)

An **internal** API for listing and searching all alarms. This is intended
for operators and development/debugging only. In a heavily loaded system care
should be taken with this endpoint to not swamp the Amon Master.

### Inputs

None.

### Errors

For all possible errors, see [Error Response](#error-responses) above.

### Returns

Returns an array of alarms (see [Alarm Fields](#alarm-fields) above).

### Example

    $ sdc-amon /alarms
    HTTP/1.1 200 OK
    ...

    [
      {
        "user": "deadbeef-5555-5555-5555-555555555555",
        "id": "1",
        "monitor": "isup",
        "closed": false,
        "timeOpened": 1332870155860,
        "timeClosed": null,
        "timeLastEvent": 1332870615162,
        "numNotifications": 0,
        "v": 1
      }
    ]


## ListAlarms (GET /pub/:account/alarms)

List a users alarms. By default this is the set of open alarms and recently
closed (in the last hour) alarms, if any. Note that old closed alarms are
automatically expunged (currently a week after being closed).

### Inputs

| Field      | Type   | Description                                                                                         |
| ---------- | ------ | --------------------------------------------------------------------------------------------------- |
| user (URL) | String | The user UUID (from UFDS) or username ('login' in UFDS)                                             |
| state      | String | One of "recent" (open and recently closed alarms, this is the default), "open", "closed" and "all". |
| probeGroup | UUID   | Only return alarms associated with this probe group.                                                |

### Errors

For all possible errors, see [Error Response](#error-responses) above.

| Error Code           | HTTP Code | Description                         |
| -------------------- | --------- | ----------------------------------- |
| InvalidArgumentError | 400       | If `state` or `monitor` is invalid. |

### Returns

Returns an array of alarms (see [Alarm Fields](#alarm-fields) above).

### Example

    $ sdc-amon /pub/bob/alarms?state=open
    HTTP/1.1 200 OK
    ...

    [
      {
        "user": "deadbeef-5555-5555-5555-555555555555",
        "id": "1",
        "monitor": "isup",
        "closed": false,
        "timeOpened": 1332870155860,
        "timeClosed": null,
        "timeLastEvent": 1332870615162,
        "numNotifications": 0,
        "v": 1
      }
    ]


## GetAlarm (GET /pub/:account/alarms/:alarm)

Get a particular alarm.

### Inputs

| Field       | Type    | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| user (URL)  | String  | The user UUID (from UFDS) or username ('login' in UFDS) |
| alarm (URL) | Integer | The alarm id for this user.                             |

### Returns

An alarm object (see [Alarm Fields](#alarm-fields) above).

### Errors

For all possible errors, see [Error Response](#error-responses) above.

| Error Code       | HTTP Code | Description                                                                      |
| ---------------- | --------- | -------------------------------------------------------------------------------- |
| ResourceNotFound | 404       | If `user` does not exist or the `alarm` id does not exist.                       |
| Gone             | 410       | If the `alarm` has been expunged. Closed alarms are expunged after about a week. |

### Example

    $ sdc-amon /pub/bob/alarms/1
    HTTP/1.1 200 OK
    ...

    {
      "user": "deadbeef-5555-5555-5555-555555555555",
      "id": "1",
      "monitor": "isup",
      "closed": false,
      "timeOpened": 1332870155860,
      "timeClosed": null,
      "timeLastEvent": 1332870615162,
      "numNotifications": 0,
      "v": 1
    }


## CloseAlarm (POST /pub/:account/alarms/:alarm?action=close)

Close the given alarm.

### Inputs

| Field       | Type    | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| user (URL)  | String  | The user UUID (from UFDS) or username ('login' in UFDS) |
| alarm (URL) | Integer | The alarm id for this user.                             |
| action      | String  | "close". See other "*Alarm*" actions in this section.   |

### Returns

Nothing. Responds with an HTTP 202 (Accepted) on success.

### Errors

For all possible errors, see [Error Response](#error-responses) above.

| Error Code       | HTTP Code | Description                                                                      |
| ---------------- | --------- | -------------------------------------------------------------------------------- |
| ResourceNotFound | 404       | If `user` does not exist or the `alarm` id does not exist.                       |
| Gone             | 410       | If the `alarm` has been expunged. Closed alarms are expunged after about a week. |

### Example

    $ sdc-amon /pub/bob/alarms/123?action=close -X POST
    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Server: Amon Master/1.0.0
    X-Request-Id: e16b7aab-b8b8-4a8a-97f2-9216dd0e5798
    Access-Control-Allow-Methods: POST
    Connection: close
    Content-Length: 0
    Date: Mon, 02 Apr 2012 17:15:52 GMT
    X-Response-Time: 3



## ReopenAlarm (POST /pub/:account/alarms/:alarm?action=reopen)

Re-open the given alarm. This exists mainly to provide an "undo" for an
accidental "close" action.

### Inputs

| Field       | Type    | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| user (URL)  | String  | The user UUID (from UFDS) or username ('login' in UFDS) |
| alarm (URL) | Integer | The alarm id for this user.                             |
| action      | String  | "reopen". See other "*Alarm*" actions in this section.  |

### Returns

Nothing. Responds with an HTTP 202 (Accepted) on success.

### Errors

For all possible errors, see [Error Response](#error-responses) above.

| Error Code       | HTTP Code | Description                                                                      |
| ---------------- | --------- | -------------------------------------------------------------------------------- |
| ResourceNotFound | 404       | If `user` does not exist or the `alarm` id does not exist.                       |
| Gone             | 410       | If the `alarm` has been expunged. Closed alarms are expunged after about a week. |

### Example

    $ sdc-amon /pub/bob/alarms/123?action=reopen -X POST
    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Server: Amon Master/1.0.0
    X-Request-Id: e16b7aab-b8b8-4a8a-97f2-9216dd0e5798
    Access-Control-Allow-Methods: POST
    Connection: close
    Content-Length: 0
    Date: Mon, 02 Apr 2012 17:15:52 GMT
    X-Response-Time: 3



## SuppressAlarmNotifications (POST /pub/:account/alarms/:alarm?action=suppress)

Suppress notifications for events on the given alarm.

### Inputs

| Field       | Type    | Description                                              |
| ----------- | ------- | -------------------------------------------------------- |
| user (URL)  | String  | The user UUID (from UFDS) or username ('login' in UFDS)  |
| alarm (URL) | Integer | The alarm id for this user.                              |
| action      | String  | "suppress". See other "*Alarm*" actions in this section. |

### Returns

Nothing. Responds with an HTTP 202 (Accepted) on success.

### Errors

For all possible errors, see [Error Response](#error-responses) above.

| Error Code       | HTTP Code | Description                                                                      |
| ---------------- | --------- | -------------------------------------------------------------------------------- |
| ResourceNotFound | 404       | If `user` does not exist or the `alarm` id does not exist.                       |
| Gone             | 410       | If the `alarm` has been expunged. Closed alarms are expunged after about a week. |

### Example

    $ sdc-amon /pub/bob/alarms/123?action=suppress -X POST
    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Server: Amon Master/1.0.0
    X-Request-Id: e16b7aab-b8b8-4a8a-97f2-9216dd0e5798
    Access-Control-Allow-Methods: POST
    Connection: close
    Content-Length: 0
    Date: Mon, 02 Apr 2012 17:15:52 GMT
    X-Response-Time: 3



## UnsuppressAlarmNotifications (POST /pub/:account/alarms/:alarm?action=unsuppress)

Stop suppression of notifications on the given alarm.

### Inputs

| Field       | Type    | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| user (URL)  | String  | The user UUID (from UFDS) or username ('login' in UFDS) |
| alarm (URL) | Integer | The alarm id for this user.                             |
| action      | String  | "close". See other "*Alarm*" actions in this section.   |

### Returns

Nothing. Responds with an HTTP 202 (Accepted) on success.

### Errors

For all possible errors, see [Error Response](#error-responses) above.

| Error Code       | HTTP Code | Description                                                                      |
| ---------------- | --------- | -------------------------------------------------------------------------------- |
| ResourceNotFound | 404       | If `user` does not exist or the `alarm` id does not exist.                       |
| Gone             | 410       | If the `alarm` has been expunged. Closed alarms are expunged after about a week. |

### Example

    $ sdc-amon /pub/bob/alarms/123?action=unsuppress -X POST
    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Server: Amon Master/1.0.0
    X-Request-Id: e16b7aab-b8b8-4a8a-97f2-9216dd0e5798
    Access-Control-Allow-Methods: POST
    Connection: close
    Content-Length: 0
    Date: Mon, 02 Apr 2012 17:15:52 GMT
    X-Response-Time: 3


## DeleteAlarm (DELETE /pub/:account/alarms/:alarm)

Delete the given alarm. This is more severe than [*closing* an
alarm](#CloseAlarm) and typically should not be something a user is doing.
At least for first blush I'd suggest *not* exposing this to the user.


### Inputs

| Field       | Type    | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| user (URL)  | String  | The user UUID (from UFDS) or username ('login' in UFDS) |
| alarm (URL) | Integer | The alarm id for this user.                             |

### Returns

Nothing. Responds with an HTTP 204 (Accepted) on success.

### Errors

For all possible errors, see [Error Response](#error-responses) above.

| Error Code       | HTTP Code | Description                                                |
| ---------------- | --------- | ---------------------------------------------------------- |
| ResourceNotFound | 404       | If `user` does not exist or the `alarm` id does not exist. |

### Example

    $ sdc-amon /pub/bob/alarms/123 -X DELETE
    HTTP/1.1 204 No Content
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Server: Amon Master/1.0.0
    X-Request-Id: 727e929a-d735-c748-96ae-5e2762764531
    Access-Control-Allow-Methods: DELETE
    Connection: close
    Content-Length: 0
    Date: Mon, 02 Apr 2012 17:15:52 GMT
    X-Response-Time: 3



# Master API: Maintenance Windows

On can set maintenance windows on monitors (or on machines) to temporarily
suppress notifications for probe failures.

### Maintenance Window Fields

| Field    | Type      | Description                                                              |
| -------- | --------- | ------------------------------------------------------------------------ |
| user     | UUID      | The UUID of the user to which the maintenance window belongs.            |
| id       | Integer   | A unique (to this user) integer id for this maintenance window.          |
| start    | timestamp | A timestamp at which this maintenance window starts.                     |
| end      | timestamp | A timestamp at which this maintenance window ends.                       |
| notes    | String    | The given "notes". This key is excluded if there are no notes.           |
| all      | Boolean   | "true", if this maintenance window applies to all monitors.              |
| monitors | Array     | Array of monitor names to which this maintenance window applies, if any. |
| machines | Array     | Array of machine UUIDs to which this maintenance window applies, if any. |

Only one of `all`, `monitors`, `machines` will exist.

An example maintenance window (TODO):



## ListAllMaintenanceWindows (GET /maintenances)

An **internal** API for listing and searching all maintenance windows. This
is intended for operators and development/debugging only. In a heavily loaded
system care should be taken with this endpoint to not swamp the Amon Master.

### Inputs

None.

### Errors

For all possible errors, see [Error Response](#error-responses) above.

### Returns

Returns an array of maintenance windows (see
[Maintenance Window Fields](#maintenance-window-fields) above).

### Example

TODO: example


## ListMaintenanceWindows (GET /pub/:account/maintenances)

TODO: doc endpoint


## GetMaintenanceWindow (POST /pub/:account/maintenances/:maintenance)

TODO: doc endpoint


## CreateMaintenanceWindow (POST /pub/:account/maintenances)

Create a maintenance window.

### Inputs

| Parameter  | Required? | Default | Description                                                                                                                          |
| ---------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| user (URL) | Required  | -       | The user UUID (from UFDS) or username ('login' in UFDS)                                                                              |
| start      | Required  | -       | The time at which the maintenance window starts. RFC date, timestamp, or "now".                                                      |
| end        | Required  | -       | The time at which the maintenance window ends. RFC date, timestamp, or `<digit>[mhd]` (minute, hour, day). E.g.: "1d" means one day. |
| notes      | Optional  | -       | Short notes on why this maintenance window.                                                                                          |
| all        | Optional  | -       | A boolean. Set to "true" to indicate that the maintenance window should apply to all monitors. See *Note 1*.                         |
| monitors   | Optional  | -       | A comma-separated list of monitor names to which the maintenance window applies. See *Note 1*.                                       |
| machines   | Optional  | -       | A comma-separated list of machine UUIDs to which the maintenance window applies. See *Note 1*.                                       |

*Note 1*: One of `all`, `monitors` or `machines` must be supplied.

### Returns

Returns a maintenance window object (see
[Maintenance Window Fields](#maintenance-window-fields) above).

### Errors

For all possible errors, see [Error Response](#error-responses) above.

### Example

TODO: example

    $ sdc-amon /pub/bob/maintenance -X POST -d start=now -d end=1d \
        -d monitors=mymonitor


## DeleteMaintenanceWindow (DELETE /pub/:account/maintenances/:maintenance)

TODO: doc endpoint



# Master API: Miscellaneous

## Ping (GET /ping)

A simple ping to check to health of the Amon server. Here "pid" is the PID of
the Amon master server process. This is helpful for the test suite.

### Inputs

| Field   | Type   | Description                                                                                 |
| ------- | ------ | ------------------------------------------------------------------------------------------- |
| error   | String | Optional. An error code name, e.g. "ResourceNotFound" to simulate an error response.        |
| message | String | Optional. The error message to include in the simulated error response. Defaults to "pong". |

### Returns

When not simulating an error response, a "pong" object is returned:

| Field | Type   | Description                     |
| ----- | ------ | ------------------------------- |
| ping  | String | "pong"                          |
| pid   | String | The PID of Amon Master process. |

When simulating an error, the HTTP response code depends on the error type
and the response body is an JSON object with:

| Field   | Type   | Description        |
| ------- | ------ | ------------------ |
| code    | String | Error code string. |
| message | String | Error message.     |

### Examples

    $ sdc-amon /ping
    HTTP/1.1 200 OK
    Connection: close
    Date: Wed, 02 Nov 2011 04:40:42 GMT
    Server: Amon Master/1.0.0
    X-Api-Version: 1.0.0
    X-Request-Id: 265a6379-bbf5-4d86-bd11-5e96614035d8
    X-Response-Time: 2
    Content-Length: 15
    Content-MD5: tBwJDpsyo/hcYx2xrziwrw==
    Content-Type: application/json
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: OPTIONS, GET
    Access-Control-Allow-Headers: Accept, Content-Type, Content-Length, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time

    {
      "ping": "pong"
      "pid": 1234
    }

Ping can also be used to simulate error responses from Amon master:

    $ sdc-amon /ping?error=ResourceNotFound\&message=nada
    HTTP/1.1 404 Not Found
    Connection: close
    Date: Tue, 06 Dec 2011 23:43:03 GMT
    Server: Amon Master/1.0.0
    X-Api-Version: 1.0.0
    X-Request-Id: 849950cf-e9de-452b-9640-6f4c7da053e2
    X-Response-Time: 2
    Content-Length: 44
    Content-MD5: /vxoedHxPf+L11uaQ8bkJQ==
    Content-Type: application/json
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Methods: OPTIONS, GET
    Access-Control-Allow-Headers: Accept, Content-Type, Content-Length, Date, X-Api-Version
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time

    {
      "code": "ResourceNotFound",
      "message": "nada"
    }



## GetUser (GET /pub/:account)

Get information for the given user. This is not an essential part of
the API, **should NOT be exposed publicly (obviously)**, and can be removed
if not useful.

### Inputs

| Field      | Type   | Description            |
| ---------- | ------ | ---------------------- |
| user (URL) | String | The user UUID or login |

### Example

    $ sdc-amon /pub/7b23ae63-37c9-420e-bb88-8d4bf5e30455
    HTTP/1.1 200 OK
    ...

    {
      "login": "hamish",
      "email": "hamish@joyent.com",
      "uuid": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
      "cn": "Hamish",
      "sn": "MacHamish",
      ...
    }


## GetState (GET /state)

Return internal state. **Note:** eventually this will probably migrate to
[Kang](https://github.com/davepacheco/kang).

### Inputs

None.

### Example

    $ sdc-amon /state
    HTTP/1.1 200 OK
    ...

    {
      "cache": {
        "user": {
          "name": "user",
          "expiry": 300000,
    ...


## DropCaches (POST /state?action=dropcaches)

Drop in-process caches. This is important for running the test suite against
a live Amon Master as a pre-existing cache can influence some of the test
cases.

### Inputs

| Field  | Type   | Description  |
| ------ | ------ | ------------ |
| action | String | "dropcaches" |

### Example

    $ sdc-amon /state?dropcaches -X POST
    HTTP/1.1 202 Accepted
    ...



# Relay API

Amon employs a layer of relay servers for (a) ferrying agent probe data
from the master to the agents and (b) ferrying events from agents back to
the master. This is done via the Relay API. The Amon Master also implements
this API.

Dev Note: The module "common/lib/relay-client.js" is used by both amon-relay
and amon-agent to speak the Relay API. In production usage the relays
speak to the master over a network socket and agents speak to their relay
over a Unix domain socket (zsocket).


## AddEvents (POST /events)

Sends one or more events up to a relay (or the Amon master). Agents run
the given probes and send an event when a probe test trips/fails.

### Inputs

The body is an array of event objects. Currently it also accepts a single
event object. See the [Events](#events) section below for details on event
objects.

### Errors

TODO: errors

### Example

    $ sdc-amon /events -X POST -d '{
    >   "v": 1,
    >   "type": "probe",
    >   "user": "a3040770-c93b-6b41-90e9-48d3142263cf",
    >   "probeUuid": "13512302-14d8-e64a-8a63-c8792fff1e9e",
    >   "clear": true,
    >   "data": {
    >     "message": "Machine \"b662dd76-974d-4ab8-92c2-fd9d01d86fd3\" has come up.",
    >     "value": null,
    >     "details": {
    >       "machine": "b662dd76-974d-4ab8-92c2-fd9d01d86fd3"
    >     }
    >   },
    >   "agent": "b662dd76-974d-4ab8-92c2-fd9d01d86fd3"
    > }'
    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: POST
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Date: Tue, 24 Jul 2012 20:36:50 GMT
    Server: Amon Master/1.0.0
    X-Request-Id: d23d2b65-f5a3-4054-ae77-53aee1917922
    X-Response-Time: 86
    Transfer-Encoding: chunked



## ListAgentProbes (GET /agentprobes)

Amon Relays periodically get agent control data (probes to run on a
particular agent) from the master. From there, agents poll their relay for
this control data.

Note: The returned probes are sorted to ensure a stable order and hence a
stable "Content-MD5" header to use for caching.

### Inputs

| Parameter | Required? | Default | Description                                                                                                                           |
| --------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| agent     | Required  | -       | The agent UUID. Note that the agent UUID is that of the machine -- VM, SmartMachine (aka zone), or physical node -- on which is runs. |

Note: The `agent` parameter is required when calling this endpoint on an
Amon Master. However, when an amon-agent calls this endpoint on an amon-relay,
the parameter is ignored because there is a 1-to-1 mapping of Relay API
server instance to amon-agent.

### Returns

An array of probe objects. See [Probes API](#master-api-probes) section above
for the fields in a probe object. This internal API includes an additional
field on each probe object:

| Field       | Type    | Description                                                                                                                                                                                                   |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runInVmHost | Boolean | This is 'true' if the probe is a type that must run in the VM *host* for a VM. An example is the 'machine-up' probe type, which tracks vm/zone state by watching kernel sysevent events from the global zone. |

### Errors

TODO: errors

### Example

    $ sdc-amon /agentprobes?agent=44454c4c-3200-1042-804d-c2c04f575231
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 314
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: GET
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Content-MD5: A2cFv/vNjAJEauSHQOzCtg==
    Date: Tue, 24 Jul 2012 17:50:58 GMT
    Server: Amon Master/1.0.0
    X-Request-Id: 87a5dcbb-eb5d-454f-8510-59917dc04ac1
    X-Response-Time: 73

    [
      {
        "user": "a3040770-c93b-6b41-90e9-48d3142263cf",
        "monitor": "gz",
        "name": "smartlogin",
        "type": "log-scan",
        "agent": "44454c4c-3200-1042-804d-c2c04f575231",
        "config": {
          "path": "/var/svc/log/smartdc-agent-smartlogin:default.log",
          "match": {
            "pattern": "Stopping"
          },
          "threshold": 1,
          "period": 120
        },
        "machine": "44454c4c-3200-1042-804d-c2c04f575231"
      }
    ]


## HeadAgentProbes (HEAD /agentprobes)

This "HEAD" form of `ListAgentProbes` allows for relays and agents to check
for agent control data changes with less network overhead. The Relays and
Masters expect that call pattern to be a check to HeadAgentProbes and
only to ListAgentProbes if there is a change in `Content-MD5`. This way
caching on the server can be on the (smaller) `Content-MD5`.

### Inputs

| Parameter | Required? | Default | Description                                                                                                                           |
| --------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| agent     | Required  | -       | The agent UUID. Note that the agent UUID is that of the machine -- VM, SmartMachine (aka zone), or physical node -- on which is runs. |

### Errors

TODO: errors



# Relay Admin API

An amon-relay runs a local-IP-only HTTP admin server (port 4307) for local
debugging, status and test support.

## RelayAdminPing (GET /ping)

A simple ping to see if the relay is up.

### Inputs

None.

### Returns

    {"ping": "pong"}

### Errors

None.

### Example

    $ curl -i localhost:4307/ping
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 15
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: GET
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Content-MD5: tBwJDpsyo/hcYx2xrziwrw==
    Date: Fri, 22 Jun 2012 22:44:52 GMT
    Server: Amon Relay Admin
    X-Request-Id: 93f5241b-a18f-48d9-8433-34858eaaf626
    X-Response-Time: 1

    {"ping":"pong"}


## RelayAdminSyncProbes (POST /state?action=syncprobes)

Immediately update agentprobes data from the Amon master.

### Inputs

| Field  | Type   | Description  |
| ------ | ------ | ------------ |
| action | String | "syncprobes" |

### Returns

Nothing. Just a 202 status and headers.

### Errors

None.

### Example

    $ curl -i localhost:4307/state?action=syncprobes -X POST
    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: POST
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Date: Fri, 22 Jun 2012 22:41:37 GMT
    Server: Amon Relay Admin
    X-Request-Id: b86337fa-9723-4f80-b6b8-976c5969bffd
    X-Response-Time: 19
    Transfer-Encoding: chunked


## RelayAdminLogLevel (POST /state?action=loglevel)

Set the logging level for the amon-relay.

### Inputs

| Field  | Type   | Description                                                                                                           |
| ------ | ------ | --------------------------------------------------------------------------------------------------------------------- |
| action | String | "loglevel"                                                                                                            |
| level  | String | One of the [Bunyan supported log level strings](https://github.com/trentm/node-bunyan#levels), e.g. "debug", "trace". |

### Returns

Nothing. Just a 202 status and headers.

### Errors

None.

### Example

    $ curl -i localhost:4307/state?action=loglevel\&level=trace -X POST
    HTTP/1.1 202 Accepted
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Headers: Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version
    Access-Control-Allow-Methods: POST
    Access-Control-Expose-Headers: X-Api-Version, X-Request-Id, X-Response-Time
    Connection: Keep-Alive
    Date: Fri, 22 Jun 2012 22:41:37 GMT
    Server: Amon Relay Admin
    X-Request-Id: 5eb300a2-b5b7-4c49-b978-0b05795a3b1e
    X-Response-Time: 19
    Transfer-Encoding: chunked



# Probe Types

A probe must be one of the types described in this section. See
[PutProbe](#PutProbe) above for how to add a probe. The "config" field is
specific to the probe type. Those are specified here.

Some aggregated data on the probe types:

| Type             | Requires Agent | Sends Clear Events | Description                                                                  |
| ---------------- | -------------- | ------------------ | ---------------------------------------------------------------------------- |
| machine-up       | no             | yes                | watch for a vm going down (shutdown, reboot)                                 |
| log-scan         | yes            | no                 | watch for a pattern in a log file                                            |
| bunyan-log-scan  | yes            | no                 | watch for a pattern or field matches in a Bunyan log file                    |
| http             | yes            | no                 | hit an HTTP(S) endpoint and assert a status, body match, response time, etc. |
| icmp (i.e. ping) | yes            | no                 | ping a host and assert a response time, etc.                                 |
| cmd              | yes            | no                 | run a command and assert an exit status, stdout match                        |
| disk-usage       | yes            | yes                | checks that free space on a mountpoint doesn't drop below a threshold        |

"Requires Agent" means that a probe of this type needs an amon-agent running
in the customer vm/zone to run the probe. "machine-up" is the exception here,
it is run "by the system".


## Probe: log-scan

Watch (tail -f) a log file for a particular pattern (regular expression).
This probe type requires an amon-agent running inside the target VM (i.e.
the VM with the UUID of the "agent" field).

### Config

| Parameter       | Required?    | Default | Description                                                                                                                                                                                                                                                                    |
| --------------- | ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| path            | Required(\*) | -       | Path to the log file to watch. One of "path" or "smfServiceName" must be provided.                                                                                                                                                                                             |
| smfServiceName  | Required(\*) | -       | The name of an SMF service to watch. SMF is a SmartOS/illumos service management framework. `svcs -L $name` is used to get the service's log path to watch. One of "path" or "smfServiceName" must be provided.                                                                |
| match           | Required     | -       | Match data to match against log content.                                                                                                                                                                                                                                       |
| match.pattern   | Required     | -       | The pattern with which to match.                                                                                                                                                                                                                                               |
| match.type      | Optional     | regex   | One of 'substring' or 'regex'. Defines the type of 'match.pattern'.                                                                                                                                                                                                            |
| match.flags     | Optional     | -       | Pattern flags. 'i' to ignore case. 'm' for multiline match (i.e. '^' and '$' match the start and end of lines within a multiline string). Note that matching is not always on a single line, so if your regular expression pattern uses '^' or '$' you will want the 'm' flag. |
| match.matchWord | Optional     | false   | A boolean indicating if matching should be restricted to word boundaries.                                                                                                                                                                                                      |
| match.invert    | Optional     | false   | Set to true to invert the sense of matching (i.e. alarm on log lines that do NOT match).                                                                                                                                                                                       |
| period          | Optional     | 60      | Integer number of seconds. Time window in which `threshold` number of matches must be found to alarm.                                                                                                                                                                          |
| threshold       | Optional     | 1       | Integer. Number of times a match must be found within `period` to alarm.                                                                                                                                                                                                       |

### Examples

    $ sdc-amon /pub/bob/probes -X POST -d '{
        "type": "log-scan",
        "name": "my service log error",
        "agent": "444d70d5-0187-e5d4-468f-7b49a6b014ff",
        "config": {
            "path": "/var/log/myservice.log",
            "match": {
              "pattern": "ERROR"
            },
            "threshold": 1,
            "period": 60
        }
    }'

    $ sdc-amon /pub/bob/probes -X PUT -d '{
        "type": "log-scan",
        "name": "foo svc error",
        "agent": "444d70d5-0187-e5d4-468f-7b49a6b014ff",
        "config": {
            "smfServiceName": "foo",
            "match": {
              "pattern": "ERROR"
            },
            "threshold": 1,
            "period": 60
        }
    }'



## Probe: bunyan-log-scan

Watch (a la `tail -f`) a log file in the
[Bunyan](https://github.com/trentm/node-bunyan) format. This is an extension
of the "log-scan" probe type to allows some conveniences for Bunyan-format
logs. This probe type requires an amon-agent running inside the target VM
(i.e. the VM with the UUID of the "agent" field).


### Config

The bolded parameters below are those that differ from the "log-scan"
probe type.


| Parameter       | Required?    | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path            | Required(\*) | -       | Path to the log file to watch. One of "path" or "smfServiceName" must be provided.                                                                                                                                                                                                                                                                                                                                                     |
| smfServiceName  | Required(\*) | -       | The name of an SMF service to watch. SMF is a SmartOS/illumos service management framework. `svcs -L $name` is used to get the service's log path to watch. One of "path" or "smfServiceName" must be provided.                                                                                                                                                                                                                        |
| **fields**      | Required(\*) | -       | A set of key/value pairs to compare against each JSON log record. Each field is compared for equality. The "level" field is special in that you can specify a Bunyan log level name (e.g. "error") instead of the Bunyan level *integers* (e.g. 50) used in the log records. Deeper objects can be specified with a "foo.bar.blah" lookup format, e.g. `"fields": {"foo.bar": true}`. At least one of "fields" or "match" is required. |
| match           | Required(\*) | -       | Match data to match against log content. At least one of "fields" or "match" is required.                                                                                                                                                                                                                                                                                                                                              |
| match.pattern   | Required     | -       | The pattern with which to match. If a "match" is given, then this is required.                                                                                                                                                                                                                                                                                                                                                         |
| match.type      | Optional     | regex   | One of 'substring' or 'regex'. Defines the type of 'match.pattern'.                                                                                                                                                                                                                                                                                                                                                                    |
| match.flags     | Optional     | -       | Pattern flags. 'i' to ignore case. 'm' for multiline match (i.e. '^' and '$' match the start and end of lines within a multiline string). Note that matching is not always on a single line, so if your regular expression pattern uses '^' or '$' you will want the 'm' flag.                                                                                                                                                         |
| match.matchWord | Optional     | false   | A boolean indicating if matching should be restricted to word boundaries.                                                                                                                                                                                                                                                                                                                                                              |
| match.invert    | Optional     | false   | Set to true to invert the sense of matching (i.e. alarm on log lines that do NOT match).                                                                                                                                                                                                                                                                                                                                               |
| **match.field** | Optional     | -       | Limit the match to the given log record field. E.g., use `field: "msg"` to limit to just the Bunyan log record *message*.                                                                                                                                                                                                                                                                                                              |
| period          | Optional     | 60      | Integer number of seconds. Time window in which `threshold` number of matches must be found to alarm.                                                                                                                                                                                                                                                                                                                                  |
| threshold       | Optional     | 1       | Integer. Number of times a match must be found within `period` to alarm.                                                                                                                                                                                                                                                                                                                                                               |

### Examples

    # Look for a log.error with component="memory".
    $ sdc-amon /pub/bob/probes -X POST -d '{
        "name": "my api memory error",
        "type": "bunyan-log-scan",
        "agent": "444d70d5-0187-e5d4-468f-7b49a6b014ff",
        "config": {
            "smfServiceName": "elvisapi",
            "fields": {
              "level": "error",    # special case, can use the bunyan level names
              "component": "memory",
              # ... any key/value equality
            },
            # Can still do a basic match (a la log-scan probe type).
            # However, can limit the match to a field. E.g. here we
            # alarm on a match of 'exceeded' in the 'msg' log record
            # field.
            "match": {
              "pattern": "exceeded",
              "field": "msg"
            }
        }
    }'

## Probe: machine-up

Watch for a VM (i.e. a virtual machine or zone) going up or down. Alarms for
this probe will "clear", i.e. an alarm created for a machine going down
will be automatically closed by the event sent when the machine comes back
up.

"machine-up" is an exceptional probe type in that it is executed by the
system. A customer zone does not require an amon-agent running to handle
running these probes. A minor confusion here is that the given "agent" UUID
identifies the VM/machine to watch, but ultimately is not the amon-agent
that ends up running the probe. (Dev Note: These probes are actually
run by the amon-agent running in the VM *host* for a given VM.)

### Config

None.

### Example

    $ sdc-amon /pub/bob/monitors/mymonitor/probes/mywebhead -X PUT --data '{
        "type": "machine-up",
        "agent": "a5134e62-1bed-5e48-a760-7b9b79aef729"
    }'


## Probe: http

Watches a HTTP(S) URL for response status, response body matches, response
time, etc. This probe type requires an amon-agent running inside the target
VM (i.e. the VM with the UUID of the "agent" field).

### Config

| Parameter           | Required? | Default           | Description                                                                                                                                                                                                                                                                    |
| ------------------- | --------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| url                 | Required  | -                 | URL to probe, this url must be accessable from the machine or server running the probe                                                                                                                                                                                         |
| method              | Optional  | GET               | Curently Supports GET (default) or POST                                                                                                                                                                                                                                        |
| headers             | Optional  | -                 | Additional headers to include with request (an object)                                                                                                                                                                                                                         |
| body                | Optional  | -                 | string of form data (TODO: example, kevin might drop this)                                                                                                                                                                                                                     |
| username            | Optional  | -                 | Username used for HTTP Basic Auth                                                                                                                                                                                                                                              |
| password            | Optional  | -                 | Password used for HTTP Basic Auth                                                                                                                                                                                                                                              |
| interval            | Optional  | 90                | interval in seconds to check the specified URL                                                                                                                                                                                                                                 |
| period              | Optional  | 300               | Integer number of seconds. Time window in which `threshold` number of matches must be found to alarm.                                                                                                                                                                          |
| threshold           | Optional  | 1                 | Integer. Number of times a match must be found within `period` to alarm.                                                                                                                                                                                                       |
| maxResponseTime     | Optional  | -                 | When response time (ms) exceeds `maxResponseTime`, an event will fire                                                                                                                                                                                                          |
| timeout             | Optional  | 30                | Maximum time in seconds that you allow the connection to the server to take.                                                                                                                                                                                                   |
| bodyMatch           | Optional  | -                 | Match data to match against the response body. A given bodyMatch means that this probe will fire if the response body does **not** match the given pattern. See `bodyMatch.invert` to change that sense.                                                                       |
| bodyMatch.pattern   | Optional  | -                 | The pattern with which to match.                                                                                                                                                                                                                                               |
| bodyMatch.type      | Optional  | regex             | One of 'substring' or 'regex'. Defines the type of 'match.pattern'.                                                                                                                                                                                                            |
| bodyMatch.flags     | Optional  | -                 | Pattern flags. 'i' to ignore case. 'm' for multiline match (i.e. '^' and '$' match the start and end of lines within a multiline string). Note that matching is not always on a single line, so if your regular expression pattern uses '^' or '$' you will want the 'm' flag. |
| bodyMatch.matchWord | Optional  | false             | A boolean indicating if matching should be restricted to word boundaries.                                                                                                                                                                                                      |
| bodyMatch.invert    | Optional  | false             | Set to true to invert the sense of matching (i.e. alarm if the body does NOT match).                                                                                                                                                                                           |
| statusCodes         | Optional  | [200,201,202,204] | an array of status codes to be compared to the response, if statusCodes does not contain include the response status code form the request, then an alarm is fired                                                                                                             |

### Example

Watches http://google.com/ home page and fire when a non 2xx status code is returned

    $ sdc-amon /pub/bob/monitors/mymonitor/probes/googleprobe -X PUT --data '{
        "type": "http",
        "agent": "a5134e62-1bed-5e48-a760-7b9b79aef729",
        "config":{
          "url":"http://google.com/"
        }
    }'


## Probe: icmp

Performs an ICMP ping to a specific host and alarms when there are signs of
packet loss.
This probe type requires an amon-agent running inside the target VM (i.e.
the VM with the UUID of the "agent" field).

### Config

| Parameter | Required? | Default | Description                                                                                           |
| --------- | --------- | ------- | ----------------------------------------------------------------------------------------------------- |
| host      | Required  | -       | the host to check, ie `4.2.2.1`, or `example.com`                                                     |
| npackets  | Optional  | 5       | number of packets to send per check                                                                   |
| interval  | Optional  | 90      | interval in seconds to check the specified host                                                       |
| period    | Optional  | 300     | Integer number of seconds. Time window in which `threshold` number of matches must be found to alarm. |
| threshold | Optional  | 1       | Integer. Number of times packet loss is encountered within `period` before alarming                   |

### Example

Ping api.us-west.joyent.com periodically and alarm in case of network
interuptions or packet loss.

    sdc-amon /pub/admin/monitors/ping/probes/ping -X PUT --data '
    {
      "type":"icmp",
      "agent":"564da583-a93e-7fe7-5d61-5c3190ba44fb",
      "config": {
        "host":"api.us-west.joyent.com"
      }
    }'

## Probe: cmd

Periodically run a command and assert an exit status, or stdout content,
etc. This probe type requires an amon-agent running inside the target VM
(i.e. the VM with the UUID of the "agent" field).

### Config

| Parameter             | Required?     | Default | Description                                                                                                                                                                                                                                                                    |
| --------------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cmd                   | Required      | -       | The command to run.                                                                                                                                                                                                                                                            |
| cwd                   | Optional      | -       | Current working directory in which to run the command.                                                                                                                                                                                                                         |
| env                   | Optional      | -       | Object of key/value pairs to set in the environment of the cmd.                                                                                                                                                                                                                |
| encoding              | Optional      | utf-8   | Encoding of stdout/stderr content from the command.                                                                                                                                                                                                                            |
| ignoreExitStatus      | Optional      | false   | By default the exit status is checked (non-zero means a failure). Set this to true to ignore the exit status (including that from a timeout).                                                                                                                                  |
| stdoutMatch           | Optional      | -       | Data to match against stdout content. Alarm if a match is found in stdout.                                                                                                                                                                                                     |
| stdoutMatch.pattern   | Required (\*) | -       | The pattern with which to match. This is required only if `stdoutMatch` is used at all.                                                                                                                                                                                        |
| stdoutMatch.type      | Optional      | regex   | One of 'substring' or 'regex'. Defines the type of 'stdoutMatch.pattern'.                                                                                                                                                                                                      |
| stdoutMatch.flags     | Optional      | -       | Pattern flags. 'i' to ignore case. 'm' for multiline match (i.e. '^' and '$' match the start and end of lines within a multiline string). Note that matching is not always on a single line, so if your regular expression pattern uses '^' or '$' you will want the 'm' flag. |
| stdoutMatch.matchWord | Optional      | false   | A boolean indicating if matching should be restricted to word boundaries.                                                                                                                                                                                                      |
| stdoutMatch.invert    | Optional      | false   | Set to true to invert the sense of matching (i.e. alarm on stdout NOT including the given pattern)                                                                                                                                                                             |
| stderrMatch           | Optional      | -       | Data to match against stdout content. Alarm if a match is found in stdout.                                                                                                                                                                                                     |
| stderrMatch.*         | -             | -       | All options as per `stdoutMatch.*`.                                                                                                                                                                                                                                            |
| timeout               | Optional      | 5       | Time (in seconds) after which to kill the probe command. Timing out will result in an alarm.                                                                                                                                                                                   |
| interval              | Optional      | 90      | Time in seconds between checks (i.e. running the command and asserting exit status or match).                                                                                                                                                                                  |
| period                | Optional      | 300     | Time window (in seconds) in which `threshold` number of checks must fail to alarm.                                                                                                                                                                                             |
| threshold             | Optional      | 1       | Number of check failures within `period` before alarming. With the default `1`, every check failure will result in an alarm being raised.                                                                                                                                      |

TODO: consider the ability for clearing alarms via a passing cmd.

TODO: consider longer multiline scripts. Using same 'cmd' field or 'script'?


### Examples

    # The 'test !' inverts the exit status to get non-zero on failure.
    $ sdc-amon /pub/bob/probes -X POST -d '{
        "type": "cmd",
        "name": "/opt out of space",
        "agent": "444d70d5-0187-e5d4-468f-7b49a6b014ff",
        "config": {
            "cmd": "test ! $(df -k /opt | tail -1 | awk '{print $5}' | cut -d% -f1) -gt 90"
        }
    }'


## Probe: disk-usage

Regularly checks the free space left on a mountpoint, and alarms when a threshold
is passed.  This probe type requires an amon-agent running inside the target VM
(i.e. the VM with the UUID of the "agent" field).

### Config

| Parameter | Required? | Default | Description                                               |
| --------- | --------- | ------- | --------------------------------------------------------- |
| path      | Required  | -       | the mountpoint path to check                              |
| threshold | Optional  | 20%     | alarm after free space in dataset drops below this amount |
| interval  | Optional  | 3600    | interval in seconds to check the specified dataset        |

`interval` cannot be lower than 300 (five minutes). It's recommended you leave it at least
at 3600 (one hour) since checks can sometimes be expensive. `threshold` can either be a
percentage (e.g. '10%'), or an absolute number in MiB (e.g. '2000M').

### Example

Check / every six hours, and alarm if free space drops below 10GiB.


    sdc-amon /pub/admin/probes -iX POST --data '
    {
      "data dataset running low",
      "type": "disk-usage",
      "agent": "f89c347a-e65a-4953-b7dd-6d1857e9bc60",
      "config": {
        "path": "/",
        "threshold": "10240M",
        "interval": 21600
      }
    }'


# Master Configuration

Reference docs on configuration vars to amon-master. Default values are in
"master/factory-settings.json". Custom values are provided in a JSON file
passed in with the "-f CONFIG-FILE-PATH" command-line option.

Note that given custom values override full top-level keys in the factory
settings. For example: if providing 'userCache', one must provide the
whole userCache object.

| Var                          | Type             | Default   | Description                                                                                                                                    |
| ---------------------------- | ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| port                         | Number           | 8080      | Port number on which to listen.                                                                                                                |
| logLevel                     | String or Number | info      | A bunyan log level. Note that the '-v' CLI option can also set the log level. If '-v' is used, then this config var is ignored.                |
| adminUuid                    | UUID             | -         | The UUID of the admin user in this cloud. This is the 'ufds_admin_uuid' SDC config.                                                            |
| ufds.url                     | String           | -         | LDAP URL to connect to UFDS.                                                                                                                   |
| ufds.bindDN                  | String           | -         | UFDS user DN with which to bind.                                                                                                               |
| ufds.bindPassword            | String           | -         | UFDS password for 'bindDN'.                                                                                                                    |
| ufds.caching                 | Boolean          | true      | Should UFDS caching should be enabled?                                                                                                         |
| cnapi.url                    | String           | -         | CNAPI client url.                                                                                                                              |
| vmapi.url                    | String           | -         | VMAPI client url.                                                                                                                              |
| redis.host                   | String           | 127.0.0.1 | Redis server host or IP.                                                                                                                       |
| redis.port                   | Number           | 6379      | Redis server port.                                                                                                                             |
| userCache.size               | Number           | 1000      | The number of entries to cache.                                                                                                                |
| userCache.expiry             | Number           | 300       | The number of seconds for which cache entries are valid.                                                                                       |
| notificationPlugins          | Array            | -         | An array of objects defining all notification mechanisms.                                                                                      |
| notificationPlugins.*.type   | String           | -         | The notification type. This should be a short string, preferably all lowercase and satifying JS identifier rules, e.g. 'email', 'sms', 'xmpp'. |
| notificationPlugins.*.path   | String           | -         | A node `require()` path from which the Amon master can load the plugin module, e.g. "./lib/twillio".                                           |
| notificationPlugins.*.config | Object           | -         | An object with instance data for the plugin.                                                                                                   |



# Events

*This is internal reference data. An Amon user shouldn't need to know
these details.*

An "event" is the thing an amon-agent sends up the stack (via AddEvents)
when a probe fires. These are type "probe" events, the most common event.
Other types of events are supported for minor usage.

Common event fields:

| Field      | Required? | Type      | Description                                                                                             |
| ---------- | --------- | --------- | ------------------------------------------------------------------------------------------------------- |
| v          | required  | Integer   | Amon event version. A single integer, updated for backward compat breaking changes.                     |
| type       | required  | String    | One of "probe" or "fake". See sections below.                                                           |
| user       | required  | UUID      | The UUID of the owning user.                                                                            |
| time       | required  | Timestamp | Added by the amon-relay. The time of the event.                                                         |
| agent      | required  | UUID      | Added by the amon-relay. The agent from which the event originated.                                     |
| agentAlias | required  | String    | Added by the amon-relay. An alias for the agent: the hostname for a server, vm alias (if any) for a vm. |
| relay      | required  | UUID      | Added by the amon-relay. The UUID of the amon-relay.                                                    |

Other potential event types:

- "operator event": send to (Amon) operator for some internal Amon problem
- "user event": send to user for some configuration problem in their data?
  E.g. I was think that with groups, notify the group owner if can't contact
  one of the group members. Not sure though.
- "relay" event? A problem report from a relay? A heartbeat from a relay?
  Perhaps this is just an operator event? Not sure.



## Event Type: probe

An event from a probe firing.

| Field        | Required? | Type    | Description                                                                                         |
| ------------ | --------- | ------- | --------------------------------------------------------------------------------------------------- |
| probeUuid    | required  | UUID    | The UUID of the probe that generated this event.                                                    |
| clear        | required  | Boolean | Whether this event should result in clearing a fault on an alarm (and possibly clearing the alarm). |
| data         | required  | Object  | Extra data specific to the type of probe.                                                           |
| data.message | required  | String  | A brief prose description of the event.                                                             |
| data.value   | optional  | Number  | A numerical value useful for comparing/tracking/using the event.                                    |
| data.details | optional  | Object  | Additional probe type-specific info about the event.                                                |
| machine      | required  | UUID    | The server or vm from which the event originated.                                                   |

An example probe event:

    {
      "v": 1,
      "type": "probe",
      "user": "a3040770-c93b-6b41-90e9-48d3142263cf",
      "probeUuid": "13b340ad-1e0f-40e3-86cb-e0429d9a4835",
      "clear": false,
      "data": {
        "message": "Log \"/var/svc/log/smartdc-agent-smartlogin:default.log\" matched /Stopping/.",
        "value": 1,
        "details": {
          "match": "[ Aug 14 05:02:21 Stopping because service restarting. ]"
        }
      },
      "machine": "44454c4c-3200-1042-804d-c2c04f575231",

      // Added by relay:
      "uuid": "f833288e-d68e-478a-bd11-58a4f1358b21",
      "time": 1344920541118,
      "agent": "44454c4c-3200-1042-804d-c2c04f575231",
      "agentAlias": "headnode",
      "relay": "44454c4c-3200-1042-804d-c2c04f575231"
    }




# MVP

Roughly said:

"The absolute MVP for Monitoring is having the ability to alert when a
VM or Zone goes down, and the ability to alert someone via email."

More detail:

- Only necessary alert medium: email.
  *Done. Email notification type.*
- Ability to alert operator when a machine goes down.
  *Done. "machine-up" probe type. There are remaining tickets for avoiding
  alarms for intentional reboots, etc.*
- Ability to alert operator when that machine comes back up (aka a "clear" or "ok").
  *Done. "machine-up" probes will clear.*
- Ability to alert customer when their machine goes down.
  Option to distinguish between going down for a fault (FMA) or any reason
  (includes intentional reboots).
  *Q: Where does the reboot of a full CN fit in here?*
  *"machine-up" probe type works, but
- Ability to alert customer when their machine comes back up (aka a "clear" or "ok").
- Ability to suppress alerts on an open alarm. (Yes, I know there is a
  problem here, quit bugging me about it.)
- Ability to disable a monitor.
- Ability for customer to set a maintenance window on a monitor (alert
  suppression for a pre-defined period of time).
- Ability for operator to set a maintenance window on a CN and on the whole
  cloud. This would disable alerts to operator.
- Amon Master API integrated into Cloud API.
- Integration of Monitor management into AdminUI and Portal.
- Upgradable amon system.




# Use Cases

Some Amon use cases to guide its design and to demonstrate how to use
Amon. **Note: Current Amon doesn't support all these use cases yet.**

In the examples below "otto" is an operator account commonly used
in dev work on Amon, "564d70d5-0187-e5d4-468f-7b49a6b014ff" is the headnode
UUID, etc.



## 1. Operator SDC Log Monitor

**LIMITATION: Don't have 'smf-log-scan' type yet. Also, current SDC7 logs are
typically Bunyan logs in which "ERROR" does not literally appear. TODO:
some Bunyan log-scan type or option.**

Probes for watching relevant SDC log files for, say, "ERROR".

    sdc-amon /pub/otto/probegroups -X POST -d '{
        "contacts": ["email"],
        "name": "sdclogs"
    }'

    # GZ probes
    sdc-amon /pub/otto/probes -X POST -d '{
        "type": "log-scan",
        "name": "headnode-ur",
        "group": "...",
        "agent": "564d70d5-0187-e5d4-468f-7b49a6b014ff",
        "config": {
            "path": "/var/svc/log/smartdc-agent-ur:default.log",
            "match": {
                "pattern": "ERROR"
            }
        }
    }'
    # Or perhaps a specialized probe "smf-log-scan" type for SMF logs.
    sdc-amon /pub/otto/monitors/sdclogs/probes/headnode-heartbeater -X PUT -d '{
        "type": "smf-log-scan",
        "agent": "564d70d5-0187-e5d4-468f-7b49a6b014ff",
        "config": {
            "fmri": "svc:/smartdc/agent/heartbeater:default",
            "match": {
                "pattern": "ERROR"
            }
        }
    }'
    ...

    # SDC zones probes
    # Where 'ea3898cd-4ca9-410a-bfa6-0152ba07b1d7' is the ufds0 zone name.
    sdc-amon /pub/otto/monitors/sdclogs/probes/ufds0-ufds-server -X PUT -d '{
        "type": "log-scan",
        "agent": "ea3898cd-4ca9-410a-bfa6-0152ba07b1d7",
        "config": {
            "path": "/var/log/ufds/server.log",
            "match": {
                "pattern": "ERROR"
            }
        }
    }'
    ...

TODO: script this up



## 2. Operator SDC Zones monitor

Probe for SDC zones going up and down. Separate from "SDC Log monitor"
because zone up/down alarms can clear.

    sdc-amon /pub/otto/monitors/sdczones -X PUT -d '{
        "contacts": ["email"]
    }'

    # Create a probe like the following for all SDC zones:
    #    sdc-amon /pub/otto/monitors/sdczones/probes/ufds0 -X PUT -d '{
    #        "type": "machine-up",
    #        "agent": "ea3898cd-4ca9-410a-bfa6-0152ba07b1d7"
    #    }'
    admin_uuid=$(bash /lib/sdc/config.sh -json | json ufds_admin_uuid)
    sdc_zones=$(sdc-vmapi /vms?owner_uuid=$admin_uuid \
        | json -H -c "this.tags.smartdc_type" -a uuid alias -d:)
    for z in $sdc_zones; do
        uuid=${z%:*}
        alias=${z#*:}
        echo "# Add machine-up probe for zone $uuid ($alias)."
        sdc-amon /pub/otto/monitors/sdczones/probes/$alias -X PUT -d "{
            \"type\": \"machine-up\",
            \"agent\": \"$uuid\"
        }"
    done

TODO: could update this to be smarter about whether the probe already
exists to re-run.

See <https://stuff.joyent.us/stuff/trent/screencasts/amon1.mov> (Joyent
Internal) for a screencast demonstrating this use case.



## 3. Operator SDC Services monitor

**LIMITATION: Don't have "smf" probe type yet.**

Probe for SDC zones' and GZ's "smartdc" services going up/down.

    PUT /my/monitors/services < {
            "contacts": ["email"]
        }
    PUT /my/monitors/services/probes/$machine_alias-$fmri_nickname < {
            "type": "smf",
            "agent": "$machine_uuid",
            "config": {
                "fmri": "$fmri"
            }
        }
    PUT /my/monitors/services/probes/$headnode_hostname-$fmri_nickname < {
            "type": "smf",
            "agent": "$compute_node_uuid",
            "config": {
                "fmri": "$fmri"
            }
        }

For example:

    sdc-amon /pub/otto/monitors/sdcservices -X PUT -d- < '{
        "contacts": ["email"]
    }'
    # Where '564d70d5-0187-e5d4-468f-7b49a6b014ff' is my headnode UUID.
    sdc-amon /pub/otto/monitors/sdcservices/probes/headnode-smartlogin -X PUT -d- < '{
        "type": "smf",
        "agent": "564d70d5-0187-e5d4-468f-7b49a6b014ff",
        "config": {
            "fmri": "svc:/smartdc/agent/smartlogin:default"
        }
    }'
    ...
    # Where 'ea3898cd-4ca9-410a-bfa6-0152ba07b1d7' is the ufds0 zone name.
    sdc-amon /pub/otto/monitors/sdcservices/probes/ufds0-ufds-capi -X PUT -d- < '{
        "type": "smf",
        "agent": "ea3898cd-4ca9-410a-bfa6-0152ba07b1d7",
        "config": {
            "fmri": "svc:/smartdc/agent/smartlogin:default"
        }
    }'
    ...


## 4. Customer "Machine up" monitor

Probe for each of my machines going up and down.

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
            "type": "machine-up",
            "agent": "$machine_uuid"
        }

TODO: script this up.


## 5. Customer "Site up" monitor

Probe to "GET /canary" on the site from some other source location.

    PUT /my/monitors/site < {
            "contacts": ["email"]
        }
    PUT /my/monitors/site/probes/webcheck < {
            "agent": "$machine_uuid",  // <--- this is the machine to run HTTP request from
            "type": "http",
            "config": {
                "url": "http://example.com/canary.html",
                "method": "GET",
                "statusCodes": [200,201,204,401] // number or list of HTTP status numbers to expect
                "bodyMatch": {...}, // (optional) check for a pattern in returned content
                "interval": 60,  // how often to check (in seconds),
                "period": 300, // alert window
                "threshold": 1 // # of times event must occur within the alert window before alarming
            }
        }


## 6. Operator `mdb -k` goober

Operator wants to run a particular "mdb -k" goober (Bryan's words) to run a
healthcheck on KVM.

    PUT /my/monitors/kvmcheck < {
            "contacts": ["email"]
        }
    PUT /my/monitors/kvmcheck/probes/foo < {
            "type": "mdbkernel",
            "agent": "$machine_uuid",
            "runInGlobal": true,   // must be operator to set this
            "config": {
                // This is essential wide open. That command can presumably
                // do anything.
                "command": ...,
                "match": {...},   // check for a pattern in returned content?
                // Something to check exit value?
                "interval": 60  // how frequently to check.
            }
        }


## 7. Monitoring a multi-machine webapp

Say we have a set of the following machines for a relatively busy service:

- UUID_MON is our monitor zone
- UUID_DB1 master db zone
- UUID_DB2 slave db zone
- UUID_LB load balancer zone
- UUID_WEBHEAD1 webhead 1 zone
- UUID_WEBHEAD2 webhead 2 zone

We might want monitors like the following. Note that this is using some
probe types that don't exist yet and that aren't a high priority right now.

    # Setup a monitor for the service as a whole. Bad news if this one fails,
    # i.e. that's an argument for severities (TODO: severity).
    sdc-amon /pub/trent/monitors/myservice -X PUT -d '{
      "contacts": ["email", "sms"],
      "severity": 1
    }'
    sdc-amon /pub/trent/monitors/myservice/probes/ping -X PUT -d '{
      type: "icmp",
      agent: UUID_MON,
      config: {
        "host": "myservice.example.com"
      }
    }'
    sdc-amon /pub/trent/monitors/myservice/probes/http -X PUT -d '{
      type: "http",
      agent: UUID_MON,
      config: {
        "host": "http://myservice.example.com/status"
      }
    }'

    # Setup monitors for each of the other machines: is it up? errors in logs?
    # relevant services up? Slightly lower prio. For example, for WEBHEAD1
    # we might have:
    sdc-amon /pub/trent/monitors/webhead1 -X PUT -d '{
      contacts: ["email", "sms"],
      severity: 2
    }'
    sdc-amon /pub/trent/monitors/webhead1/probes/machineup -X PUT -d '{
      type: "machine-up"
      agent: UUID_WEBHEAD1,
      // This probe type doesn't accept an agent: it runs from the compute
      // node GZ for `machine`.
    }'
    sdc-amon /pub/trent/monitors/webhead1/probes/ping -X PUT -d '{
      type: "icmp",
      agent: UUID_MON,
      config: {
        "host": "1.2.3.4"
      }
    }'
    sdc-amon /pub/trent/monitors/webhead1/probes/http -X PUT -d '{
      type: "http",
      agent: UUID_MON,
      config: {
        "host": "http://1.2.3.4/status",
        "headers": {
          "Host": "myservice.example.com"
        }
      }
    }'
    sdc-amon /pub/trent/monitors/webhead1/probes/myservice -X PUT -d '{
      type: "smf",    // Not yet implemented
      agent: UUID_WEBHEAD1,
      config: {
        "fmri": "myservice"
      }
    }'
    sdc-amon /pub/trent/monitors/webhead1/probes/logerrors -X PUT -d '{
      type: "log-scan",   // or 'smf-log-scan' if/when that is added
      agent: UUID_WEBHEAD1,
      config: {
        "path": "/var/log/myservice.log",
        "match": {
            "pattern": "ERROR"
        }
      }
    }'

    # Might want a lower-prio "maintenance" monitor for each machine.
    # For example, WEBHEAD1:
    sdc-amon /pub/trent/monitors/webhead1maint -X PUT -d '{
      contacts: ["email"],
      severity: 3
    }'
    sdc-amon /pub/trent/monitors/webhead1maint/probes/disk -X PUT -d '{
      type: "disk-free",   // Not yet implemented
      agent: UUID_WEBHEAD1,
      config: {
        "path": "/",        // or call this 'mount'?
        "capacity": 0.8   // alarm if disk usage is over 80%
      }
    }'
    sdc-amon /pub/trent/monitors/webhead1maint/probes/ram -X PUT -d '{
      type: "ram-free",   // Not yet implemented
      agent: UUID_WEBHEAD1,
      config: {
        "capacity": 0.9,   // alarm if RAM usage is over 90% 3 times in 5 minutes
        "threshold": 3,
        "period": 300
      }
    }'

    # ... likewise for the other machines.

How would I set a maintenance window to upgrade the DBs?

1. Visit the UUID_DB2 machine page in the portal and set a maint window on
   UUID_DB2 (upgrade slave first).
2. Do upgrades on UUID_DB2 and bring it back up.
3. Check monitoring dashboard, if all is well, close the maint window.
4. Switch over DB master/slave for maint on DB1.
5. Visit the UUID_DB1 machine page in the portal and set a maint window on
   UUID_DB1.
6. Do upgrades on UUID_DB2 and bring it back up.
7. Check monitoring dashboard, if all is well, close the maint window.

Or, if the user doesn't think about setting a maint window (doesn't know
about the feature):

1. Start upgrades on UUID_DB2.
2. Get notification for a db2 monitor alarm (presuming he is on the contact
   list for these monitors), and/or gets a flash message in the portal that
   a new alarm has been raised. Click link to alarm page.
3. Visit alarm page. (This alarm page should include info on other
   recent alarms -- perhaps highlighting those related to the same machine.)
4. "Set maintenance window" for this alarm. Really this translates to a
   maint window on the *monitor* -- which is pretty much, but not exactly,
   the same thing. Also an option when creating the maint window on a monitor
   page is to instead set it on the *machine* ("all monitors for this
   machine").
5. Continue as above...


## 8. Operator adding a monitor/probe to be shared amongst all operators

Say an SDC instance has a number of operators, each with their own accounts.
(This is probably suggested, rather than all ops sharing a single account.)
If an operator wants to add monitoring on, say, a CN global zone that is to
be shared amongst all operators, then how should that work?

Suggestion: The monitor/probe is put on the admin/core/sys/system/sdc account
(currently this is the "admin" user, separate discussion on whether that
should actually be called "admin"). So really we'd just want the Operator
Portal to allow a logged in operator to create monitors/probes either on
their own account or on the shared "admin" account.

    sdc-amon /pub/admin/monitors/blah -X PUT -d '{
      contacts: ["lindaEmail"]
    }'

    ...

In the above example, the "admin" account in UFDS needs to have a "lindaEmail"
contact.



# Operator Guide

This section is intended to give necessary information for diagnosing and
dealing with issues with Amon in a SmartDataCenter installation.

Amon consists of three pieces:

1. One or more "amon-masters". This is an "amon-master" service running in an
   "amon" zone. If/when HA is added for amon, there may be more than one
   of these zones. To list them:

        sdc-vmapi /vms?owner_uuid=$(bash /lib/sdc/config.sh -json | json ufds_admin_uuid) \
            | json -H -c "this.tags.smartdc_role=='amon'"

   The master provides the "Master API" endpoints (as documented above).
   The Operator Portal (adminui) exposes the Amon Master API. Parts of the
   Master API are exposed through cloudapi (and then for use by the User
   Portal).

   A user defines Amon "monitors" and "probes" on the Master API.

2. One "amon-relay" agent in the GZ of each compute node (including the
   headnode). This is an "amon-relay" service.

3. Many "amon-agent" agents. There will always be an amon-agent agent in
   each GZ. There may also optionally be a running amon-agent in any zone
   (typically SDC zones will be running an amon-agent). Runnable amon-agent
   installations will be exposed to zones (including customer zones) from
   the GZ. It is up to each zone to run (or not) an amon-agent.

   Running an amon-agent in a kvm *VM* (say, a Linux or Windows VM) is not
   yet supported.


Amon is mostly local to a data center. I.e. when a user creates an Amon
object (a "monitor" or "probe") or when an Amon "alarm" is created for a
fault, it is local to that data center. The only exception is that contact
details used for notifications (e.g. email address, phone number for SMS,
URL for webhooks) are attributes on the user record in UFDS (the "sdcPerson"
objectclass in LDAP). This part of UFDS is replicated across all data
centers in a cloud.


## Health

An amon service *should* be healthy if all its services are up:

    $ sdc-oneachnode 'svcs -Zx | grep amon'

An "amon-master" has a "/ping" endpoint to indicate if it is up

    $ sdc-amon /ping

or if there are multiple Amon Masters:

    $ for ip in $(bash /lib/sdc/config.sh -json | json amon_admin_ips | tr ',' ' '); do \
        echo "# $ip" ; \
        curl -sS http://$ip/ping | json ; \
    done

Each "amon-relay" also has a "/ping" endpoint:

    $ sdc-oneachnode 'curl -sS localhost:4307/ping'
    HOST                 OUTPUT
    headnode             {"ping":"pong"}
    computenodeA         {"ping":"pong"}

TODO: sdc-healthcheck, sdc-webinfo


## Logs

| service/path | where | format | tail -f |
| ------------ | ----- | ------ | ------- |
| amon-master | in each "amon" zone | [Bunyan](https://github.com/trentm/node-bunyan) | `` sdc-login amon; tail -f `svcs -L amon-master` | bunyan `` |
| amon-relay | in each GZ | [Bunyan](https://github.com/trentm/node-bunyan) | `` tail -f `svcs -L amon-relay` | bunyan `` |
| amon-agent | in each GZ and in some zones | [Bunyan](https://github.com/trentm/node-bunyan) | `` tail -f `svcs -L amon-agent` | bunyan `` |



## How to use the XMPP notification plugin

The Amon Master now ships with a 'xmpp' plugin. In its current state all XMPP
information (host, jid, Jabber room in which to notify) is configured in
the amon-master's "notificationsPlugin" config var.

In SDC, the xmpp notification type should be added by setting the
"AMON_CUSTOM_NOTIFICATION_TYPES" metadata on the "amon" service in SAPI.
There is a tool in the amon zone to assist with this:

    sdc-login amon
    /opt/smartdc/amon/tools/add-xmpp-notification-type.sh


After the amon-master has the 'xmpp' notification type, to get a probe
to send over xmpp you need to:

1. Have a `fooxmpp` field on the sdcPerson node in UFDS for the owner
   of the probe, where "foo" is whatever identifying string you like. It
   must end with "xmpp" (case-insensitive). The value of that field is the
   groupchat room JID to which the notification should be send. E.g.:

        monxmpp=mon@conference.example.com

2. Set `fooxmpp` as one of the `contacts` for your probe (or probeGroup).


**Note**: A future implementation of this will move some or all of the xmpp
server info to the individual contact entries. For now amon is just for
operators so this take on it should be fine.


Example of doing #1 and #2 (running in the GZ):

```
# First create a user for myself. Generally the 'admin' user shouldn't be
# used as its amon probes get sync'd to a set of probe definitions.
[root@headnode (coal) ~]# sdc sdc-useradm create -i
login: userbob
email: userbob@joyent.com
userpassword:
userpassword confirm:
cn: User Bob
User 9144796e-0880-440c-bb77-257af293bbb4 (login "userbob") created

# And our user needs to be an operator to be able to add a probe to the 'sdc'
# zone (because 'userbob' doesn't own that zone).
[root@headnode (coal) ~]# cat <<EOM | sdc-ldap modify
dn: cn=operators, ou=groups, o=smartdc
changetype: modify
add: uniquemember
uniquemember: $(sdc-useradm get userbob | json dn)
EOM
modifying entry "cn=operators, ou=groups, o=smartdc"

# Then add a 'bobxmpp' entry on the sdcperson node.
[root@headnode (coal) ~]# sdc-ufds modify -a bobxmpp -v mon@conference.example.com "$(sdc-useradm get userbob | json dn)"

# And verify it got there.
[root@headnode (coal) ~]# sdc-useradm get userbob | json bobxmpp
mon@conference.example.com


# Then let's add a probe using that.
# We'll have it fire whenever "chirp" appears in "/var/tmp/canary.log",
# *in the GZ* (we're using the GZ because MON-300).
[root@headnode (coal) ~]# sdc-amon /pub/userbob/probes -X POST -d@- <<EOP
{
  "name": "xmpp-test",
  "type": "log-scan",
  "agent": "$(sdc-cnapi /servers?hostname=headnode | json -H 0.uuid)",
  "contacts": ["bobxmpp"],
  "groupEvents": false,
  "config": {
    "path": "/var/tmp/canary.log",
    "match": {
      "pattern": "chirp"
    }
  }
}
EOP


# The polling to get amon probe data out to the agents is very slow
# (~30 minutes), so we'll force the headnode amon-relay to expedite that.
# - get the amon-relay to pull from amon-master
curl http://127.0.0.1:4307/state?action=syncprobes -X POST
# - then the amon-agent to pull from the amon-relay
svcadm restart amon-agent && sleep 3
# - verify
json -f /var/db/amon-agent/probeData.json | grep chirp


# Now trigger an alarm. If this doesn't result in a jabber message, then
# time to debug.
echo 'chirp' >>/var/tmp/canary.log

```



## Ops Examples

Some possibly helpful commands for working with the amon.

- At the time of this writing, manta-beta's amon doesn't have the changes
  to reduce noise in the amon-master log. Run this in the amon zone to
  filter that out:

        tail -f `svcs -L amon-master` | bunyan -c '!this.req || this.req.method !== "HEAD"' -c 'this.msg !== "headAgentProbes respond"'

- Adding a canary probe (or two) to the headnode GZ to test that sending
  emails is working:

        sdc-amon /pub/admin/probes -X POST -d@- <<EOP
        {
          "name": "canary-test",
          "type": "log-scan",
          "agent": "$(sysinfo | json UUID)",
          "contacts": ["email"],
          "config": {
            "path": "/var/tmp/canary.log",
            "match": {
              "pattern": "chirp"
            }
          }
        }
        EOP
        sdc-amon /pub/admin/probes -X POST -d@- <<EOP
        {
          "name": "canary-bunyan-test",
          "type": "bunyan-log-scan",
          "agent": "$(sysinfo | json UUID)",
          "contacts": ["email"],
          "config": {
            "path": "/var/tmp/canary-bunyan.log",
            "match": {
              "pattern": "chirp"
            }
          }
        }
        EOP

  Wait until that propagates to the amon-agent:

        cat /var/db/amon-agent/probeData.json | json -c '~this.name.indexOf("canary")'

  You might have to close a currently open alarm to get a notification email
  sent for a newly triggered "chirp":

        sdc-amon /pub/admin/alarms
        sdc-amon /pub/admin/alarms/ID?action=close -X POST

  Trigger an alarm:

        touch /var/tmp/canary.log
        echo chirp >>/var/tmp/canary.log

- Checking that outgoing mail is working:

        sdc-login amon
        postqueue -p

  And possibly flush the queue if having fixed an issue:

        postqueue -f

- Show all recent alarms. This isn't nice output, but a start and digging
  into what has alarmed recently, with a readable timestamp.

        $ sdc-amon /alarms | json -H -e 'this.time = (new Date(this.timeLastEvent)).toString()' -a -- timeLastEvent user id time | sort -n | tail
        ...
        1363107930479 6232d723-4ba8-4fc9-93c5-5d3270e0d74a 622 Tue Mar 12 2013 17:05:30 GMT+0000 (UTC)
        1363108178337 6232d723-4ba8-4fc9-93c5-5d3270e0d74a 623 Tue Mar 12 2013 17:09:38 GMT+0000 (UTC)
        1363108179851 6232d723-4ba8-4fc9-93c5-5d3270e0d74a 624 Tue Mar 12 2013 17:09:39 GMT+0000 (UTC)
