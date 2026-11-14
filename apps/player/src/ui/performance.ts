import type { NetworkPort } from "@tm4/game-runtime/network/protocol";
import type { GameModule } from "@tm4/game-runtime/runtime/module";

import type { RenderingStore } from "../state/rendering.ts";
import { element } from "./dom.ts";
import { networkLatency } from "./network-latency.ts";

const sampleInterval = 250;
const historyDuration = 15_000;
const graphWidth = 240;
const graphHeight = 36;
const svgNamespace = "http://www.w3.org/2000/svg";

type Sample = { time: number; rates: number[] };

export function initializePerformance(module: GameModule, store: RenderingStore) {
  const checkbox = element("render-fps", HTMLInputElement);
  const panel = element("fps-counter", HTMLElement);
  const ping = element("network-latency", HTMLOutputElement);
  const definitions = [
    ["Simulation", "TPS", "Completed world simulation steps; zero in menus and while paused."],
    [
      "Render",
      "FPS",
      "Game ordering-table submissions, including menus; not physical screen presentations.",
    ],
    [
      "Browser",
      "callbacks/s",
      "requestAnimationFrame callbacks; not proof that a frame reached the screen.",
    ],
  ] as const;
  const rows = definitions.map(([label, unit, description]) => {
    const row = document.createElement("div");
    row.className = "performance-row";
    row.title = description;
    const heading = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("output");
    value.textContent = `— ${unit}`;
    heading.append(name, value);
    const graph = document.createElementNS(svgNamespace, "svg");
    graph.setAttribute("viewBox", `0 0 ${graphWidth} ${graphHeight}`);
    graph.setAttribute("aria-hidden", "true");
    const grid = document.createElementNS(svgNamespace, "path");
    grid.setAttribute(
      "d",
      `M0 0H${graphWidth}M0 ${graphHeight / 2}H${graphWidth}M0 ${graphHeight}H${graphWidth}`,
    );
    grid.setAttribute("class", "performance-grid");
    const line = document.createElementNS(svgNamespace, "polyline");
    graph.append(grid, line);
    row.append(heading, graph);
    return { row, value, line, unit };
  });
  const legend = document.createElement("div");
  legend.className = "performance-legend";
  const pingRow = rows[0]!.row.cloneNode(true) as HTMLDivElement;
  pingRow.id = "performance-ping";
  pingRow.title =
    "Smoothed Lightyear Ping/Pong round-trip time to the match server; not input or display delay.";
  pingRow.querySelector("span")!.textContent = "Ping (RTT)";
  const pingValue = pingRow.querySelector("output")!;
  const pingLine = pingRow.querySelector("polyline")!;
  const pingLegend = legend.cloneNode() as HTMLDivElement;
  pingRow.append(pingLegend);
  panel.replaceChildren(...rows.map(({ row }) => row), legend, pingRow);
  let pingHistory: { time: number; ms: number }[] = [];

  function sampleLatency(time: number) {
    const port = (globalThis as typeof globalThis & { tm4Port?: NetworkPort }).tm4Port;
    const reading = networkLatency(store.getState().network, port?.netDiagnostics, time);
    pingRow.hidden = reading.state === "inactive";
    ping.hidden = pingRow.hidden || store.getState().showPerformance;
    ping.value = `Ping (RTT) ${reading.text}`;
    pingValue.textContent = reading.text;
    if (reading.state !== "measured") pingHistory = [];
    else if (store.getState().showPerformance) {
      pingHistory.push({ time, ms: reading.rttMs });
      pingHistory = pingHistory.filter((point) => point.time >= time - historyDuration);
    }
    const ceiling = Math.max(
      100,
      Math.ceil(Math.max(0, ...pingHistory.map((p) => p.ms)) / 50) * 50,
    );
    pingLine.setAttribute(
      "points",
      pingHistory
        .map((point) => {
          const x = graphWidth * (1 - (time - point.time) / historyDuration);
          const y = graphHeight - 1 - (point.ms / ceiling) * (graphHeight - 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" "),
    );
    pingLegend.textContent = `Last 15 s · RTT scale 0–${ceiling} ms`;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let animation: number | undefined;
  let browserCallbacks = 0;
  let history: Sample[] = [];
  let previousTime = 0;
  let previousCounts: number[] = [];
  const counts = () => [
    module._WebGetSimulationSteps() >>> 0,
    module._WebGetRenderedFrames() >>> 0,
    browserCallbacks >>> 0,
  ];

  function sample() {
    const time = performance.now();
    sampleLatency(time);
    if (!store.getState().showPerformance) return;
    const current = counts();
    const elapsed = time - previousTime;
    if (elapsed <= 0) return;
    const rates = current.map(
      (count, i) => (((count - previousCounts[i]!) >>> 0) * 1000) / elapsed,
    );
    history.push({ time, rates });
    history = history.filter((point) => point.time >= time - historyDuration);
    // All three graphs share both axes, so rates can be compared directly.
    const ceiling = Math.max(
      60,
      Math.ceil(Math.max(...history.flatMap((point) => point.rates)) / 30) * 30,
    );
    rows.forEach(({ value, line, unit }, index) => {
      value.textContent = `${rates[index]!.toFixed(1)} ${unit}`;
      line.setAttribute(
        "points",
        history
          .map((point) => {
            const x = graphWidth * (1 - (time - point.time) / historyDuration);
            const y = graphHeight - 1 - (point.rates[index]! / ceiling) * (graphHeight - 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" "),
      );
    });
    legend.textContent = `Last 15 s · shared scale 0–${ceiling}/s`;
    previousCounts = current;
    previousTime = time;
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
    if (animation !== undefined) cancelAnimationFrame(animation);
    animation = undefined;
  }
  function onAnimationFrame() {
    browserCallbacks++;
    animation = requestAnimationFrame(onAnimationFrame);
  }
  function update() {
    stop();
    const enabled = store.getState().showPerformance;
    checkbox.checked = enabled;
    panel.hidden = !enabled;
    sampleLatency(performance.now());
    if (document.hidden || (!enabled && !store.getState().network)) return;
    history = [];
    pingHistory = [];
    for (const { value, line, unit } of rows) {
      value.textContent = `— ${unit}`;
      line.removeAttribute("points");
    }
    legend.textContent = "Last 15 s · shared scale 0–60/s";
    previousTime = performance.now();
    previousCounts = counts();
    if (enabled) animation = requestAnimationFrame(onAnimationFrame);
    timer = setInterval(sample, sampleInterval);
  }
  checkbox.addEventListener("change", () => store.getState().setShowPerformance(checkbox.checked));
  document.addEventListener("visibilitychange", update);
  update();
  return store.subscribe((state, previous) => {
    if (state.showPerformance !== previous.showPerformance || state.network !== previous.network)
      update();
  });
}
