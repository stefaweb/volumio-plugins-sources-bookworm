#!/bin/bash

set -e

echo "Installing radio_fip dependencies"

cd "$(dirname "$0")"

npm install --production

if [ ! -d "node_modules/kew" ]; then
    echo "ERROR: kew not installed"
    exit 1
fi

echo "radio_fip dependencies installed"

echo "plugininstallend"
