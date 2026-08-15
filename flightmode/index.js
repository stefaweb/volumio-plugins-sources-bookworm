'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var exec = require('child_process').exec;

var LOG_PREFIX = '[FlightMode] ';
var UNIT_SERVICE = 'volumio-flightmode.service';
var UNIT_PATH = 'volumio-flightmode.path';
var SYSTEMD_DIR = '/etc/systemd/system';
var RFKILL_CLASS = '/sys/class/rfkill';
var NET_CLASS = '/sys/class/net';

module.exports = ControllerFlightMode;

function ControllerFlightMode(context) {
  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context.logger;
  this.configManager = this.context.configManager;
  this._strings = null;
}

ControllerFlightMode.prototype.onVolumioStart = function () {
  var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);
  this._loadStrings();
  return libQ.resolve();
};

ControllerFlightMode.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ControllerFlightMode.prototype.onStart = function () {
  var self = this;
  self._loadStrings();
  self._ensureStateFiles();

  return self._writeServiceUnit()
    .then(function () {
      return self._generatePathUnit();
    })
    .then(function () {
      return self._linkUnits();
    })
    .then(function () {
      return self._sudo('/bin/systemctl daemon-reload');
    })
    .then(function () {
      return self._sudo('/bin/systemctl enable --now ' + UNIT_SERVICE + ' ' + UNIT_PATH);
    })
    .fail(function (err) {
      self.logger.error(LOG_PREFIX + 'onStart failed: ' + err);
      return libQ.reject(err);
    });
};

ControllerFlightMode.prototype.onStop = function () {
  var self = this;

  return self._writeRadioState(true, true)
    .then(function () {
      return self._writeMode('release');
    })
    .then(function () {
      return self._sudo('/bin/systemctl start ' + UNIT_SERVICE);
    })
    .fail(function (err) {
      self.logger.error(LOG_PREFIX + 'onStop release failed: ' + err);
      return libQ.resolve();
    })
    .then(function () {
      return self._sudo('/bin/systemctl disable --now ' + UNIT_PATH + ' ' + UNIT_SERVICE);
    })
    .fail(function (err) {
      self.logger.error(LOG_PREFIX + 'onStop disable failed: ' + err);
      return libQ.resolve();
    })
    .then(function () {
      return self._sudo('/bin/rm -f ' + path.join(SYSTEMD_DIR, UNIT_PATH) + ' ' + path.join(SYSTEMD_DIR, UNIT_SERVICE));
    })
    .then(function () {
      return self._sudo('/bin/systemctl daemon-reload');
    })
    .fail(function (err) {
      self.logger.error(LOG_PREFIX + 'onStop cleanup failed: ' + err);
      return libQ.resolve();
    });
};

ControllerFlightMode.prototype.onRestart = function () {
};

// UI ---------------------------------------------------------------------------
// sections[0] = section_status    status_text, radios_text, recovery_text
// sections[1] = section_radios    disable_wifi, enable_wifi, disable_bluetooth, enable_bluetooth
// sections[2] = section_control   enable_flightmode, disable_flightmode, hardblock_note

