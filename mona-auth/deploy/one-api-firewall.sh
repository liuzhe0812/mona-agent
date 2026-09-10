#!/bin/sh
set -eu

if ! /usr/sbin/iptables -C INPUT ! -i lo -p tcp --dport 13000 -j DROP 2>/dev/null; then
    /usr/sbin/iptables -I INPUT 1 ! -i lo -p tcp --dport 13000 -j DROP
fi
