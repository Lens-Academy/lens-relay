#!/bin/bash
set -e
trap "exit" TERM INT

if [ -n "$1" ]; then
    echo "Using URL from argument: $1"
fi

echo "Starting Relay Server..."
./relay config validate
if [ -n "$1" ]; then
    exec ./relay serve --url="$1"
else
    exec ./relay serve
fi
