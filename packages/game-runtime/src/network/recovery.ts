import type { connectNetwork } from "@tm4/lightyear-client";
import type { Message, SnapshotBegin, Start } from "@tm4/lightyear-client/schemas";

import type { NetworkEngine, NetworkPort, RoundState } from "./protocol.ts";
import { checksum, maxResumeTicks, SnapshotReplay } from "./replay.ts";

type RecoveryMessage = Extract<
  Message,
  {
    type:
      | "snapshot_begin"
      | "snapshot_chunk"
      | "resume_catchup"
      | "catchup_frames"
      | "resume_live"
      | "resume_active";
  }
>;

type SnapshotDownload = {
  header: SnapshotBegin;
  bytes: Uint8Array<ArrayBuffer>;
  received: number;
  target?: number;
};

type RecoveryState =
  | { stage: "downloading"; download?: SnapshotDownload }
  | {
      stage: "catchup" | "handoff" | "activating";
      download: SnapshotDownload;
      replay?: SnapshotReplay;
      applied?: Promise<void>;
    };

function sameOutcome(local: Partial<RoundState>, remote: RoundState): boolean {
  return (
    local.digest === remote.digest &&
    local.sections?.length === remote.sections.length &&
    remote.sections.every((value, index) => local.sections?.[index] === value) &&
    local.unsupported === remote.unsupported &&
    local.remaining === remote.remaining &&
    local.winner === remote.winner &&
    local.roundFinished === remote.roundFinished &&
    local.acceptsContinue === remote.acceptsContinue &&
    local.nextMode === remote.nextMode &&
    local.scores?.length === remote.scores.length &&
    remote.scores.every(({ frags, deaths }, slot) => {
      const score = local.scores?.[slot];
      return score?.frags === frags && score.deaths === deaths;
    })
  );
}