ControllerFlightMode.prototype.getUIConfig = function () {
  var defer = libQ.defer();
  var self = this;
  var langCode = this.commandRouter.sharedVars.get('language_code');

  self._loadStrings();

  self.commandRouter.i18nJson(
    self._i18nPath(langCode),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  ).then(function (uiconf) {
    var wifiOn = self._isRadioOn('wifi');
    var btOn = self._isRadioOn('bluetooth');
    var flightOn = !wifiOn && !btOn;
    var hasEth = self._hasWiredCarrier();
    var radios = self._readRadios();
    var wifiHard = radios.some(function (r) { return r.type === 'wlan' && r.hard; });
    var btHard = radios.some(function (r) { return r.type === 'bluetooth' && r.hard; });
    var anyHard = wifiHard || btHard;

    var statusSection = self._sectionById(uiconf, 'section_status');
    var radiosSection = self._sectionById(uiconf, 'section_radios');
    var controlSection = self._sectionById(uiconf, 'section_control');

    var statusItem = self._contentById(statusSection, 'status_text');
    var radiosItem = self._contentById(statusSection, 'radios_text');
    var recoveryItem = self._contentById(statusSection, 'recovery_text');
    var disableWifi = self._contentById(radiosSection, 'disable_wifi');
    var enableWifi = self._contentById(radiosSection, 'enable_wifi');
    var disableBt = self._contentById(radiosSection, 'disable_bluetooth');
    var enableBt = self._contentById(radiosSection, 'enable_bluetooth');
    var enableFlight = self._contentById(controlSection, 'enable_flightmode');
    var disableFlight = self._contentById(controlSection, 'disable_flightmode');
    var hardNote = self._contentById(controlSection, 'hardblock_note');

    if (statusItem) {
      if (anyHard) {
        statusItem.value = self._t('STATUS.HARD');
      } else if (flightOn) {
        statusItem.value = self._t('STATUS.ON');
      } else if (!wifiOn) {
        statusItem.value = self._t('STATUS.WIFI_OFF');
      } else if (!btOn) {
        statusItem.value = self._t('STATUS.BT_OFF');
      } else {
        statusItem.value = self._t('STATUS.OFF');
      }
    }

    if (radiosItem) {
      radiosItem.value = self._formatRadios(radios);
    }

    if (recoveryItem) {
      recoveryItem.value = hasEth ? self._t('RECOVERY.ETH') : self._t('RECOVERY.NO_ETH');
    }

    if (disableWifi) {
      disableWifi.hidden = !wifiOn || wifiHard;
      if (disableWifi.onClick && disableWifi.onClick.askForConfirm) {
        disableWifi.onClick.askForConfirm.message = hasEth
          ? self._t('CONFIRM.WIFI_ETH')
          : self._t('CONFIRM.WIFI_NO_ETH');
      }
    }
    if (enableWifi) {
      enableWifi.hidden = wifiOn || wifiHard;
    }
    if (disableBt) {
      disableBt.hidden = !btOn || btHard;
    }
    if (enableBt) {
      enableBt.hidden = btOn || btHard;
    }

    if (enableFlight) {
      enableFlight.hidden = flightOn || anyHard;
      if (enableFlight.onClick && enableFlight.onClick.askForConfirm) {
        enableFlight.onClick.askForConfirm.message = hasEth
          ? self._t('CONFIRM.ENABLE_ETH')
          : self._t('CONFIRM.ENABLE_NO_ETH');
      }
    }
    if (disableFlight) {
      disableFlight.hidden = !flightOn || anyHard;
    }

    if (hardNote) {
      hardNote.hidden = !anyHard;
      hardNote.value = self._t('HARDBLOCK.NOTE');
    }

    defer.resolve(uiconf);
  }).fail(function (err) {
    self.logger.error(LOG_PREFIX + 'getUIConfig failed: ' + err);
    defer.reject(new Error());
  });

  return defer.promise;
};

ControllerFlightMode.prototype.enableFlightMode = function () {
  return this._setRadios(false, false, 'reconcile', 'TOAST.ENABLED', true);
};

ControllerFlightMode.prototype.disableFlightMode = function () {
  return this._setRadios(true, true, 'release', 'TOAST.DISABLED', false);
};

ControllerFlightMode.prototype.disableWifi = function () {
  return this._setRadios(false, this._isRadioOn('bluetooth'), 'reconcile', 'TOAST.WIFI_OFF', true);
};

ControllerFlightMode.prototype.enableWifi = function () {
  return this._setRadios(true, this._isRadioOn('bluetooth'), 'release-wifi', 'TOAST.WIFI_ON', false);
};

ControllerFlightMode.prototype.disableBluetooth = function () {
  return this._setRadios(this._isRadioOn('wifi'), false, 'reconcile', 'TOAST.BT_OFF', true);
};

ControllerFlightMode.prototype.enableBluetooth = function () {
  return this._setRadios(this._isRadioOn('wifi'), true, 'release-bluetooth', 'TOAST.BT_ON', false);
};

