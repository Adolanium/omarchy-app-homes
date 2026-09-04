import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The bar button. A house, with the focused window's home workspace number
// overlaid when it has one — so the bar answers "where does this app live?"
// without being clicked.
BarWidget {
  id: root
  moduleName: "adolanium.app-homes"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property var focusedHome: panelLoader.item ? panelLoader.item.focusedHome : null
  readonly property string focusedClass: panelLoader.item ? panelLoader.item.focusedClass : ""
  readonly property string activeProfileName: panelLoader.item ? panelLoader.item.activeProfileName : ""
  readonly property string homeLabel: Model.barLabel(focusedHome)
  readonly property bool hasHome: focusedHome !== null && focusedHome !== undefined

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰋜"
    tooltipText: {
      var who = root.focusedClass !== "" ? root.focusedClass : "No focused window"
      var where = root.hasHome ? Model.describeHome(root.focusedHome) : "no home yet — click to pin"
      var profile = root.activeProfileName !== "" ? " · " + root.activeProfileName : ""
      return who + " · " + where + profile
    }

    iconComponent: Component {
      Item {
        Text {
          anchors.centerIn: parent
          text: "󰋜"
          color: button.foreground
          opacity: root.hasHome ? 1 : 0.45
          font.family: button.fontFamily
          font.pixelSize: Math.round(parent.width * 0.78)
        }
        Text {
          visible: root.homeLabel !== ""
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.rightMargin: -1
          anchors.bottomMargin: -2
          textFormat: Text.PlainText
          text: root.homeLabel
          color: button.foreground
          font.family: button.fontFamily
          font.pixelSize: Math.max(8, Math.round(parent.width * 0.42))
          font.bold: true
        }
      }
    }

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.LeftButton) root.togglePanel()
    }
  }
}
