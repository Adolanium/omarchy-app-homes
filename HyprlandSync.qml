import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Turns a config document into live Hyprland window rules.
//
// sync() writes the generated Lua and evaluates it. Named rules are
// registered, previous handles retired, and the file on disk is what
// Hyprland's config loads after a restart.
Item {
  id: root

  property var config: null
  property bool manageLoader: false

  readonly property string home: Quickshell.env("HOME")
  readonly property string configDir: Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")
  readonly property string luaPath: configDir + "/hypr/omarchy-app-homes.lua"
  readonly property string hyprlandLuaPath: configDir + "/hypr/hyprland.lua"

  property bool loaderInstalled: false
  property bool loaderChecked: false
  property string lastError: ""
  property string pendingSync: ""

  signal synced()

  function sync() {
    if (!config) return
    var lua = Model.generateLua(config)
    luaFile.setText(lua)
    evaluate(lua)
    synced()
  }

  function evaluate(lua) {
    pendingSync = lua
    if (!syncProcess.running) flushSync()
  }

  function flushSync() {
    if (pendingSync === "") return
    syncProcess.command = Model.hyprctlEvalArgs(pendingSync)
    pendingSync = ""
    syncProcess.running = true
  }

  Process {
    id: syncProcess
    stderr: StdioCollector {
      onStreamFinished: {
        var message = String(text || "").trim()
        root.lastError = (message.length > 0 && message !== "ok") ? message : ""
      }
    }
    onExited: root.flushSync()
  }

  FileView {
    id: luaFile
    path: root.luaPath
    atomicWrites: true
    watchChanges: false
    printErrors: false
  }

  FileView {
    id: hyprlandLuaFile
    path: root.hyprlandLuaPath
    atomicWrites: true
    watchChanges: false
    printErrors: false

    onLoaded: {
      var current = text()
      root.loaderChecked = true
      if (!root.manageLoader) {
        root.loaderInstalled = !Model.needsLoader(current)
        return
      }
      if (Model.needsLoader(current)) {
        setText(Model.withLoader(current))
      }
      root.loaderInstalled = true
    }

    onLoadFailed: {
      root.loaderChecked = true
      root.loaderInstalled = false
    }
  }

  function ensureLoader() {
    hyprlandLuaFile.reload()
  }
}
