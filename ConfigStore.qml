import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The homes-and-profiles document, on disk and in memory.
//
// Lives at ~/.config/omarchy/app-homes.json: plain JSON the user can read,
// diff, and keep in their dotfiles. Every read goes through
// Model.normalizeConfig, so a hand-edit that gets something wrong is repaired
// rather than refused.
Item {
  id: root

  readonly property string home: Quickshell.env("HOME")
  readonly property string configDir: Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")
  readonly property string path: configDir + "/omarchy/app-homes.json"

  property var config: Model.defaultConfig()
  property bool ready: false
  property int revision: 0

  signal loaded(bool existed)

  function apply(document) {
    config = Model.normalizeConfig(document)
    revision++
  }

  function save(document) {
    apply(document)
    file.setText(JSON.stringify(Model.serializeConfig(config), null, 2) + "\n")
  }

  function mutate(change) {
    var draft = JSON.parse(JSON.stringify(config))
    change(draft)
    save(draft)
  }

  FileView {
    id: file
    path: root.path
    watchChanges: true
    atomicWrites: true
    printErrors: false

    onLoaded: {
      try {
        root.apply(JSON.parse(text()))
      } catch (error) {
        console.warn("app-homes: config is not valid JSON, keeping the loaded document:", error)
      }
      root.ready = true
      root.loaded(true)
    }

    onLoadFailed: {
      root.apply(Model.defaultConfig())
      root.ready = true
      root.loaded(false)
    }

    onFileChanged: reload()
  }

  Timer {
    interval: 500
    running: !root.ready
    repeat: false
    onTriggered: {
      if (root.ready) return
      root.apply(Model.defaultConfig())
      root.ready = true
      root.loaded(false)
    }
  }

  Component.onCompleted: file.reload()
}
