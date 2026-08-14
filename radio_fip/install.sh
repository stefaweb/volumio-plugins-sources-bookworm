#!/bin/bash

set -e

echo "Installing radio_fip dependencies"

cd "$(dirname "$0")"

for dep in fs-extra kew v-conf nanotimer moment; do
    if [ ! -d "node_modules/$dep" ]; then
        echo "ERROR: dependency $dep not installed"
        exit 1
    fi
done

echo "radio_fip dependencies installed"

echo "plugininstallend"

