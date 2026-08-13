#!/bin/bash

PLUGIN_NAME="radio_fip"
PLUGIN_DIR="/data/plugins/music_service/${PLUGIN_NAME}"


echo "[radio_fip] Désinstallation"


if [ -d "${PLUGIN_DIR}" ]; then

    rm -rf "${PLUGIN_DIR}"

    echo "[radio_fip] Plugin supprimé"

else

    echo "[radio_fip] Plugin non trouvé"

fi


echo "[radio_fip] Redémarrage Volumio"

systemctl restart volumio


echo "[radio_fip] Désinstallation terminée"