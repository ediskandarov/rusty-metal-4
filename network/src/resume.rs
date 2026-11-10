use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tm4_network::protocol::{
    CHECKSUM_SEED, Message, RoundState, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_MAX_BYTES, checksum,
};

pub const RESUME_IDLE: Duration = Duration::from_secs(5);
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
    pub fn upload(&mut self, total: usize, offset: usize, hash: u32, data: Vec<u8>) -> bool {
        if total == 0
            || total > SNAPSHOT_MAX_BYTES
            || offset != self.data.len()
            || data.is_empty()
            || data.len() > SNAPSHOT_CHUNK_BYTES
            || offset + data.len() > total
            || (self.total != 0 && (self.total != total || self.checksum != hash))
        {
            return false;
        }
        self.total = total;
        self.checksum = hash;
        self.data.extend(data);
        self.data.len() < self.total || checksum(CHECKSUM_SEED, &self.data) == self.checksum
    }

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
            sent_frames: 0,
            pending_frame: None,
            failed: false,
            offered: false,
            frames: VecDeque::new(),
        }
    }

    pub fn timeout(&self, now: Instant) -> bool {
        self.failed
            || now.duration_since(self.progress) > RESUME_IDLE
            || now.duration_since(self.started) > RESUME_DEADLINE
    }
}
