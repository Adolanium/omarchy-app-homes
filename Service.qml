import QtQuick

// Optional background sync, for running the plugin without its bar widget.
//
// `omarchy plugin enable` places a bar widget; mounting a service needs an
// entry in shell.json's top-level plugins[]. A plugin that declares both,
// enabled the usual way, gets the widget and not the service — so the panel
// does its own syncing and never depends on this file existing.
Item {
  id: root

  ConfigStore {
    id: store
    onRevisionChanged: syncTimer.restart()
  }

  HyprlandSync {
    id: sync
    config: store.config
    manageLoader: true
  }

  Timer {
    id: syncTimer
    interval: 180
    repeat: false
    onTriggered: if (store.ready) sync.sync()
  }

  Component.onCompleted: sync.ensureLoader()
}
