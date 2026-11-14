use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tm4_network::protocol::{Message, PREDICTION_DEPTH, RoundState, SNAPSHOT_MAX_CATCHUP};

pub const RESUME_IDLE: Duration = Duration::from_secs(5);
pub const MAX_RETARGETS: u8 = 2;
pub const RESUME_DEADLINE: Duration = Duration::from_secs(12);

pub fn credential() -> Option<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    let mut token = String::with_capacity(64);
    use std::fmt::Write;
    for byte in bytes {
        write!(&mut token, "{byte:02x}").ok()?;
    }
    Some(token)
}

pub fn matches_credential(expected: &str, supplied: &str) -> bool {
    expected.len() == 64
        && supplied.len() == expected.len()
        && expected
            .bytes()
            .zip(supplied.bytes())
            .fold(0, |mask, (a, b)| mask | (a ^ b))
            == 0
}

pub struct Snapshot {
    pub tick: u32,
    pub state: RoundState,
    pub checksum: u32,
    pub total: usize,
    pub data: Vec<u8>,
    pub sent: usize,
    pub acknowledged: usize,
}

impl Snapshot {
    pub fn ready(&self) -> bool {
        self.total != 0 && self.data.len() == self.total
    }
}

pub struct Attempt {
    pub id: u32,
    pub started: Instant,
    pub progress: Instant,
    pub requested: Option<Snapshot>,
    pub announced: bool,
    pub retries: u8,
    pub retry_at: u32,
    pub target: Option<u32>,
    pub retargets: u8,
    pub sent_frames: u32,
    pub pending_frame: Option<u32>,
    pub failed: bool,
    pub offered: bool,
    pub frames: VecDeque<Message>,
}

impl Attempt {
    pub fn new(id: u32) -> Self {
        let now = Instant::now();
        Self {
            id,
            started: now,
            progress: now,
            requested: None,
            announced: false,
            retries: 0,
            retry_at: 0,
            target: None,
            retargets: 0,
            sent_frames: 0,
            pending_frame: None,
            failed: false,
            offered: false,
            frames: VecDeque::new(),
        }
    }

    pub fn set_target(&mut self, target: u32, current: u32) -> Option<u32> {
        let snapshot = self
            .requested
            .as_ref()
            .filter(|snapshot| snapshot.ready())?;
        if self.failed
            || snapshot.acknowledged != snapshot.total
            || target < snapshot.tick
            || target - snapshot.tick > SNAPSHOT_MAX_CATCHUP
            || target > current.saturating_add(60)
            || current.saturating_sub(target) > u32::from(PREDICTION_DEPTH)
        {
            return None;
        }
        let start = if let Some(previous) = self.target {
            if !self.offered
                || self.pending_frame.is_some()
                || self.sent_frames != previous
                || target <= previous
                || self.retargets == MAX_RETARGETS
            {
                return None;
            }
            self.retargets += 1;
            previous
        } else {
            snapshot.tick
        };
        self.target = Some(target);
        self.sent_frames = start;
        self.offered = false;
        self.frames
            .retain(|frame| matches!(frame, Message::Frame { tick, .. } if *tick >= target));
        self.progress = Instant::now();
        Some(start)
    }

    pub fn can_activate(&self, head: u32, current: u32) -> bool {
        !self.failed && self.offered && self.target == Some(head)
            && self.pending_frame.is_none() && current >= head
            && current - head <= u32::from(PREDICTION_DEPTH)
            && self.frames.len() == (current - head) as usize
            && self.frames.iter().enumerate().all(|(offset, frame)| {
                matches!(frame, Message::Frame { tick, .. } if *tick == head + offset as u32)
            })
    }

    pub fn timeout(&self, now: Instant) -> bool {
        self.failed
            || now.duration_since(self.progress) > RESUME_IDLE
            || now.duration_since(self.started) > RESUME_DEADLINE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(tick: u32) -> Message {
        Message::Frame {
            changes: Vec::new(),
            tick,
            inputs: Vec::new(),
            state: RoundState {
                completion: tm4_network::protocol::MatchCompletion {
                    tick: 0,
                    reasons: 0,
                    winners: 0,
                },
                remaining: 2,
                winner: -1,
                round_finished: false,
                accepts_continue: false,
                next_mode: 0,
                digest: tick + 1,
                sections: [0; 5],
                unsupported: None,
                scores: Vec::new(),
            },
        }
    }

    fn attempt() -> Attempt {
        let mut attempt = Attempt::new(1);
        let Message::Frame { state, .. } = frame(99) else {
            unreachable!()
        };
        attempt.requested = Some(Snapshot {
            tick: 100,
            state,
            checksum: 0,
            total: 1,
            data: vec![0],
            sent: 1,
            acknowledged: 1,
        });
        attempt
    }

    #[test]
    fn retarget_requires_applied_offer_and_preserves_original_budget() {
        let mut attempt = attempt();
        let started = attempt.started;
        assert_eq!(attempt.set_target(130, 128), Some(100));
        assert_eq!(attempt.set_target(140, 138), None);
        attempt.sent_frames = 130;
        attempt.offered = true;
        attempt.pending_frame = Some(130);
        assert_eq!(attempt.set_target(140, 138), None);
        attempt.pending_frame = None;
        attempt.frames.extend((130..140).map(frame));
        assert_eq!(attempt.set_target(140, 138), Some(130));
        assert!(attempt.frames.is_empty());
        assert_eq!(attempt.started, started);
        assert_eq!(attempt.retargets, 1);
        assert!(!attempt.offered);
        attempt.sent_frames = 140;
        attempt.offered = true;
        assert_eq!(attempt.set_target(341, 339), None);
        assert_eq!(attempt.set_target(150, 148), Some(140));
        attempt.sent_frames = 150;
        attempt.offered = true;
        assert_eq!(attempt.set_target(160, 158), None);
        attempt.progress = started + Duration::from_secs(11);
        assert!(!attempt.timeout(started + RESUME_DEADLINE - Duration::from_millis(1)));
        assert!(attempt.timeout(started + RESUME_DEADLINE + Duration::from_millis(1)));
    }

    #[test]
    fn activation_requires_complete_bounded_live_suffix() {
        let mut attempt = attempt();
        attempt.set_target(130, 128).unwrap();
        attempt.sent_frames = 130;
        attempt.offered = true;
        assert!(attempt.can_activate(130, 130));
        attempt.frames.extend((130..142).map(frame));
        assert!(attempt.can_activate(130, 142));
        assert!(!attempt.can_activate(130, 143));
        attempt.frames.pop_front();
        assert!(!attempt.can_activate(130, 142));
        assert!(!attempt.can_activate(129, 141));
        attempt.frames.clear();
        attempt.pending_frame = Some(130);
        assert!(!attempt.can_activate(130, 130));
    }
}
