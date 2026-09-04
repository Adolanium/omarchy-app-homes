// Pure logic for App Homes: the config document, client matching, and the
// Lua that registers Hyprland window rules.
//
// Nothing in here imports QML or touches the filesystem, so `node --test`
// exercises the same code the panel runs.

// --------------------------------------------------------------- constants

var MAX_HOMES = 80
var MAX_PROFILES = 24
var RULE_PREFIX = "omarchy-ah-"

var PLACEMENTS = ["default", "tile", "float"]
var ARRIVALS = ["jump", "silent"]
var IDLE_MODES = ["none", "focus", "always", "fullscreen"]

// ------------------------------------------------------------------ number

function isFiniteNumber(value) {
  var n = Number(value)
  return typeof n === "number" && isFinite(n)
}

function clamp(value, low, high) {
  if (!isFiniteNumber(value)) return low
  return Math.min(high, Math.max(low, Number(value)))
}

// ----------------------------------------------------------------- strings

function sanitizeName(value, fallback) {
  var name = String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^ +| +$/g, "")
    .slice(0, 48)
    .replace(/ +$/, "")
  return name.length > 0 ? name : fallback
}

function slugify(name) {
  var slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug.length > 0 ? slug : "app"
}

function uniqueId(taken, base) {
  var slug = slugify(base)
  if (!taken[slug]) return slug
  var suffix = 2
  while (taken[slug + "-" + suffix]) suffix++
  return slug + "-" + suffix
}

// Hyprland window-rule matchers are Google RE2. Escape a literal class or
// title so `org.telegram.desktop` matches that class, not "orgXtelegramY…".
function escapeRe2(value) {
  return String(value).replace(/[\\.^$|?*+()[\]{}]/g, "\\$&")
}

// A class field is a literal unless the user started it with `^`, in which
// case it is already a pattern they wrote by hand.
function classPattern(className) {
  var s = String(className || "")
  if (s.length === 0) return ""
  if (s.charAt(0) === "^") return s.slice(0, 120)
  return "^" + escapeRe2(s) + "$"
}

function titlePattern(title) {
  var s = String(title || "")
  if (s.length === 0) return ""
  if (s.charAt(0) === "^") return s.slice(0, 160)
  return "^" + escapeRe2(s) + "$"
}

function patternMatches(pattern, value) {
  if (!pattern) return true
  try {
    return new RegExp(pattern).test(String(value || ""))
  } catch (error) {
    return false
  }
}

// ----------------------------------------------------------------- clients

function normalizeWorkspaceId(value) {
  var n = Number(value)
  if (!isFiniteNumber(n)) return null
  n = Math.round(n)
  if (n < 1 || n > 99) return null
  return n
}

function normalizeClient(raw) {
  if (!raw || typeof raw !== "object") return null
  var initialClass = String(raw.initialClass || raw.class || "")
  var className = String(raw.class || initialClass)
  if (!className && !initialClass) return null

  var workspace = 0
  if (raw.workspace && typeof raw.workspace === "object") {
    workspace = Number(raw.workspace.id) || 0
  } else if (isFiniteNumber(raw.workspace)) {
    workspace = Number(raw.workspace)
  }

  return {
    address: String(raw.address || ""),
    class: className,
    initialClass: initialClass || className,
    title: String(raw.title || ""),
    initialTitle: String(raw.initialTitle || ""),
    workspace: workspace,
    floating: raw.floating === true,
    mapped: raw.mapped !== false,
    hidden: raw.hidden === true,
    focusHistoryID: isFiniteNumber(raw.focusHistoryID) ? Number(raw.focusHistoryID) : 99
  }
}

function parseClients(raw) {
  var data
  try {
    data = JSON.parse(String(raw || "[]"))
  } catch (error) {
    return []
  }

  var list = []
  if (data instanceof Array) {
    list = data
  } else if (data && typeof data === "object") {
    list = [data]
  }

  var out = []
  var seen = {}
  for (var i = 0; i < list.length; i++) {
    var client = normalizeClient(list[i])
    if (!client || client.hidden || !client.mapped) continue
    var key = client.address || (client.initialClass + "\n" + client.title)
    if (seen[key]) continue
    seen[key] = true
    out.push(client)
  }

  out.sort(function(a, b) {
    if (a.focusHistoryID !== b.focusHistoryID) return a.focusHistoryID - b.focusHistoryID
    if (a.workspace !== b.workspace) return a.workspace - b.workspace
    return a.initialClass.localeCompare(b.initialClass)
  })
  return out
}