// Internals -------------------------------------------------------------------

ControllerFlightMode.prototype._setRadios = function (wifiOn, bluetoothOn, mode, toastKey, checkHard) {
  var self = this;
  if (checkHard) {
    var radios = self._readRadios();
    var blocking = radios.some(function (r) {
      if (!r.hard) {
        return false;
      }
      if (mode === 'reconcile' && !wifiOn && r.type === 'wlan') {
        return true;
      }
      if (mode === 'reconcile' && !bluetoothOn && r.type === 'bluetooth') {
        return true;
      }
      return false;
    });
    if (blocking) {
      self.commandRouter.pushToastMessage('error', self._t('PAGE.LABEL'), self._t('TOAST.HARD_DENIED'));
      return libQ.resolve();
    }
  }

  return self._writeRadioState(wifiOn, bluetoothOn)
    .then(function () {
      return self._writeMode(mode);
    })
    .then(function () {
      return self._sudo('/bin/systemctl start ' + UNIT_SERVICE);
    })
    .then(function () {
      self.commandRouter.pushToastMessage('success', self._t('PAGE.LABEL'), self._t(toastKey));
      return self._refreshUI();
    })
    .fail(function (err) {
      self.logger.error(LOG_PREFIX + 'setRadios failed: ' + err);
      self.commandRouter.pushToastMessage('error', self._t('PAGE.LABEL'), self._t('TOAST.FAILED'));
      return libQ.resolve();
    });
};

ControllerFlightMode.prototype._pluginDir = function () {
  return __dirname;
};

ControllerFlightMode.prototype._wifiStateFile = function () {
  return path.join(__dirname, 'wifi.state');
};

ControllerFlightMode.prototype._bluetoothStateFile = function () {
  return path.join(__dirname, 'bluetooth.state');
};

ControllerFlightMode.prototype._legacyStateFile = function () {
  return path.join(__dirname, 'flightmode.state');
};

ControllerFlightMode.prototype._modeFile = function () {
  return path.join(__dirname, 'flightmode.mode');
};

ControllerFlightMode.prototype._isRadioOn = function (which) {
  var file = which === 'bluetooth' ? this._bluetoothStateFile() : this._wifiStateFile();
  try {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8').trim() === 'on';
    }
  } catch (e) {
    this.logger.error(LOG_PREFIX + 'read ' + which + ' state failed: ' + e);
  }
  var key = which === 'bluetooth' ? 'bluetooth' : 'wifi';
  if (this.config.has(key)) {
    return !!this.config.get(key);
  }
  return !this.config.get('flightmode');
};

ControllerFlightMode.prototype._ensureStateFiles = function () {
  var wifiFile = this._wifiStateFile();
  var btFile = this._bluetoothStateFile();
  if (!fs.existsSync(wifiFile) || !fs.existsSync(btFile)) {
    var bothHeld = false;
    if (fs.existsSync(this._legacyStateFile())) {
      bothHeld = fs.readFileSync(this._legacyStateFile(), 'utf8').trim() === 'on';
    } else if (this.config.has('flightmode')) {
      bothHeld = !!this.config.get('flightmode');
    }
    var wifiOn = bothHeld ? false : (this.config.has('wifi') ? !!this.config.get('wifi') : true);
    var btOn = bothHeld ? false : (this.config.has('bluetooth') ? !!this.config.get('bluetooth') : true);
    this._writeRadioStateSync(wifiOn, btOn);
  }
  if (!fs.existsSync(this._modeFile())) {
    fs.writeFileSync(this._modeFile(), 'reconcile\n', 'utf8');
  }
};

ControllerFlightMode.prototype._writeRadioStateSync = function (wifiOn, bluetoothOn) {
  this.config.set('wifi', wifiOn);
  this.config.set('bluetooth', bluetoothOn);
  fs.writeFileSync(this._wifiStateFile(), wifiOn ? 'on\n' : 'off\n', 'utf8');
  fs.writeFileSync(this._bluetoothStateFile(), bluetoothOn ? 'on\n' : 'off\n', 'utf8');
  fs.writeFileSync(this._legacyStateFile(), (!wifiOn && !bluetoothOn) ? 'on\n' : 'off\n', 'utf8');
};