export function createSnapshotRecovery({
  engine,
  port,
  connection,
  configuration,
  diagnostics,
  progress,
  show,
  fail,
}: {
  engine: NetworkEngine;
  port: NetworkPort;
  connection: Awaited<ReturnType<typeof connectNetwork>>;
  configuration: Pick<Start, "capacity" | "slots" | "modelPool" | "epoch"> & {
    slot: number;
    depth: number;
  };
  diagnostics: NonNullable<NetworkPort["netDiagnostics"]>;
  progress: () => void;
  show: (message: string) => void;
  fail: (error: unknown) => void;
}) {
  const abort = new AbortController();
  const { signal } = abort;
  const requestedAt = performance.now();
  let state: RecoveryState = { stage: "downloading" };
  let retargets = 0;
  diagnostics.resumeRetargets = 0;

  const run = (operation: () => Promise<void>) => {
    void operation().catch((error) => {
      if (!signal.aborted) fail(error);
    });
  };
  const targetClock = async (download: SnapshotDownload) => {
    signal.throwIfAborted();
    while (!connection.predictionIsReady()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      signal.throwIfAborted();
    }
    const { anchor, attempt, tick } = download.header;
    const target = connection.resumeTarget(anchor, tick);
    if (!Number.isInteger(target) || target < tick || target - tick > maxResumeTicks)
      throw new Error("The snapshot fell outside the reconnect window");
    download.target = target;
    connection.send({ type: "resume_clock", attempt, target });
    progress();
  };

  const restore = (download: SnapshotDownload) => {
    if (checksum(download.bytes) !== download.header.checksum)
      throw new Error("Corrupt reconnect snapshot");
    port.portableCheckpoint = download.bytes;
    try {
      if (
        !engine._WebNetBeginPortableReplay() ||
        !port.netMatch ||
        port.netMatch.tick !== download.header.tick ||
        !sameOutcome(port.netMatch, download.header.state)
      )
        throw new Error(
          "The game could not restore the snapshot" +
            (port.portableCheckpointError ? " (" + port.portableCheckpointError + ")" : ""),
        );
    } finally {
      delete port.portableCheckpoint;
    }
  };

  return {
    get predicting() {
      return !signal.aborted && state.stage === "activating";
    },
    close() {
      abort.abort();
    },
    // Returns the snapshot tick only once the server has activated this recovery.
    accept(message: RecoveryMessage): number | undefined {
      signal.throwIfAborted();
      switch (message.type) {
        case "snapshot_begin":
          if (state.stage !== "downloading" || state.download || message.state.unsupported)
            throw new Error("Invalid reconnect snapshot header");
          state.download = { header: message, bytes: new Uint8Array(message.total), received: 0 };
          diagnostics.snapshotTick = message.tick;
          diagnostics.snapshotBytes = message.total;
          progress();
          break;
        case "snapshot_chunk": {
          const download = state.download;
          if (
            state.stage !== "downloading" ||
            !download ||
            download.header.attempt !== message.attempt ||
            message.offset !== download.received ||
            download.received + message.data.length > download.bytes.length
          )
            throw new Error("Invalid reconnect snapshot block");
          download.bytes.set(message.data, download.received);
          download.received += message.data.length;
          connection.send({
            type: "snapshot_received",
            attempt: message.attempt,
            offset: download.received,
          });
          progress();
          if (download.received !== download.bytes.length) break;
          restore(download);
          state = { stage: "catchup", download };
          show("Catching up with the current match…");
          run(() => targetClock(download));
          break;
        }
        case "resume_catchup": {
          const download = state.download;
          if (
            state.stage !== "catchup" ||
            !download ||
            message.attempt !== download.header.attempt ||
            message.head !== download.target ||
            message.start !== (state.replay ? port.netMatch?.tick : download.header.tick) ||
            message.digest !== (state.replay ? port.netMatch?.digest : download.header.state.digest)
          )
            throw new Error("Invalid reconnect catch-up boundary");
          if (state.replay) state.replay.extend(message.start, message.head, message.digest);
          else {
            state.replay = new SnapshotReplay(
              message.start,
              message.head,
              message.digest,
              configuration,
              engine,
              port,
              signal,
            );
          }
          progress();
          break;
        }
        case "catchup_frames": {
          if (
            state.stage !== "catchup" ||
            !state.replay ||
            message.attempt !== state.download.header.attempt
          )
            throw new Error("Unexpected reconnect replay block");
          diagnostics.replayBytes = (diagnostics.replayBytes ?? 0) + message.data.length;
          diagnostics.replayChunks = (diagnostics.replayChunks ?? 0) + 1;
          state.applied = state.replay.accept(message).then((tick) => {
            if (signal.aborted) return;
            connection.send({ type: "catchup_applied", attempt: message.attempt, tick });
            progress();
          });
          const applied = state.applied;
          run(() => applied);
          break;
        }
        case "resume_live": {
          if (
            state.stage !== "catchup" ||
            !state.replay ||
            message.attempt !== state.download.header.attempt ||
            message.anchor !== state.download.header.anchor ||
            message.head !== state.download.target
          )
            throw new Error("Invalid reconnect prediction boundary");
          const active = state;
          const replay = state.replay;
          active.stage = "handoff";
          run(async () => {
            await active.applied;
            signal.throwIfAborted();
            const { anchor, head, sequence, attempt } = message;
            while (((connection.predictionClock() - anchor - head) | 0) < 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              signal.throwIfAborted();
            }
            if (head !== port.netMatch?.tick) throw new Error("Incomplete reconnect replay");
            const depth = (connection.predictionClock() - anchor - head) | 0;
            if (depth > configuration.depth) {
              if (retargets >= 2)
                throw new Error("Reconnect handoff could not keep up with the native clock");
              diagnostics.resumeRetargets = ++retargets;
              active.stage = "catchup";
              await targetClock(active.download);
              return;
            }
            replay.finish(head);
            connection.beginResumedPrediction(
              anchor,
              configuration.epoch,
              configuration.capacity,
              configuration.slot,
              configuration.depth,
              head,
              sequence,
            );
            active.stage = "activating";
            port.netConfirmedTick = head;
            diagnostics.recoveredTick = head;
            diagnostics.replayMs = performance.now() - requestedAt;
            connection.send({ type: "resume_live_ack", attempt, head });
            progress();
          });
          break;
        }
        case "resume_active":
          if (state.stage !== "activating" || message.head !== state.download.target)
            throw new Error("Unexpected reconnect acknowledgement");
          abort.abort();
          return state.download.header.tick;
      }
    },
  };
}
