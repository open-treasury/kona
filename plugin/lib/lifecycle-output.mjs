const HOST_NAMES = {
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
};

const VERB_NAMES = {
  install: "Install",
  update: "Update",
  verify: "Verify",
  disable: "Disable",
  enable: "Enable",
  remove: "Remove",
};

const shellQuote = (argument) => `'${String(argument).replaceAll("'", `'"'"'`)}'`;
const sentence = (value) => (/[^.!?]$/.test(value) ? `${value}.` : value);
const target = ({ host, scope }) =>
  host && scope ? `${HOST_NAMES[host] || host} (${scope})` : HOST_NAMES[host] || host || null;

function successMessage(body) {
  const destination = target(body);
  const version = body.details?.version;
  if (body.verb === "install" && body.status === "unchanged")
    return `Already up to date: Kona v${version} for ${destination}.`;
  if (body.verb === "disable" && body.status === "unchanged")
    return `Already disabled: Kona for ${destination}.`;
  if (body.verb === "enable" && body.status === "unchanged")
    return `Already enabled: Kona for ${destination}.`;
  if (body.verb === "remove" && body.status === "absent")
    return `Already absent: Kona is not installed for ${destination}.`;

  if (body.verb === "install") return `Installed Kona v${version} for ${destination}.`;
  if (body.verb === "update") return `Updated Kona to v${version} for ${destination}.`;
  if (body.verb === "verify") return `Verified Kona v${version} for ${destination}.`;
  if (body.verb === "disable") return `Disabled Kona for ${destination}.`;
  if (body.verb === "enable") return `Enabled Kona for ${destination}.`;
  if (body.verb === "remove") return `Removed Kona from ${destination}.`;
  return sentence(body.message);
}

export function formatLifecycleHuman(body) {
  let output;
  if (body.ok) {
    output = successMessage(body);
  } else {
    const destination = target(body);
    const operation = VERB_NAMES[body.verb] || "Lifecycle operation";
    output = `${operation} refused${destination ? ` for ${destination}` : ""}: ${sentence(body.message)} [${body.code}]`;
  }

  if (body.code === "APPROVAL_REQUIRED" && Array.isArray(body.details?.plan)) {
    output += `\n${body.details.plan.map((command) => command.map(shellQuote).join(" ")).join("\n")}`;
  }
  return output;
}
