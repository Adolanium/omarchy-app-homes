import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "adolanium.app-homes"
  ipcTarget: "app-homes"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // ------------------------------------------------------------------ state

  property var clients: []
  property string selectedKind: "window"
  property int selectedIndex: 0
  property bool showKeys: false
  property string armedDelete: ""
  property bool creatingProfile: false
  property string newProfileDraft: ""

  readonly property var config: store.config
  readonly property var profile: Model.activeProfile(config)
  readonly property var homes: Model.activeHomes(config)
  readonly property string activeProfileName: profile ? profile.name : ""
  readonly property var focused: Model.focusedClient(clients)
  readonly property string focusedClass: focused ? (focused.initialClass || "") : ""
  readonly property var focusedHome: Model.findHomeForClient(config, focused)

  readonly property var workspaceRow: {
    var ids = []
    var i
    for (i = 1; i <= 10; i++) ids.push(i)
    return ids
  }

  readonly property var selectedHome: {
    if (selectedKind === "home" && selectedIndex >= 0 && selectedIndex < homes.length)
      return homes[selectedIndex]
    if (selectedKind === "window") {
      var client = selectedClient
      return client ? Model.findHomeForClient(config, client) : null
    }
    return null
  }

  readonly property var selectedClient: {
    if (selectedKind !== "window") return focused
    if (selectedIndex >= 0 && selectedIndex < clients.length) return clients[selectedIndex]
    return focused
  }

  readonly property color fg: Color.popups.text
  readonly property color accent: Color.accent

  function openFromHotkey() { open() }

  onOpenedChanged: {
    armedDelete = ""
    creatingProfile = false
    showKeys = false
    if (opened) {
      refreshClients()
      selectedKind = clients.length > 0 ? "window" : (homes.length > 0 ? "home" : "window")
      selectedIndex = 0
    }
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function summon() {
    if (bar && typeof bar.summonBarWidget === "function" && bar.summonBarWidget(moduleName)) return
    open()
  }

  // ------------------------------------------------------------- hyprland

  function refreshClients() {
    if (!clientsProc.running) clientsProc.running = true
  }

  Process {
    id: clientsProc
    command: ["hyprctl", "-j", "clients"]
    stdout: StdioCollector {
      onStreamFinished: root.clients = Model.parseClients(text)
    }
  }

  Timer {
    interval: 800
    running: true
    repeat: true
    onTriggered: root.refreshClients()
  }

  ConfigStore {
    id: store
    onRevisionChanged: syncTimer.restart()
    onLoaded: {
      if (store.ready) {
        sync.ensureLoader()
        syncTimer.restart()
      }
    }
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

  Component.onCompleted: {
    refreshClients()
    sync.ensureLoader()
  }

  function persist(document) {
    store.save(document)
    sync.sync()
  }

  // ---------------------------------------------------------------- actions

  function learnClient(client, workspace) {
    if (!client) return
    var home = Model.homeFromClient(client)
    if (workspace !== undefined) home.workspace = Model.normalizeWorkspaceId(workspace)
    if (home.workspace === null) home.workspace = 1
    persist(Model.upsertHome(store.config, home))
    selectedKind = "home"
    Qt.callLater(function() {
      var next = Model.activeHomes(store.config)
      for (var i = 0; i < next.length; i++) {
        if (next[i].class === home.class && next[i].title === home.title) {
          selectedIndex = i
          break
        }
      }
    })
  }

  function learnFocused() {
    learnClient(focused || selectedClient)
  }

  function assignWorkspace(id) {
    var home = selectedHome
    if (home) {
      persist(Model.upsertHome(store.config, Object.assign({}, home, { workspace: id })))
      return
    }
    if (selectedClient) learnClient(selectedClient, id)
  }

  function clearWorkspace() {
    var home = selectedHome
    if (!home) return
    persist(Model.upsertHome(store.config, Object.assign({}, home, { workspace: null })))
  }

  function editSelected(change) {
    var home = selectedHome
    if (!home) return
    var draft = Object.assign({}, home)
    change(draft)
    persist(Model.upsertHome(store.config, draft))
  }

  function cyclePlacement() {
    var order = Model.PLACEMENTS
    editSelected(function(home) {
      var at = order.indexOf(home.placement)
      home.placement = order[(at + 1) % order.length]
    })
  }

  function toggleFloat() {
    editSelected(function(home) {
      home.placement = home.placement === "float" ? "default" : "float"
    })
  }

  function toggleArrive() {
    editSelected(function(home) {
      home.arrive = home.arrive === "silent" ? "jump" : "silent"
    })
  }

  function toggleOpaque() {
    editSelected(function(home) { home.opaque = !home.opaque })
  }

  function toggleNoShare() {
    editSelected(function(home) { home.noScreenShare = !home.noScreenShare })
  }

  function cycleIdle() {
    var order = Model.IDLE_MODES
    editSelected(function(home) {
      var at = order.indexOf(home.idleInhibit)
      home.idleInhibit = order[(at + 1) % order.length]
    })
  }

  function forgetSelected() {
    var home = selectedHome
    if (!home) return
    if (armedDelete !== home.id) {
      armedDelete = home.id
      return
    }
    persist(Model.removeHome(store.config, home.id))
    armedDelete = ""
    selectedIndex = Math.max(0, selectedIndex - 1)
  }

  function addProfile() {
    var name = Model.uniqueProfileName(store.config, newProfileDraft || "profile")
    store.mutate(function(draft) {
      var current = Model.activeProfile(draft)
      var copy = JSON.parse(JSON.stringify(current.homes || []))
      draft.profiles.push({ name: name, homes: copy })
      draft.activeProfile = name
    })
    sync.sync()
    creatingProfile = false
    newProfileDraft = ""
  }

  function activateProfile(name) {
    persist(Model.setActiveProfile(store.config, name))
  }

  function moveSelection(dy) {
    if (selectedKind === "window") {
      if (clients.length === 0) {
        if (homes.length > 0) { selectedKind = "home"; selectedIndex = 0 }
        return
      }
      var next = selectedIndex + dy
      if (next < 0) return
      if (next >= clients.length) {
        if (homes.length > 0) { selectedKind = "home"; selectedIndex = 0 }
        return
      }
      selectedIndex = next
    } else {
      if (homes.length === 0) {
        if (clients.length > 0) { selectedKind = "window"; selectedIndex = Math.max(0, clients.length - 1) }
        return
      }
      var homeNext = selectedIndex + dy
      if (homeNext < 0) {
        if (clients.length > 0) { selectedKind = "window"; selectedIndex = clients.length - 1 }
        return
      }
      selectedIndex = Math.min(homes.length - 1, homeNext)
    }
    armedDelete = ""
  }

  IpcHandler {
    target: "app-homes"

    function open(): void { root.summon() }
    function close(): void { root.close() }
    function show(): void { root.summon() }
    function hide(): void { root.close() }
    function toggle(): void { root.opened ? root.close() : root.summon() }
    function learn(): void { root.learnFocused() }
  }

  // ------------------------------------------------------------------- view

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: profileInput.activeFocus

      onMoveRequested: function(dx, dy) {
        if (dx !== 0) {
          var ids = root.workspaceRow
          var current = root.selectedHome && root.selectedHome.workspace !== null
            ? root.selectedHome.workspace : 1
          var at = ids.indexOf(current)
          if (at < 0) at = 0
          root.assignWorkspace(ids[Math.max(0, Math.min(ids.length - 1, at + dx))])
        } else if (dy !== 0) {
          root.moveSelection(dy)
        }
      }

      onCloseRequested: {
        if (root.creatingProfile) root.creatingProfile = false
        else if (root.showKeys) root.showKeys = false
        else if (root.armedDelete !== "") root.armedDelete = ""
        else root.close()
      }

      onTabRequested: function(direction) { root.switchPanel(direction) }

      onActivateRequested: root.learnFocused()

      onTextKey: function(key) {
        if (key === "l" || key === "L") root.learnFocused()
        else if (key === "f" || key === "F") root.cyclePlacement()
        else if (key === "a" || key === "A") root.toggleArrive()
        else if (key === "o" || key === "O") root.toggleOpaque()
        else if (key === "s" || key === "S") root.toggleNoShare()
        else if (key === "i" || key === "I") root.cycleIdle()
        else if (key === "x" || key === "X" || key === "\u007f") root.forgetSelected()
        else if (key === "n" || key === "N") { root.creatingProfile = true; profileInput.forceActiveFocus() }
        else if (key === "?") root.showKeys = !root.showKeys
        else if (key === "0") root.assignWorkspace(10)
        else if (key >= "1" && key <= "9") root.assignWorkspace(parseInt(key, 10))
        else if (key === "`" || key === "~") root.clearWorkspace()
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.spacing.xxl

        Item {
          width: parent.width
          height: title.implicitHeight

          Text {
            id: title
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "App Homes"
            color: root.fg
            font.family: Style.font.family
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Text {
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.activeProfileName
            color: Util.alpha(root.fg, 0.55)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }

        PanelHero {
          title: root.focused ? Model.displayNameForClient(root.focused) : "No focused window"
          meta: root.focused
            ? (root.focused.initialClass + " · workspace " + root.focused.workspace)
            : "Focus a window and press L to pin it"
          detail: root.focusedHome ? Model.describeHome(root.focusedHome) : "unassigned"
          foreground: root.fg
          iconComponent: Component {
            Text {
              text: "󰋜"
              color: root.fg
              opacity: root.focusedHome ? 1 : 0.45
              font.family: Style.font.family
              font.pixelSize: Style.font.display
            }
          }
          trailingControl: Component {
            PanelActionButton {
              iconText: "󰐕"
              tooltipText: "Learn focused window"
              foreground: root.fg
              enabled: root.focused !== null
              onClicked: root.learnFocused()
            }
          }
        }

        Flow {
          width: parent.width
          spacing: Style.spacing.xs

          Repeater {
            model: root.workspaceRow

            Rectangle {
              id: chip
              required property int modelData

              readonly property bool claimed: {
                var home = root.selectedHome
                return home && home.workspace === modelData
              }
              readonly property bool occupied: {
                for (var i = 0; i < root.homes.length; i++) {
                  if (root.homes[i].workspace === modelData) return true
                }
                return false
              }

              width: Style.space(28)
              height: Style.space(28)
              radius: Style.cornerRadius
              color: claimed ? Util.alpha(root.accent, 0.18) : Util.alpha(root.fg, 0.04)
              border.width: 1
              border.color: claimed
                ? Util.alpha(root.accent, 0.9)
                : Util.alpha(root.fg, chipHover.hovered ? 0.4 : 0.12)

              Text {
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: chip.modelData === 10 ? "0" : String(chip.modelData)
                color: chip.claimed ? root.fg : Util.alpha(root.fg, chip.occupied ? 0.85 : 0.45)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: chip.claimed
              }

              HoverHandler { id: chipHover }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.assignWorkspace(chip.modelData)
              }
            }
          }
        }

        Column {
          width: parent.width
          spacing: Style.spacing.sm

          PanelSectionHeader {
            text: "Open windows"
            foreground: root.fg
          }

          Repeater {
            model: root.clients

            CursorSurface {
              required property var modelData
              required property int index
              width: parent.width
              implicitHeight: Style.space(36)
              current: root.selectedKind === "window" && root.selectedIndex === index
              foreground: root.fg
              fill: Style.hoverFillFor(root.fg, root.accent)
              hasCursor: current

              HoverHandler {
                onHoveredChanged: if (hovered) {
                  root.selectedKind = "window"
                  root.selectedIndex = index
                }
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  root.selectedKind = "window"
                  root.selectedIndex = index
                }
                onDoubleClicked: root.learnClient(modelData)
              }

              Row {
                anchors.fill: parent
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                spacing: Style.space(10)

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(16)
                  textFormat: Text.PlainText
                  text: modelData.workspace === 10 ? "0" : String(modelData.workspace || "·")
                  color: Util.alpha(root.fg, 0.55)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  horizontalAlignment: Text.AlignHCenter
                }

                Column {
                  anchors.verticalCenter: parent.verticalCenter
                  width: parent.width - Style.space(90)
                  spacing: 1

                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: Model.displayNameForClient(modelData)
                    color: root.fg
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }
                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: {
                      var home = Model.findHomeForClient(root.config, modelData)
                      return home ? Model.describeHome(home) : modelData.initialClass
                    }
                    color: Util.alpha(root.fg, 0.5)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }
              }
            }
          }

          Text {
            visible: root.clients.length === 0
            textFormat: Text.PlainText
            text: "No mapped windows"
            color: Util.alpha(root.fg, 0.45)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }

        Column {
          width: parent.width
          spacing: Style.spacing.sm

          PanelSectionHeader {
            text: "Homes"
            foreground: root.fg
          }

          Repeater {
            model: root.homes

            CursorSurface {
              required property var modelData
              required property int index
              width: parent.width
              implicitHeight: Style.space(36)
              current: root.selectedKind === "home" && root.selectedIndex === index
              foreground: root.fg
              fill: Style.hoverFillFor(root.fg, root.accent)
              hasCursor: current

              HoverHandler {
                onHoveredChanged: if (hovered) {
                  root.selectedKind = "home"
                  root.selectedIndex = index
                }
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  root.selectedKind = "home"
                  root.selectedIndex = index
                }
              }

              Row {
                anchors.fill: parent
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                spacing: Style.space(10)

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(16)
                  textFormat: Text.PlainText
                  text: modelData.workspace === null ? "·" : (modelData.workspace === 10 ? "0" : String(modelData.workspace))
                  color: Util.alpha(root.fg, 0.55)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  horizontalAlignment: Text.AlignHCenter
                }

                Column {
                  anchors.verticalCenter: parent.verticalCenter
                  width: parent.width - Style.space(90)
                  spacing: 1

                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: modelData.name
                    color: root.fg
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }
                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: Model.describeHome(modelData)
                    color: Util.alpha(root.fg, 0.5)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }
              }
            }
          }

          Text {
            visible: root.homes.length === 0
            textFormat: Text.PlainText
            text: "Nothing pinned yet. Focus a window and press L."
            color: Util.alpha(root.fg, 0.45)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            width: parent.width
          }
        }

        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.selectedHome !== null

          PanelSectionHeader {
            text: "Rules"
            foreground: root.fg
          }

          Toggle {
            width: parent.width
            label: root.selectedHome && root.selectedHome.arrive === "silent" ? "Arrive silently" : "Jump to workspace"
            description: "Silent leaves you where you were. Jump follows the new window."
            checked: root.selectedHome ? root.selectedHome.arrive === "silent" : false
            foreground: root.fg
            onClicked: root.toggleArrive()
          }

          Toggle {
            width: parent.width
            label: "Float"
            description: root.selectedHome && root.selectedHome.placement === "tile"
              ? "Forced tiled"
              : "Leave tiling to the workspace layout"
            checked: root.selectedHome ? root.selectedHome.placement === "float" : false
            foreground: root.fg
            onClicked: root.toggleFloat()
          }

          Toggle {
            width: parent.width
            label: "Opaque"
            description: "Skip Omarchy's default window transparency"
            checked: root.selectedHome ? root.selectedHome.opaque === true : false
            foreground: root.fg
            onClicked: root.toggleOpaque()
          }

          Toggle {
            width: parent.width
            label: "Hide from screen share"
            checked: root.selectedHome ? root.selectedHome.noScreenShare === true : false
            foreground: root.fg
            onClicked: root.toggleNoShare()
          }

          Toggle {
            width: parent.width
            label: root.selectedHome && root.selectedHome.idleInhibit !== "none"
              ? "Keep awake (" + root.selectedHome.idleInhibit + ")"
              : "Keep awake"
            description: "Inhibit idle while this window is open"
            checked: root.selectedHome ? root.selectedHome.idleInhibit !== "none" : false
            foreground: root.fg
            onClicked: root.cycleIdle()
          }

          PanelActionButton {
            iconText: root.armedDelete === (root.selectedHome ? root.selectedHome.id : "") ? "󰆴" : "󰅙"
            tooltipText: root.armedDelete === (root.selectedHome ? root.selectedHome.id : "")
              ? "Click again to forget"
              : "Forget this home"
            foreground: root.fg
            hoverColor: root.bar && root.bar.urgent ? root.bar.urgent : root.fg
            onClicked: root.forgetSelected()
          }
        }

        Column {
          width: parent.width
          spacing: Style.spacing.sm

          PanelSectionHeader {
            text: "Profiles"
            foreground: root.fg
          }

          Flow {
            width: parent.width
            spacing: Style.spacing.xs

            Repeater {
              model: root.config.profiles

              WidgetButton {
                required property var modelData
                bar: root.bar
                text: modelData.name
                active: modelData.name === root.activeProfileName
                onPressed: function() { root.activateProfile(modelData.name) }
              }
            }

            PanelActionButton {
              iconText: "＋"
              tooltipText: "Duplicate profile"
              foreground: root.fg
              onClicked: {
                root.creatingProfile = true
                profileInput.forceActiveFocus()
              }
            }
          }

          TextField {
            id: profileInput
            width: parent.width
            visible: root.creatingProfile
            placeholderText: "Profile name"
            text: root.newProfileDraft
            onTextChanged: root.newProfileDraft = text
            Keys.onReturnPressed: root.addProfile()
            Keys.onEnterPressed: root.addProfile()
            Keys.onEscapePressed: root.creatingProfile = false
          }
        }

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: root.showKeys
            ? "L learn  ·  1–0 workspace  ·  ← → move  ·  A silent  ·  F float  ·  O opaque  ·  S noshare  ·  I awake  ·  X forget  ·  N profile"
            : "Press ? for keys  ·  L pins the focused window  ·  click a workspace to send it home"
          color: Util.alpha(root.fg, 0.5)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}