ControllerFlightMode.prototype._writeRadioState = function (wifiOn, bluetoothOn) {
  try {
    this._writeRadioStateSync(wifiOn, bluetoothOn);
    return libQ.resolve();
  } catch (e) {
    return libQ.reject(e);
  }
};

ControllerFlightMode.prototype._writeMode = function (mode) {
  try {
    fs.writeFileSync(this._modeFile(), mode + '\n', 'utf8');
    return libQ.resolve();
  } catch (e) {
    return libQ.reject(e);
  }
};

ControllerFlightMode.prototype._writeServiceUnit = function () {
  var src = path.join(__dirname, 'units', 'volumio-flightmode.service.in');
  var dest = path.join(__dirname, 'units', UNIT_SERVICE);
  try {
    var text = fs.readFileSync(src, 'utf8').replace(/__PLUGIN_DIR__/g, this._pluginDir());
    fs.writeFileSync(dest, text, 'utf8');
    return libQ.resolve();
  } catch (e) {
    return libQ.reject(e);
  }
};

ControllerFlightMode.prototype._generatePathUnit = function () {
  var self = this;
  var defer = libQ.defer();
  var cmd = '/bin/bash ' + path.join(__dirname, 'scripts', 'flightmode-apply.sh') + ' --generate-path';
  exec(cmd, { uid: 1000, gid: 1000 }, function (error, stdout, stderr) {
    if (error) {
      self.logger.error(LOG_PREFIX + 'generate path unit failed: ' + (stderr || error.message));
      defer.reject(error);
    } else {
      defer.resolve();
    }
  });
  return defer.promise;
};

ControllerFlightMode.prototype._linkUnits = function () {
  var serviceSrc = path.join(__dirname, 'units', UNIT_SERVICE);
  var pathSrc = path.join(__dirname, 'units', UNIT_PATH);
  var serviceDest = path.join(SYSTEMD_DIR, UNIT_SERVICE);
  var pathDest = path.join(SYSTEMD_DIR, UNIT_PATH);
  var self = this;

  return self._sudo('/bin/ln -sf ' + self._shellQuote(serviceSrc) + ' ' + self._shellQuote(serviceDest))
    .then(function () {
      return self._sudo('/bin/ln -sf ' + self._shellQuote(pathSrc) + ' ' + self._shellQuote(pathDest));
    });
};

ControllerFlightMode.prototype._sudo = function (cmd) {
  var self = this;
  var defer = libQ.defer();
  exec('/usr/bin/sudo ' + cmd, { uid: 1000, gid: 1000 }, function (error, stdout, stderr) {
    if (error) {
      self.logger.error(LOG_PREFIX + 'sudo failed: ' + cmd + ' :: ' + (stderr || error.message));
      defer.reject(new Error(stderr || error.message));
    } else {
      defer.resolve(stdout);
    }
  });
  return defer.promise;
};

ControllerFlightMode.prototype._shellQuote = function (value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
};

ControllerFlightMode.prototype._readRadios = function () {
  var radios = [];
  if (!fs.existsSync(RFKILL_CLASS)) {
    return radios;
  }
  var entries = fs.readdirSync(RFKILL_CLASS);
  for (var i = 0; i < entries.length; i++) {
    var dir = path.join(RFKILL_CLASS, entries[i]);
    var typePath = path.join(dir, 'type');
    if (!fs.existsSync(typePath)) {
      continue;
    }
    var type;
    try {
      type = fs.readFileSync(typePath, 'utf8').trim();
    } catch (e) {
      continue;
    }
    if (type !== 'bluetooth' && type !== 'wlan') {
      continue;
    }
    var name = entries[i];
    try {
      name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim();
    } catch (e) {
    }
    var soft = false;
    var hard = false;
    try {
      soft = fs.readFileSync(path.join(dir, 'soft'), 'utf8').trim() === '1';
    } catch (e) {
    }
    try {
      hard = fs.readFileSync(path.join(dir, 'hard'), 'utf8').trim() === '1';
    } catch (e) {
    }
    radios.push({ id: entries[i], name: name, type: type, soft: soft, hard: hard });
  }
  return radios;
};

