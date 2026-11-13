import { compatibilityReport, executableSizeTolerancePercent } from "@tm4/resources/compatibility";
import type { ResourceRow, ResourceStatus } from "@tm4/resources/compatibility";

import type { ResourcesStore } from "../state/resources.ts";
import { element } from "./dom.ts";

const labels: Record<ResourceStatus, string> = {
  pending: "Not checked",
  checking: "Checking…",
  compatible: "Compatible",
  warning: "Warning",
  uncompatible: "Uncompatible",
};
const names: Record<string, string> = {
  MAIN: "Initial registry",
  GAME: "Gameplay modules",
  MENU: "Menus",
  MOVIE: "Movie playback module",
  NEON: "Neon City",
  YARD: "The Junkyard",
  OIL: "Oil Rig",
  CARNI: "Carnival",
  AUGER: "Auger",
  CRUSHER: "Crusher",
  MINION: "Minion",
  PIRATE: "Captain Grimm",
  PIZZA: "Pizza Boy",
  ORBITAL: "Orbital",
  QUATRO: "Quatro",
  TANK: "General Warthog",
  SLAM: "Super Slamm",
  STOOTH: "Sweet Tooth",
  TRASH: "Trash Man",
  TOY: "Micro Blast",
};
const maps = new Set(["NEON", "YARD", "OIL", "CARNI", "AMAZ", "BED", "COMMUTE", "MAZE"]);
const cars = new Set([
  "AUGER",
  "AXEL",
  "CALYPSO",
  "CRUSHER",
  "DRAG",
  "GOGGLE",
  "MAID",
  "MINION",
  "MOON",
  "ORBITAL",
  "PIRATE",
  "PIZZA",
  "QUATRO",
  "RCCAR",
  "SLAM",
  "STOOTH",
  "TANK",
  "THUMP",
  "TOY",
  "TRASH",
  "WAGON",
  "ZOMBIE",
]);
function describe(id: string) {
  const file = id.split("/").at(-1)!;
  const stem = file.replace(/\.[^.]+$/, "");
  if (id.startsWith("AUDIO/"))
    return {
      group: "Audio tracks",
      name: `Track ${file}`,
      description: "CD audio · PCM after INDEX 01",
    };
  if (id === "/SCUS_945.60")
    return {
      group: "Core",
      name: file,
      description: `Required PS-X EXE · size tolerance ±${executableSizeTolerancePercent}%`,
    };
  if (/\.STR$/.test(id))
    return { group: "Video", name: file, description: "STR movie · raw CD sectors" };
  if (file.endsWith(".MR") && ["MAIN", "GAME", "MENU", "MOVIE"].includes(stem))
    return { group: "Core", name: file, description: names[stem]! };
  if (id.startsWith("/DATA/MENU/"))
    return { group: "Menu resources", name: file, description: "Menu asset" };
  if (maps.has(stem) || /^DMATCH\d+$/.test(stem))
    return { group: "Maps", name: file, description: names[stem] ?? "Map resources" };
  if (cars.has(stem))
    return { group: "Cars", name: file, description: names[stem] ?? "Car resources" };
  if (/^(CAD|DIAB|LRG|MED|MINI|SM|SUV|VAN|VETT)([ABC](OP)?|PA)$/.test(stem))
    return { group: "Create-a-Car", name: file, description: "Custom car resources" };
  return {
    group: "Other resources",
    name: file,
    description: /\.MR$/.test(id)
      ? "Resource archive"
      : /\.VAB$/.test(id)
        ? "Sound bank"
        : /\.(IMG|TIM)$/.test(id)
          ? "Image resources"
          : "Game asset",
  };
}
const groups = [
  "Core",
  "Maps",
  "Cars",
  "Create-a-Car",
  "Menu resources",
  "Other resources",
  "Video",
  "Audio tracks",
];
function bytes(size: number | undefined) {
  if (size === undefined) return "—";
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

export function initializeResources(store: ResourcesStore) {
  const panel = element("resources", HTMLDetailsElement);
  const list = element("resource-list", HTMLElement);
  const summary = element("resource-summary", HTMLElement);
  const notices = element("resource-notices", HTMLElement);
  const search = element("resource-search", HTMLInputElement);
  const issues = element("resource-issues", HTMLInputElement);
  const action = element("resource-check", HTMLButtonElement);
  const progress = element("resource-progress", HTMLProgressElement);
  const nodes = new Map<
    string,
    { node: HTMLElement; status: HTMLElement; info: HTMLElement; text: string; group: string }
  >();
  const sections = new Map<string, HTMLDetailsElement>();

  function show() {
    element("video-controls", HTMLElement).hidden = false;
    panel.hidden = false;
    panel.open = true;
  }

  function filter() {
    const { rows, issuesOnly, query: searchQuery } = store.getState();
    const query = searchQuery.trim().toLowerCase();
    for (const row of rows) {
      const entry = nodes.get(row.id)!;
      entry.node.hidden =
        !entry.text.includes(query) ||
        (issuesOnly && row.status !== "warning" && row.status !== "uncompatible");
    }
    for (const [group, section] of sections) {
      const visible = rows.filter(
        (row) => nodes.get(row.id)!.group === group && !nodes.get(row.id)!.node.hidden,
      ).length;
      section.hidden = visible === 0;
      section.querySelector("summary")!.textContent = `${group} (${visible})`;
      if (query || issuesOnly) section.open = true;
    }
  }
  function refreshRow(row: ResourceRow) {
    const entry = nodes.get(row.id)!;
    entry.status.textContent = labels[row.status];
    entry.node.dataset.status = row.status;
    entry.info.textContent = [row.id, `Size: ${bytes(row.size)}`, row.message]
      .filter(Boolean)
      .join("\n");
  }
  function refresh() {
    const { rows, phase } = store.getState();
    const running = phase === "checking";
    const count = (status: ResourceStatus) => rows.filter((row) => row.status === status).length;
    const checked = rows.length - count("pending") - count("checking");
    progress.max = rows.length || 1;
    progress.value = checked;
    const totals = (["compatible", "warning", "uncompatible"] as const)
      .filter((status) => count(status) > 0)
      .map((status) => `${count(status)} ${status}`);
    const report = compatibilityReport(rows);
    summary.textContent = `${labels[report.status]}\n${totals.join(" · ") || "Checking resources…"}\n${checked}/${rows.length} checked${!running && count("pending") ? " · paused" : ""}`;
    action.textContent = running
      ? "Pause checks"
      : count("pending")
        ? "Continue checks"
        : "Checks complete";
    action.disabled = !running && !count("pending");
    filter();
  }
  function populate(rows: ResourceRow[]) {
    nodes.clear();
    sections.clear();
    list.replaceChildren();
    for (const group of groups) {
      const section = document.createElement("details");
      section.className = "resource-group";
      section.open = group === "Core";
      const heading = document.createElement("summary");
      section.append(heading);
      list.append(section);
      sections.set(group, section);
    }
    for (const row of rows) {
      const description = describe(row.id);
      const node = document.createElement("details");
      node.className = "resource-row";
      const title = document.createElement("summary");
      const name = document.createElement("strong");
      name.textContent = description.name;
      const detail = document.createElement("span");
      detail.textContent = `${description.description} · ${bytes(row.size)}`;
      const status = document.createElement("span");
      status.className = "resource-state";
      const info = document.createElement("pre");
      title.append(name, detail, status);
      node.append(title, info);
      sections.get(description.group)!.append(node);
      nodes.set(row.id, {
        node,
        status,
        info,
        text: `${row.id} ${description.description}`.toLowerCase(),
        group: description.group,
      });
    }
    for (const row of rows) refreshRow(row);
  }
  function render(state: ReturnType<ResourcesStore["getState"]>, previous?: typeof state) {
    search.value = state.query;
    issues.checked = state.issuesOnly;
    notices.textContent = [...state.notices, state.error].filter(Boolean).join("\n");
    if (state.phase === "idle" || state.phase === "reading" || state.phase === "failed") {
      nodes.clear();
      sections.clear();
      list.replaceChildren();
      action.disabled = true;
      action.textContent = "Pause checks";
      summary.textContent =
        state.phase === "failed"
          ? "Could not read resource directory"
          : state.phase === "reading"
            ? "Reading disc directory…"
            : "";
      if (state.phase === "reading") progress.removeAttribute("value");
      else progress.value = 0;
      return;
    }
    if (state.rows.length !== nodes.size || state.rows.some((row) => !nodes.has(row.id)))
      populate(state.rows);
    else if (state.rows !== previous?.rows)
      state.rows.forEach((row, index) => {
        if (row !== previous?.rows[index]) refreshRow(row);
      });
    refresh();
  }
  render(store.getState());
  store.subscribe(render);
  action.addEventListener("click", () => {
    const state = store.getState();
    if (state.phase === "checking") state.pause();
    else state.resume();
  });
  search.addEventListener("input", () => store.getState().setQuery(search.value));
  issues.addEventListener("change", () => store.getState().setIssuesOnly(issues.checked));
  panel.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      panel.open = false;
      element("canvas", HTMLCanvasElement).focus();
    }
  });
  panel.addEventListener("keyup", (event) => event.stopPropagation());
  return { show };
}
