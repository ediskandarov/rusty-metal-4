use super::{Match, control::send};
use crate::{resume, simulator};
use bevy_ecs::prelude::*;
use lightyear::prelude::*;
use std::time::Instant;
use tm4_network::protocol::{
    self as game_protocol, CHECKSUM_SEED, Message, REPLAY_CHUNK_TICKS, checksum,
};

impl Match {
    pub(super) fn pump_resume(
        &mut self,
        links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
        simulator: &mut simulator::Simulator,
    ) {
        if self.ended {
            return;
        }
        let Some(anchor) = self.prediction.anchor else {
            return;
        };
        for player in &mut self.controls {
            let (Some(entity), Some(attempt)) = (player.connection, player.resume.as_mut()) else {
                continue;
            };
            if attempt.failed {
                continue;
            }
            if attempt.requested.is_none() && self.tick >= attempt.retry_at {
                if let Some(state) = self.last_state.clone() {
                    attempt.requested = Some(resume::Snapshot {
                        tick: self.tick,
                        state,
                        checksum: 0,
                        total: 0,
                        data: Vec::new(),
                        sent: 0,
                        acknowledged: 0,
                    });
                    let capture = simulator.snapshot();
                    self.health.lock().unwrap().event(if capture.is_ok() {
                        "rustymetal4_checkpoint_capture_success_total"
                    } else {
                        "rustymetal4_checkpoint_capture_errors_total"
                    });
                    match capture {
                        Ok(data) => {
                            let snapshot = attempt.requested.as_mut().unwrap();
                            snapshot.total = data.len();
                            snapshot.checksum = checksum(CHECKSUM_SEED, &data);
                            snapshot.data = data;
                            attempt.progress = Instant::now();
                        }
                        Err(error) => {
                            eprintln!("Portable capture unavailable: {error:#}");
                            attempt.retries += 1;
                            if attempt.retries >= 4 {
                                attempt.failed = true;
                            } else {
                                attempt.requested = None;
                                attempt.retry_at = self.tick + 12;
                                attempt.progress = Instant::now();
                            }
                        }
                    }
                }
            }
            let Some(snapshot) = attempt
                .requested
                .as_mut()
                .filter(|snapshot| snapshot.ready())
            else {
                continue;
            };
            if !attempt.announced {
                send(
                    links,
                    entity,
                    &Message::SnapshotBegin {
                        attempt: attempt.id,
                        tick: snapshot.tick,
                        anchor: anchor.0,
                        total: snapshot.total as u32,
                        checksum: snapshot.checksum,
                        state: snapshot.state.clone(),
                    },
                );
                attempt.announced = true;
            }
            if snapshot.sent == snapshot.acknowledged && snapshot.sent < snapshot.total {
                let offset = snapshot.sent;
                snapshot.sent = (offset + game_protocol::SNAPSHOT_CHUNK_BYTES).min(snapshot.total);
                send(
                    links,
                    entity,
                    &Message::SnapshotChunk {
                        attempt: attempt.id,
                        offset: offset as u32,
                        data: snapshot.data[offset..snapshot.sent].to_vec(),
                    },
                );
            }
            let Some(target) = attempt.target else {
                continue;
            };
            if attempt.pending_frame.is_some() || attempt.offered {
                continue;
            }
            if attempt.sent_frames < target {
                let end = (attempt.sent_frames + REPLAY_CHUNK_TICKS).min(target);
                // The last block waits for its actual frontier instead of turning
                // a future target into several serial one-tick exchanges.
                if end > self.tick || end <= attempt.sent_frames {
                    continue;
                }
                let Some(data) = self
                    .journal
                    .as_mut()
                    .and_then(|journal| journal.range(attempt.sent_frames, end).ok())
                else {
                    attempt.failed = true;
                    continue;
                };
                send(
                    links,
                    entity,
                    &Message::CatchupFrames {
                        attempt: attempt.id,
                        start: attempt.sent_frames,
                        head: target,
                        checksum: checksum(CHECKSUM_SEED, &data),
                        data,
                    },
                );
                attempt.sent_frames = end;
                attempt.pending_frame = Some(end);
            }
            // The ordered channel can carry the offer with the last block. Slot
            // control still requires both the applied-block and live acknowledgments.
            if attempt.sent_frames == target {
                send(
                    links,
                    entity,
                    &Message::ResumeLive {
                        attempt: attempt.id,
                        anchor: anchor.0,
                        head: target,
                        sequence: player.received_sequence,
                    },
                );
                attempt.offered = true;
            }
        }
    }
}