function focusedClient(clients) {
  var list = clients instanceof Array ? clients : []
  for (var i = 0; i < list.length; i++) {
    if (list[i].focusHistoryID === 0) return list[i]
  }
  return list.length > 0 ? list[0] : null
}

function displayNameForClient(client) {
  if (!client) return ""
  var title = String(client.title || "").replace(/\s+/g, " ").replace(/^ +| +$/g, "")
  if (title.length > 0 && title.length <= 42 && title.toLowerCase() !== client.initialClass.toLowerCase()) {
    return title
  }
  return client.initialClass || client.class || "Window"
}

// ------------------------------------------------------------------- home

function normalizeIdleInhibit(value) {
  var mode = String(value || "none")
  return IDLE_MODES.indexOf(mode) >= 0 ? mode : "none"
}

function normalizePlacement(value) {
  var placement = String(value || "default")
  return PLACEMENTS.indexOf(placement) >= 0 ? placement : "default"
}

function normalizeArrive(value) {
  var arrive = String(value || "jump")
  return ARRIVALS.indexOf(arrive) >= 0 ? arrive : "jump"
}

function normalizeHome(raw, taken) {
  var input = (raw && typeof raw === "object") ? raw : {}
  var className = String(input.class || "").replace(/[\u0000-\u001f\u007f]+/g, "").slice(0, 120)
  var title = String(input.title || "").replace(/[\u0000-\u001f\u007f]+/g, "").slice(0, 160)
  var idBase = input.id || className || input.name || "app"
  var id = slugify(idBase)
  if (taken) {
    id = uniqueId(taken, idBase)
    taken[id] = true
  }

  var workspace = input.workspace === null || input.workspace === undefined || input.workspace === ""
    ? null
    : normalizeWorkspaceId(input.workspace)

  return {
    id: id,
    name: sanitizeName(input.name || className || id, "App"),
    class: className,
    title: title,
    classPattern: classPattern(className),
    titlePattern: titlePattern(title),
    workspace: workspace,
    arrive: normalizeArrive(input.arrive),
    placement: normalizePlacement(input.placement),
    center: input.center === true,
    opaque: input.opaque === true,
    noScreenShare: input.noScreenShare === true,
    idleInhibit: normalizeIdleInhibit(input.idleInhibit)
  }
}

function homeFromClient(client, existing) {
  var source = client || {}
  var className = source.initialClass || source.class || ""
  var draft = {
    class: className,
    title: "",
    name: displayNameForClient(source),
    workspace: normalizeWorkspaceId(source.workspace),
    arrive: "jump",
    placement: source.floating ? "float" : "default",
    center: false,
    opaque: false,
    noScreenShare: false,
    idleInhibit: "none"
  }
  return normalizeHome(draft, existing ? null : {})
}

function homeMatchesClient(home, client) {
  if (!home || !client) return false
  var className = client.initialClass || client.class || ""
  if (!patternMatches(home.classPattern, className)) return false
  if (home.titlePattern && !patternMatches(home.titlePattern, client.initialTitle || client.title || "")) {
    return false
  }
  return true
}

function findHomeForClient(config, client) {
  var homes = activeHomes(config)
  var titled = []
  var classOnly = []
  for (var i = 0; i < homes.length; i++) {
    if (!homeMatchesClient(homes[i], client)) continue
    if (homes[i].titlePattern) titled.push(homes[i])
    else classOnly.push(homes[i])
  }
  return titled.length > 0 ? titled[0] : (classOnly.length > 0 ? classOnly[0] : null)
}

function describeHome(home) {
  if (!home) return "no home"
  var spec = normalizeHome(home)
  var parts = []
  if (spec.workspace !== null) {
    parts.push("workspace " + spec.workspace + (spec.arrive === "silent" ? " silent" : ""))
  } else {
    parts.push("this workspace")
  }
  if (spec.placement !== "default") parts.push(spec.placement)
  if (spec.opaque) parts.push("opaque")
  if (spec.noScreenShare) parts.push("no share")
  if (spec.idleInhibit !== "none") parts.push("awake:" + spec.idleInhibit)
  return parts.join(" · ")
}

