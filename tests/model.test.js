const test = require("node:test")
const assert = require("node:assert/strict")
const childProcess = require("node:child_process")
const Model = require("../Model.js")

function luaAvailable() {
  const probe = childProcess.spawnSync("lua", ["-v"], { encoding: "utf8" })
  return !probe.error && probe.status === 0
}

function runLua(source) {
  const result = childProcess.spawnSync("lua", ["-"], { input: source, encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`lua exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

const hasLua = luaAvailable()

// ---------------------------------------------------------------- matching

test("literal class names become anchored RE2 patterns", () => {
  assert.equal(Model.classPattern("foot"), "^foot$")
  assert.equal(Model.classPattern("org.telegram.desktop"), "^org\\.telegram\\.desktop$")
  assert.equal(Model.classPattern("^brave-.*"), "^brave-.*")
})

test("a dotted class does not match a neighbour", () => {
  const home = Model.normalizeHome({ class: "org.telegram.desktop" })
  assert.equal(Model.homeMatchesClient(home, { initialClass: "org.telegram.desktop" }), true)
  assert.equal(Model.homeMatchesClient(home, { initialClass: "orgXtelegramYdesktop" }), false)
  assert.equal(Model.homeMatchesClient(home, { initialClass: "telegram" }), false)
})

test("an optional title match is more specific than class-only", () => {
  const config = Model.normalizeConfig({
    profiles: [{
      name: "default",
      homes: [
        { class: "brave-origin", workspace: 2 },
        { class: "brave-origin", title: "Gmail", workspace: 4 }
      ]
    }]
  })
  const gmail = Model.findHomeForClient(config, {
    initialClass: "brave-origin",
    initialTitle: "Gmail",
    title: "Gmail"
  })
  const other = Model.findHomeForClient(config, {
    initialClass: "brave-origin",
    initialTitle: "New Tab",
    title: "New Tab"
  })
  assert.equal(gmail.workspace, 4)
  assert.equal(other.workspace, 2)
})

test("workspace ids are integers 1-99 or null", () => {
  assert.equal(Model.normalizeWorkspaceId("4"), 4)
  assert.equal(Model.normalizeWorkspaceId(10), 10)
  assert.equal(Model.normalizeWorkspaceId(0), null)
  assert.equal(Model.normalizeWorkspaceId("special:scratchpad"), null)
  assert.equal(Model.normalizeHome({ class: "x", workspace: "" }).workspace, null)
})

// ----------------------------------------------------------------- clients

test("parseClients skips hidden windows and prefers focusHistoryID 0", () => {
  const clients = Model.parseClients(JSON.stringify([
    { class: "foot", initialClass: "foot", title: "term", workspace: { id: 2 }, mapped: true, hidden: false, focusHistoryID: 1 },
    { class: "brave-origin", initialClass: "brave-origin", title: "Mail", workspace: { id: 1 }, mapped: true, hidden: false, focusHistoryID: 0 },
    { class: "gone", initialClass: "gone", title: "x", workspace: { id: 3 }, mapped: true, hidden: true, focusHistoryID: 2 }
  ]))
  assert.equal(clients.length, 2)
  assert.equal(Model.focusedClient(clients).initialClass, "brave-origin")
})

test("a single activewindow object parses as one client", () => {
  const clients = Model.parseClients(JSON.stringify({
    class: "foot",
    initialClass: "foot",
    title: "foot",
    workspace: { id: 3 },
    mapped: true,
    hidden: false,
    focusHistoryID: 0
  }))
  assert.equal(clients.length, 1)
  assert.equal(clients[0].workspace, 3)
})

test("garbage JSON degrades to an empty list", () => {
  assert.deepEqual(Model.parseClients("not json"), [])
  assert.deepEqual(Model.parseClients(""), [])
})

test("homeFromClient copies the window's class and workspace", () => {
  const home = Model.homeFromClient({
    initialClass: "Slack",
    class: "Slack",
    title: "Slack | omarchy",
    workspace: 4,
    floating: false
  })
  assert.equal(home.class, "Slack")
  assert.equal(home.workspace, 4)
  assert.equal(home.placement, "default")
  assert.equal(home.title, "")
})

// ------------------------------------------------------------------ config

test("an empty document becomes a default profile with no homes", () => {
  const config = Model.normalizeConfig(null)
  assert.equal(config.activeProfile, "default")
  assert.equal(config.profiles.length, 1)
  assert.equal(config.profiles[0].homes.length, 0)
})

test("malformed homes are dropped rather than crashing", () => {
  const config = Model.normalizeConfig({
    profiles: [{ name: "work", homes: [{}, { class: "foot", workspace: 2 }, { class: "" }] }]
  })
  assert.equal(config.profiles[0].homes.length, 1)
  assert.equal(config.profiles[0].homes[0].class, "foot")
})

test("upsertHome replaces a home with the same class and title", () => {
  let config = Model.defaultConfig()
  config = Model.upsertHome(config, { class: "foot", workspace: 2 })
  config = Model.upsertHome(config, { class: "foot", workspace: 3, arrive: "silent" })
  assert.equal(config.profiles[0].homes.length, 1)
  assert.equal(config.profiles[0].homes[0].workspace, 3)
  assert.equal(config.profiles[0].homes[0].arrive, "silent")
})

test("removeHome deletes only the named home", () => {
  let config = Model.defaultConfig()
  config = Model.upsertHome(config, { class: "foot", workspace: 1 })
  config = Model.upsertHome(config, { class: "Slack", workspace: 4 })
  const slack = config.profiles[0].homes.find((home) => home.class === "Slack")
  config = Model.removeHome(config, slack.id)
  assert.equal(config.profiles[0].homes.length, 1)
  assert.equal(config.profiles[0].homes[0].class, "foot")
})

test("serializeConfig drops derived regex fields so the JSON stays editable", () => {
  const config = Model.upsertHome(Model.defaultConfig(), { class: "org.telegram.desktop", workspace: 3 })
  const saved = Model.serializeConfig(config)
  assert.equal("classPattern" in saved.profiles[0].homes[0], false)
  assert.equal(saved.profiles[0].homes[0].class, "org.telegram.desktop")
  const roundTrip = Model.normalizeConfig(saved)
  assert.equal(roundTrip.profiles[0].homes[0].classPattern, "^org\\.telegram\\.desktop$")
})

test("duplicate profile names are repaired", () => {
  const config = Model.normalizeConfig({
    profiles: [{ name: "work" }, { name: "work" }]
  })
  assert.equal(config.profiles[0].name, "work")
  assert.equal(config.profiles[1].name, "work 2")
})

// ------------------------------------------------------------------- rules

test("silent arrival suffixes the workspace effect", () => {
  const jump = Model.ruleFields({ class: "Slack", workspace: 4, arrive: "jump" })
  const silent = Model.ruleFields({ class: "Slack", workspace: 4, arrive: "silent" })
  const nowhere = Model.ruleFields({ class: "Slack", workspace: null })
  assert.equal(jump.workspace, "4")
  assert.equal(silent.workspace, "4 silent")
  assert.equal(nowhere.workspace, null)
})

test("placement and flags only emit when set", () => {
  const plain = Model.ruleFields({ class: "foot", workspace: 1 })
  assert.equal(plain.float, null)
  assert.equal(plain.tile, null)
  assert.equal(plain.opaque, null)
  assert.equal(plain.idle_inhibit, null)

  const fancy = Model.ruleFields({
    class: "mpv",
    placement: "float",
    center: true,
    opaque: true,
    noScreenShare: true,
    idleInhibit: "focus"
  })
  assert.equal(fancy.float, true)
  assert.equal(fancy.center, true)
  assert.equal(fancy.opaque, true)
  assert.equal(fancy.no_screen_share, true)
  assert.equal(fancy.idle_inhibit, "focus")
})

test("evalPayload never starts with a dash", () => {
  const lua = Model.generateLua(Model.defaultConfig())
  const payload = Model.evalPayload(lua)
  assert.equal(payload.charAt(0), "d")
  assert.ok(payload.startsWith("do\n"))
  assert.ok(Model.hyprctlEvalArgs(lua)[2].startsWith("do"))
})

test("the loader line is guarded and idempotent", () => {
  const empty = ""
  const once = Model.withLoader(empty)
  const twice = Model.withLoader(once)
  assert.equal(Model.needsLoader(empty), true)
  assert.equal(Model.needsLoader(once), false)
  assert.equal(once, twice)
  assert.ok(once.includes("io.open(path"))
})

test("generated Lua names every rule and prunes the rest", () => {
  const config = Model.upsertHome(Model.defaultConfig(), {
    class: "Slack",
    workspace: 4,
    arrive: "silent",
    opaque: true
  })
  const lua = Model.generateLua(config)
  assert.ok(lua.includes('name = "omarchy-ah-slack"'))
  assert.ok(lua.includes('class = "^Slack$"'))
  assert.ok(lua.includes('workspace = "4 silent"'))
  assert.ok(lua.includes("opaque = true"))
  assert.ok(lua.includes('H.prune({ "slack" })'))
})

test("forgetting a home prunes it from the generated Lua", () => {
  let config = Model.upsertHome(Model.defaultConfig(), { class: "foot", workspace: 1 })
  config = Model.upsertHome(config, { class: "Slack", workspace: 4 })
  const slack = config.profiles[0].homes.find((home) => home.class === "Slack")
  config = Model.removeHome(config, slack.id)
  const lua = Model.generateLua(config)
  assert.ok(lua.includes("^foot$"))
  assert.equal(lua.includes("^Slack$"), false)
  assert.ok(lua.includes('H.prune({ "foot" })'))
})

test("describeHome is a short readable summary", () => {
  const text = Model.describeHome({
    class: "Slack",
    workspace: 4,
    arrive: "silent",
    placement: "float",
    opaque: true
  })
  assert.ok(text.includes("workspace 4 silent"))
  assert.ok(text.includes("float"))
  assert.ok(text.includes("opaque"))
})

test("barLabel uses 0 for workspace 10", () => {
  assert.equal(Model.barLabel({ workspace: 4 }), "4")
  assert.equal(Model.barLabel({ workspace: 10 }), "0")
  assert.equal(Model.barLabel({ workspace: null }), "")
})

// ------------------------------------------------------- lua interpreter

test("generated Lua loads in a plain interpreter and registers named rules", { skip: !hasLua }, () => {
  const config = Model.upsertHome(Model.defaultConfig(), {
    class: "org.telegram.desktop",
    workspace: 5,
    arrive: "silent",
    placement: "float",
    center: true,
    idleInhibit: "focus"
  })
  const prelude = [
    "captured = {}",
    "hl = { window_rule = function(spec)",
    "  captured[#captured+1] = spec",
    "  return { set_enabled = function() end }",
    "end }",
    Model.generateLua(config),
    'local s = captured[1]',
    'assert(s, "no rule captured")',
    'assert(s.name == "omarchy-ah-org-telegram-desktop")',
    'assert(s.match.class == "^org\\\\.telegram\\\\.desktop$")',
    'assert(s.workspace == "5 silent")',
    'assert(s.float == true)',
    'assert(s.center == true)',
    'assert(s.idle_inhibit == "focus")',
    'print("ok")'
  ].join("\n")

  const out = runLua(prelude).trim()
  assert.equal(out, "ok")
})

test("H.prune disables rules that are no longer in the profile", { skip: !hasLua }, () => {
  const withSlack = Model.upsertHome(Model.defaultConfig(), { class: "Slack", workspace: 4 })
  const empty = Model.defaultConfig()
  const source = [
    "disabled = {}",
    "hl = { window_rule = function(spec)",
    "  return { set_enabled = function(_, on) if on == false then disabled[#disabled+1] = spec.name end end }",
    "end }",
    Model.generateLua(withSlack),
    Model.generateLua(empty),
    'assert(#disabled >= 1, "expected prune to disable the slack rule")',
    'print("ok")'
  ].join("\n")
  assert.equal(runLua(source).trim(), "ok")
})
