#!/usr/bin/bash
#
# Copyright (c) 2013, Joyent Inc. All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace
#set -o errexit

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

role=amon
app_name=$role

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/sdc-boot/scripts/util.sh
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/amon

# Add node_modules/bin to PATH
echo "" >>/root/.bashrc
echo "export PATH=\$PATH:/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin" >>/root/.bashrc

# Amon master needs postfix to send email notifications.
# - rate limit out going emails to something reasonably high
# - discard bounce email attempts to (hardcoded) no-reply@joyent.com
echo "no-reply@joyent.com discard" >>/opt/local/etc/postfix/transport
/opt/local/sbin/postmap /opt/local/etc/postfix/transport

cat <<EOM >>/opt/local/etc/postfix/main.cf

## -- amon tweaks

transport_maps = hash:/opt/local/etc/postfix/transport

smtp_destination_rate_delay = 5s
smtp_destination_concurrency_failed_cohort_limit = 10

EOM

/usr/sbin/svccfg import /opt/local/share/smf/postfix/manifest.xml || fatal "unable to import postfix SMF manifest"
/usr/sbin/svcadm enable postfix || fatal "unable to enable postfix"


# Setup crontab
crontab=/tmp/$role-$$.cron
crontab -l > $crontab
[[ $? -eq 0 ]] || fatal "Unable to write to $crontab"
echo '' >>$crontab
echo '0,10,20,30,40,50 * * * * /opt/smartdc/amon/bin/alert-if-amon-master-down.sh 2>&1' >>$crontab
crontab $crontab
[[ $? -eq 0 ]] || fatal "Unable import crontab"
rm -f $crontab

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