function barLabel(home) {
  if (!home || home.workspace === null) return ""
  return home.workspace === 10 ? "0" : String(home.workspace)
}

// ----------------------------------------------------------------- config

function normalizeProfile(raw, takenNames) {
  var input = (raw && typeof raw === "object") ? raw : {}
  var name = sanitizeName(input.name, "default")
  if (takenNames) {
    if (takenNames[name]) {
      var suffix = 2
      while (takenNames[name + " " + suffix]) suffix++
      name = name + " " + suffix
    }
    takenNames[name] = true
  }

  var homes = []
  var takenIds = {}
  var rawHomes = (input.homes instanceof Array) ? input.homes : []
  for (var i = 0; i < rawHomes.length && homes.length < MAX_HOMES; i++) {
    var home = normalizeHome(rawHomes[i], takenIds)
    if (!home.class) continue
    homes.push(home)
  }

  return { name: name, homes: homes }
}

function defaultConfig() {
  return normalizeConfig({
    version: 1,
    activeProfile: "default",
    profiles: [{ name: "default", homes: [] }]
  })
}

function normalizeConfig(raw) {
  var input = (raw && typeof raw === "object") ? raw : {}
  var takenNames = {}
  var profiles = []
  var rawProfiles = (input.profiles instanceof Array) ? input.profiles : []
  for (var i = 0; i < rawProfiles.length && profiles.length < MAX_PROFILES; i++) {
    profiles.push(normalizeProfile(rawProfiles[i], takenNames))
  }
  if (profiles.length === 0) {
    profiles = [normalizeProfile({ name: "default", homes: [] }, {})]
  }

  var active = String(input.activeProfile || "")
  if (!takenNames[active]) active = profiles[0].name

  return {
    version: 1,
    activeProfile: active,
    profiles: profiles
  }
}

function findProfile(config, name) {
  var profiles = (config && config.profiles instanceof Array) ? config.profiles : []
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].name === String(name)) return profiles[i]
  }
  return null
}

function activeProfile(config) {
  return findProfile(config, config && config.activeProfile) ||
    ((config && config.profiles instanceof Array && config.profiles.length > 0)
      ? config.profiles[0]
      : normalizeProfile({ name: "default" }, {}))
}

function activeHomes(config) {
  var profile = activeProfile(config)
  return profile && profile.homes instanceof Array ? profile.homes : []
}

function findHome(config, id) {
  var homes = activeHomes(config)
  for (var i = 0; i < homes.length; i++) {
    if (homes[i].id === String(id)) return homes[i]
  }
  return null
}

function uniqueProfileName(config, base) {
  var name = sanitizeName(base, "profile")
  if (!findProfile(config, name)) return name
  var suffix = 2
  while (findProfile(config, name + " " + suffix)) suffix++
  return name + " " + suffix
}

function uniqueHomeId(config, base) {
  var taken = {}
  var homes = activeHomes(config)
  for (var i = 0; i < homes.length; i++) taken[homes[i].id] = true
  return uniqueId(taken, base)
}

function upsertHome(config, home) {
  var draft = normalizeConfig(config)
  var profile = activeProfile(draft)
  var incoming = normalizeHome(home, null)
  if (!incoming.class) return draft

  var replaced = false
  for (var i = 0; i < profile.homes.length; i++) {
    if (profile.homes[i].id === incoming.id ||
        (profile.homes[i].class === incoming.class && profile.homes[i].title === incoming.title)) {
      incoming.id = profile.homes[i].id
      profile.homes[i] = incoming
      replaced = true
      break
    }
  }
  if (!replaced) {
    var taken = {}
    for (i = 0; i < profile.homes.length; i++) taken[profile.homes[i].id] = true
    incoming.id = uniqueId(taken, incoming.id || incoming.class)
    profile.homes.push(incoming)
  }
  return draft
}

function removeHome(config, id) {
  var draft = normalizeConfig(config)
  var profile = activeProfile(draft)
  var next = []
  for (var i = 0; i < profile.homes.length; i++) {
    if (profile.homes[i].id !== String(id)) next.push(profile.homes[i])
  }
  profile.homes = next
  return draft
}

function setActiveProfile(config, name) {
  var draft = normalizeConfig(config)
  if (findProfile(draft, name)) draft.activeProfile = String(name)
  return draft
}