ControllerFlightMode.prototype._formatRadios = function (radios) {
  var self = this;
  if (!radios.length) {
    return self._t('RADIOS.NONE');
  }
  return radios.map(function (r) {
    var typeLabel = r.type === 'wlan' ? self._t('RADIOS.WLAN') : self._t('RADIOS.BLUETOOTH');
    return self._t('RADIOS.LINE')
      .replace('{name}', r.name)
      .replace('{type}', typeLabel)
      .replace('{soft}', r.soft ? self._t('SOFT.BLOCKED') : self._t('SOFT.UNBLOCKED'))
      .replace('{hard}', r.hard ? self._t('HARD.BLOCKED') : self._t('HARD.UNBLOCKED'));
  }).join('  |  ');
};

ControllerFlightMode.prototype._hasWiredCarrier = function () {
  if (!fs.existsSync(NET_CLASS)) {
    return false;
  }
  var ifaces = fs.readdirSync(NET_CLASS);
  for (var i = 0; i < ifaces.length; i++) {
    var name = ifaces[i];
    if (name === 'lo') {
      continue;
    }
    if (/^(wlan|wl|wwan|wwp|docker|br-|veth|tun|tap|virbr|cni)/.test(name)) {
      continue;
    }
    if (!/^(eth|enp|ens|eno|enx|usb|en\d)/.test(name)) {
      continue;
    }
    try {
      var carrier = fs.readFileSync(path.join(NET_CLASS, name, 'carrier'), 'utf8').trim();
      if (carrier === '1') {
        return true;
      }
    } catch (e) {
    }
  }
  return false;
};

ControllerFlightMode.prototype._refreshUI = function () {
  var self = this;
  return self.commandRouter.getUIConfigOnPlugin('system_controller', 'flightmode', {})
    .then(function (config) {
      self.commandRouter.broadcastMessage('pushUiConfig', config);
    })
    .fail(function (err) {
      self.logger.error(LOG_PREFIX + 'refresh UI failed: ' + err);
      return libQ.resolve();
    });
};

ControllerFlightMode.prototype._sectionById = function (uiconf, id) {
  if (!uiconf || !uiconf.sections) {
    return null;
  }
  for (var i = 0; i < uiconf.sections.length; i++) {
    if (uiconf.sections[i].id === id) {
      return uiconf.sections[i];
    }
  }
  return null;
};

ControllerFlightMode.prototype._contentById = function (section, id) {
  if (!section || !section.content) {
    return null;
  }
  for (var i = 0; i < section.content.length; i++) {
    if (section.content[i].id === id) {
      return section.content[i];
    }
  }
  return null;
};

ControllerFlightMode.prototype._i18nPath = function (langCode) {
  var candidate = path.join(__dirname, 'i18n', 'strings_' + langCode + '.json');
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.join(__dirname, 'i18n', 'strings_en.json');
};

ControllerFlightMode.prototype._loadStrings = function () {
  var langCode = 'en';
  try {
    langCode = this.commandRouter.sharedVars.get('language_code') || 'en';
  } catch (e) {
  }
  try {
    this._strings = fs.readJsonSync(this._i18nPath(langCode));
  } catch (e) {
    try {
      this._strings = fs.readJsonSync(path.join(__dirname, 'i18n', 'strings_en.json'));
    } catch (e2) {
      this._strings = {};
    }
  }
};

ControllerFlightMode.prototype._t = function (key) {
  var parts = String(key).split('.');
  var cur = this._strings || {};
  for (var i = 0; i < parts.length; i++) {
    if (cur === undefined || cur === null || !Object.prototype.hasOwnProperty.call(cur, parts[i])) {
      return key;
    }
    cur = cur[parts[i]];
  }
  return typeof cur === 'string' ? cur : key;
};
