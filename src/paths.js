'use strict';
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = process.env.EAGLAN_DATA ? path.resolve(process.env.EAGLAN_DATA) : path.join(root, 'data');
const vendorDir = path.join(root, 'vendor', 'eaglercraftx-1.8-u53');

module.exports = {
  root,
  dataDir,
  vendorDir,
  dbFile: path.join(dataDir, 'worlds.sqlite'),
  configFile: path.join(dataDir, 'config.json'),
  relaysFile: process.env.EAGLAN_RELAYS_FILE ? path.resolve(process.env.EAGLAN_RELAYS_FILE) : path.join(dataDir, 'relays.txt'),
  stateFile: path.join(dataDir, 'host-state.json'),
  sessionFile: path.join(dataDir, 'session.json'),
  logDir: path.join(dataDir, 'logs'),
  importDir: path.join(dataDir, 'imports'),
  classesJs: path.join(vendorDir, 'classes.js'),
  langFile: (l) => path.join(vendorDir, 'lang', l + '.lang'),
};