function serializeHome(home) {
  var spec = normalizeHome(home)
  return {
    id: spec.id,
    name: spec.name,
    class: spec.class,
    title: spec.title,
    workspace: spec.workspace,
    arrive: spec.arrive,
    placement: spec.placement,
    center: spec.center,
    opaque: spec.opaque,
    noScreenShare: spec.noScreenShare,
    idleInhibit: spec.idleInhibit
  }
}

function serializeConfig(config) {
  var normalized = normalizeConfig(config)
  return {
    version: 1,
    activeProfile: normalized.activeProfile,
    profiles: normalized.profiles.map(function(profile) {
      return {
        name: profile.name,
        homes: profile.homes.map(serializeHome)
      }
    })
  }
}

// --------------------------------------------------------------------- lua

function luaString(value) {
  return '"' + String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r") + '"'
}

function luaBool(value) {
  return value ? "true" : "false"
}

function ruleName(id) {
  return RULE_PREFIX + slugify(id)
}

function workspaceEffect(home) {
  if (!home || home.workspace === null || home.workspace === undefined) return null
  var ws = String(home.workspace)
  return home.arrive === "silent" ? ws + " silent" : ws
}

// The fields Hyprland will see for one home. Tests assert against this
// rather than scraping generated Lua.
function ruleFields(home) {
  var spec = normalizeHome(home)
  var fields = {
    name: ruleName(spec.id),
    classPattern: spec.classPattern,
    titlePattern: spec.titlePattern || null,
    workspace: workspaceEffect(spec),
    float: spec.placement === "float" ? true : null,
    tile: spec.placement === "tile" ? true : null,
    center: spec.placement === "float" && spec.center ? true : null,
    opaque: spec.opaque ? true : null,
    no_screen_share: spec.noScreenShare ? true : null,
    idle_inhibit: spec.idleInhibit !== "none" ? spec.idleInhibit : null
  }
  return fields
}

function homeRuleLua(home) {
  var spec = normalizeHome(home)
  if (!spec.classPattern) return ""

  var lines = []
  lines.push("H.set(" + luaString(spec.id) + ", {")
  lines.push("  name = " + luaString(ruleName(spec.id)) + ",")
  lines.push("  match = {")
  lines.push("    class = " + luaString(spec.classPattern) + ",")
  if (spec.titlePattern) {
    lines.push("    title = " + luaString(spec.titlePattern) + ",")
  }
  lines.push("  },")

  var workspace = workspaceEffect(spec)
  if (workspace) lines.push("  workspace = " + luaString(workspace) + ",")
  if (spec.placement === "float") lines.push("  float = true,")
  if (spec.placement === "tile") lines.push("  tile = true,")
  if (spec.placement === "float" && spec.center) lines.push("  center = true,")
  if (spec.opaque) lines.push("  opaque = true,")
  if (spec.noScreenShare) lines.push("  no_screen_share = true,")
  if (spec.idleInhibit !== "none") lines.push("  idle_inhibit = " + luaString(spec.idleInhibit) + ",")
  lines.push("})")
  return lines.join("\n")
}

var LUA_RUNTIME = [
  "local H = _G.__omarchy_ah",
  "if not H then H = { rules = {} }; _G.__omarchy_ah = H end",
  "",
  "-- Named rules can be disabled. Workspace rules accumulate in Hyprland, and",
  "-- window rules would too if we registered a second copy under a new handle",
  "-- every reload — so keep the handle and retire the previous one first.",
  "function H.set(id, spec)",
  "  local previous = H.rules[id]",
  "  if previous then pcall(function() previous:set_enabled(false) end) end",
  "  H.rules[id] = hl.window_rule(spec)",
  "end",
  "",
  "function H.prune(keep)",
  "  local kept = {}",
  "  for i = 1, #keep do kept[keep[i]] = true end",
  "  for id, handle in pairs(H.rules) do",
  "    if not kept[id] then",
  "      pcall(function() handle:set_enabled(false) end)",
  "      H.rules[id] = nil",
  "    end",
  "  end",
  "end"
].join("\n")

function generateLua(config) {
  var normalized = normalizeConfig(config)
  var homes = activeHomes(normalized)
  var profile = activeProfile(normalized)
  var lines = [
    "-- Generated by the Omarchy App Homes plugin. Do not edit.",
    "-- Your homes and profiles live in ~/.config/omarchy/app-homes.json;",
    "-- this file is rewritten from that document every time it changes.",
    "--",
    "-- Active profile: " + profile.name,
    "",
    LUA_RUNTIME,
    ""
  ]

  var ids = []
  for (var i = 0; i < homes.length; i++) {
    if (!homes[i].classPattern) continue
    lines.push(homeRuleLua(homes[i]))
    lines.push("")
    ids.push(homes[i].id)
  }

  var keep = []
  for (i = 0; i < ids.length; i++) keep.push(luaString(ids[i]))
  lines.push("H.prune({ " + keep.join(", ") + " })")
  lines.push("")
  return lines.join("\n")
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

// hyprctl parses an argument that starts with "-" as a flag, and Lua comments
// start with "--". Wrap the payload in a do-block so the first character is
// always a letter, matching the Workspace Layout plugin's workaround.
function evalPayload(lua) {
  return "do\n" + String(lua) + "\nend"
}

function hyprctlEvalArgs(lua) {
  return ["hyprctl", "eval", evalPayload(lua)]
}

function focusWorkspaceCommand(workspaceId) {
  return "hyprctl dispatch " +
    shellQuote('hl.dsp.focus({ workspace = "' + String(workspaceId) + '" })')
}

// ------------------------------------------------------------------ loader

var LOADER_MARKER = "omarchy-app-homes.lua"

function loaderLine() {
  return "-- Added by the Omarchy App Homes plugin: registers its window rules.\n" +
    "do local path = (os.getenv(\"XDG_CONFIG_HOME\") or os.getenv(\"HOME\") .. \"/.config\") .. " +
    "\"/hypr/omarchy-app-homes.lua\"; local file = io.open(path, \"r\"); " +
    "if file then file:close(); dofile(path) end end"
}

function needsLoader(hyprlandLua) {
  return String(hyprlandLua || "").indexOf(LOADER_MARKER) === -1
}

function withLoader(hyprlandLua) {
  var text = String(hyprlandLua || "")
  if (!needsLoader(text)) return text
  var separator = text.length === 0 || /\n\s*$/.test(text) ? "\n" : "\n\n"
  return text + separator + loaderLine() + "\n"
}

// ------------------------------------------------------------------ exports

if (typeof module !== "undefined") {
  module.exports = {
    MAX_HOMES: MAX_HOMES,
    MAX_PROFILES: MAX_PROFILES,
    RULE_PREFIX: RULE_PREFIX,
    PLACEMENTS: PLACEMENTS,
    ARRIVALS: ARRIVALS,
    IDLE_MODES: IDLE_MODES,
    LUA_RUNTIME: LUA_RUNTIME,
    sanitizeName: sanitizeName,
    slugify: slugify,
    uniqueId: uniqueId,
    escapeRe2: escapeRe2,
    classPattern: classPattern,
    titlePattern: titlePattern,
    patternMatches: patternMatches,
    normalizeWorkspaceId: normalizeWorkspaceId,
    normalizeClient: normalizeClient,
    parseClients: parseClients,
    focusedClient: focusedClient,
    displayNameForClient: displayNameForClient,
    normalizeHome: normalizeHome,
    homeFromClient: homeFromClient,
    homeMatchesClient: homeMatchesClient,
    findHomeForClient: findHomeForClient,
    describeHome: describeHome,
    barLabel: barLabel,
    normalizeProfile: normalizeProfile,
    defaultConfig: defaultConfig,
    normalizeConfig: normalizeConfig,
    findProfile: findProfile,
    activeProfile: activeProfile,
    activeHomes: activeHomes,
    findHome: findHome,
    uniqueProfileName: uniqueProfileName,
    uniqueHomeId: uniqueHomeId,
    upsertHome: upsertHome,
    removeHome: removeHome,
    setActiveProfile: setActiveProfile,
    serializeHome: serializeHome,
    serializeConfig: serializeConfig,
    luaString: luaString,
    ruleName: ruleName,
    workspaceEffect: workspaceEffect,
    ruleFields: ruleFields,
    homeRuleLua: homeRuleLua,
    generateLua: generateLua,
    shellQuote: shellQuote,
    evalPayload: evalPayload,
    hyprctlEvalArgs: hyprctlEvalArgs,
    focusWorkspaceCommand: focusWorkspaceCommand,
    loaderLine: loaderLine,
    needsLoader: needsLoader,
    withLoader: withLoader
  }
}
