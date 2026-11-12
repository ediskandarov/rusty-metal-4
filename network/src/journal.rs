use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tm4_network::{
    input::Input,
    protocol::{
        CHECKSUM_SEED, JOURNAL_FRAME_PREFIX, JOURNAL_INPUT_BYTES, JOURNAL_MAX_TICKS, MAX_PLAYERS,
        REPLAY_CHUNK_TICKS, RoundState, SessionStart, checksum, journal_frame_bytes,
    },
};

const MAGIC: &[u8; 8] = b"TM4JRNL\x01";
const HEADER_LIMIT: usize = 4096;
const CACHE_LIMIT: usize = 8 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = journal_frame_bytes(MAX_PLAYERS);
const FRAME: u8 = 1;
const END: u8 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Header {
    pub start: SessionStart,
    pub initial_digest: u32,
}

impl Header {
    fn valid(&self) -> bool {
        let start = &self.start;
        (2..=MAX_PLAYERS).contains(&start.players)
            && start.cars.len() == start.players
            && start.epoch == 1
            && !start.world.is_empty()
            && start.cars.iter().all(|car| !car.is_empty())
            && !start.compatibility.build.is_empty()
            && !start.compatibility.content.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum End {
    Finished,
    Aborted,
    Incomplete,
}

#[derive(Debug, Serialize)]
pub struct Summary {
    pub header: Header,
    pub ticks: u32,
    pub bytes_per_tick: usize,
    pub first_unsupported_tick: Option<u32>,
    pub end: End,
}

#[derive(Clone)]
pub struct Export {
    pub path: PathBuf,
    pub length: u64,
}

pub type SharedExport = Arc<Mutex<Option<Export>>>;

pub struct Journal {
    pub path: PathBuf,
    writer: BufWriter<File>,
    width: usize,
    rows: Vec<u8>,
    cache_limit: usize,
    record_offset: u64,
    ticks: u32,
    rolling: u32,
    export: Option<SharedExport>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn word(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn encode(inputs: &[Input], state: &RoundState, bytes: &mut [u8]) {
    for (part, value) in bytes[..24]
        .chunks_exact_mut(4)
        .zip(std::iter::once(state.digest).chain(state.sections))
    {
        part.copy_from_slice(&value.to_le_bytes());
    }
    bytes[24..28].copy_from_slice(&state.next_mode.to_le_bytes());
    bytes[28] = u8::from(state.unsupported.is_some());
    for (part, input) in bytes[JOURNAL_FRAME_PREFIX..]
        .chunks_exact_mut(JOURNAL_INPUT_BYTES)
        .zip(inputs)
    {
        part[..2].copy_from_slice(&input.buttons.to_le_bytes());
        part[2..6].copy_from_slice(&input.axes.to_le_bytes());
        part[6] = u8::from(input.analog);
    }
}

impl Journal {
    pub fn create(directory: &Path, header: &Header) -> io::Result<Self> {
        Self::with_cache_limit(directory, header, CACHE_LIMIT)
    }

    fn with_cache_limit(directory: &Path, header: &Header, cache_limit: usize) -> io::Result<Self> {
        if !header.valid() {
            return Err(invalid("Invalid journal startup"));
        }
        let bytes = serde_json::to_vec(header)?;
        if bytes.len() > HEADER_LIMIT {
            return Err(invalid("Journal startup is too large"));
        }
        fs::create_dir_all(directory)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let path = directory.join(format!("deathmatch-{stamp}-{}.tm4j", std::process::id()));
        let mut writer = BufWriter::new(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?,
        );
        let rolling = checksum(CHECKSUM_SEED, &bytes);
        writer.write_all(MAGIC)?;
        writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
        writer.write_all(&bytes)?;
        writer.write_all(&rolling.to_le_bytes())?;
        writer.flush()?;
        let width = journal_frame_bytes(header.start.players);
        Ok(Self {
            path,
            writer,
            width,
            rows: Vec::new(),
            cache_limit: cache_limit / width * width,
            record_offset: (MAGIC.len() + 8 + bytes.len()) as u64,
            ticks: 0,
            rolling,
            export: None,
        })
    }

    pub fn attach_export(&mut self, export: SharedExport) {
        self.export = Some(export);
        self.publish(self.record_offset);
    }

    fn publish(&self, length: u64) {
        if let Some(export) = &self.export {
            *export.lock().unwrap() = Some(Export {
                path: self.path.clone(),
                length,
            });
        }
    }

    fn flushed_length(&self) -> u64 {
        self.record_offset + u64::from(self.ticks) * (self.width + 5) as u64
    }

    pub fn append(&mut self, tick: u32, inputs: &[Input], state: &RoundState) -> io::Result<()> {
        if tick != self.ticks()
            || tick >= JOURNAL_MAX_TICKS
            || journal_frame_bytes(inputs.len()) != self.width
        {
            return Err(invalid("Invalid journal tick"));
        }
        let mut buffer = [0; MAX_FRAME_BYTES];
        let bytes = &mut buffer[..self.width];
        encode(inputs, state, bytes);
        let rolling = checksum(self.rolling, bytes);
        let cache = self.rows.len() < self.cache_limit;
        if cache && self.rows.capacity() - self.rows.len() < self.width {
            let capacity = (self.rows.capacity().max(self.width) * 2).min(self.cache_limit);
            self.rows
                .try_reserve_exact(capacity - self.rows.len())
                .map_err(io::Error::other)?;
        }
        self.writer.write_all(&[FRAME])?;
        self.writer.write_all(bytes)?;
        self.writer.write_all(&rolling.to_le_bytes())?;
        if (tick + 1).is_multiple_of(30) {
            self.writer.flush()?;
        }
        if cache {
            self.rows.extend_from_slice(bytes);
        }
        self.ticks += 1;
        self.rolling = rolling;
        if self.ticks.is_multiple_of(30) {
            self.publish(self.flushed_length());
        }
        Ok(())
    }

    pub fn ticks(&self) -> u32 {
        self.ticks
    }

    pub fn range(&mut self, start: u32, end: u32) -> io::Result<Vec<u8>> {
        if start >= end || end > self.ticks || end - start > REPLAY_CHUNK_TICKS {
            return Err(invalid("Invalid journal range"));
        }
        let start_index = start as usize * self.width;
        let end_index = end as usize * self.width;
        if end_index <= self.rows.len() {
            return Ok(self.rows[start_index..end_index].to_vec());
        }

        self.writer.flush()?;
        self.publish(self.flushed_length());
        let mut reader = BufReader::new(File::open(&self.path)?);
        let offset = self.record_offset + u64::from(start) * (self.width + 5) as u64;
        reader.seek(SeekFrom::Start(offset - 4))?;
        let mut rolling = word(&mut reader)?;
        let mut data = vec![0; end_index - start_index];
        for row in data.chunks_exact_mut(self.width) {
            let mut tag = [0; 1];
            reader.read_exact(&mut tag)?;
            reader.read_exact(row)?;
            rolling = checksum(rolling, row);
            if tag[0] != FRAME || word(&mut reader)? != rolling {
                return Err(invalid("Corrupt journal recovery range"));
            }
        }
        Ok(data)
    }

    pub fn memory_bytes(&self) -> (usize, usize) {
        (self.rows.len(), self.rows.capacity())
    }

    pub fn finish(&mut self, end: End) -> io::Result<()> {
        let code = match end {
            End::Finished => 1,
            End::Aborted => 2,
            End::Incomplete => return Err(invalid("Invalid journal footer")),
        };
        let mut footer = [0; 5];
        footer[0] = code;
        footer[1..].copy_from_slice(&self.ticks().to_le_bytes());
        self.writer.write_all(&[END])?;
        self.writer.write_all(&footer)?;
        self.writer
            .write_all(&checksum(self.rolling, &footer).to_le_bytes())?;
        self.writer.flush()?;
        self.writer.get_ref().sync_data()?;
        self.publish(self.flushed_length() + 10);
        Ok(())
    }
}

pub fn inspect(path: &Path) -> io::Result<Summary> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut magic = [0; MAGIC.len()];
    reader.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(invalid("Unknown journal version"));
    }
    let length = word(&mut reader)? as usize;
    if length == 0 || length > HEADER_LIMIT {
        return Err(invalid("Invalid journal startup length"));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    let mut rolling = checksum(CHECKSUM_SEED, &bytes);
    if word(&mut reader)? != rolling {
        return Err(invalid("Corrupt journal startup"));
    }
    let header: Header = serde_json::from_slice(&bytes)?;
    if !header.valid() {
        return Err(invalid("Invalid journal startup"));
    }
    let mut summary = Summary {
        bytes_per_tick: journal_frame_bytes(header.start.players),
        header,
        ticks: 0,
        first_unsupported_tick: None,
        end: End::Incomplete,
    };
    let mut record = [0; MAX_FRAME_BYTES + 4];
    let mut tag = [0; 1];
    let mut next_mode = 0;
    loop {
        if reader.read(&mut tag)? == 0 {
            return Ok(summary);
        }
        let size = match tag[0] {
            FRAME if summary.ticks < JOURNAL_MAX_TICKS && next_mode == 0 => {
                summary.bytes_per_tick + 4
            }
            END => 9,
            _ => return Err(invalid("Invalid journal record")),
        };
        match reader.read_exact(&mut record[..size]) {
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(summary),
            result => result?,
        }
        let (data, integrity) = record[..size].split_at(size - 4);
        rolling = checksum(rolling, data);
        if rolling != u32::from_le_bytes(integrity.try_into().unwrap()) {
            return Err(invalid("Corrupt journal record"));
        }
        if tag[0] == END {
            let ticks = u32::from_le_bytes(data[1..].try_into().unwrap());
            if ticks != summary.ticks || reader.read(&mut tag)? != 0 {
                return Err(invalid("Invalid journal footer"));
            }
            summary.end = match data[0] {
                1 if next_mode != 0 => End::Finished,
                2 => End::Aborted,
                _ => return Err(invalid("Invalid journal outcome")),
            };
            return Ok(summary);
        }
        if data[28] > 1
            || data[JOURNAL_FRAME_PREFIX..]
                .chunks_exact(JOURNAL_INPUT_BYTES)
                .any(|input| input[6] > 1)
        {
            return Err(invalid("Invalid journal frame flags"));
        }
        if data[28] == 1 {
            summary.first_unsupported_tick.get_or_insert(summary.ticks);
        }
        next_mode = i32::from_le_bytes(data[24..28].try_into().unwrap());
        summary.ticks += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tm4_network::protocol::Compatibility;

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(std::env::temp_dir().join(format!(
                "tm4-journal-test-{stamp}-{}-{}",
                std::process::id(),
                NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn header(players: usize) -> Header {
        Header {
            start: SessionStart {
                players,
                world: "Construction Yard".into(),
                cars: vec!["Orbital".into(); players],
                compatibility: Compatibility {
                    protocol: 3,
                    build: "fixture build".into(),
                    content: "fixture content".into(),
                },
                seed: 12345,
                epoch: 1,
                portable: false,
            },
            initial_digest: 42,
        }
    }

    fn state(tick: u32, next_mode: i32) -> RoundState {
        RoundState {
            remaining: 8,
            winner: -1,
            round_finished: false,
            accepts_continue: false,
            next_mode,
            digest: tick,
            sections: [tick, 0, 0, 0, 0],
            unsupported: None,
            scores: Vec::new(),
        }
    }

    #[test]
    fn export_freezes_a_complete_prefix_while_the_writer_keeps_appending() {
        let directory = TestDirectory::new();
        let mut journal = Journal::create(&directory.0, &header(2)).unwrap();
        let export = SharedExport::default();
        journal.attach_export(export.clone());
        let header_length = export.lock().unwrap().as_ref().unwrap().length;
        let inputs = [Input::default(); 2];
        for tick in 0..30 {
            journal.append(tick, &inputs, &state(tick, 0)).unwrap();
        }
        let frozen = export.lock().unwrap().clone().unwrap();
        assert_eq!(
            frozen.length,
            header_length + 30 * (journal.width + 5) as u64
        );
        for tick in 30..65 {
            journal.append(tick, &inputs, &state(tick, 0)).unwrap();
        }
        let mut prefix = Vec::new();
        File::open(frozen.path)
            .unwrap()
            .take(frozen.length)
            .read_to_end(&mut prefix)
            .unwrap();
        let snapshot = directory.0.join("export.tm4j");
        fs::write(&snapshot, prefix).unwrap();
        let summary = inspect(&snapshot).unwrap();
        assert_eq!((summary.ticks, summary.end), (30, End::Incomplete));
        journal.finish(End::Aborted).unwrap();
        let final_export = export.lock().unwrap().clone().unwrap();
        assert_eq!(
            final_export.length,
            fs::metadata(&journal.path).unwrap().len()
        );
        assert_eq!(inspect(&final_export.path).unwrap().end, End::Aborted);
    }

    #[test]
    fn eight_slots_at_15_minutes_round_trip_and_use_packed_storage() {
        let directory = TestDirectory::new();
        let mut journal = Journal::create(&directory.0, &header(8)).unwrap();
        let mut inputs = [Input::default(); 8];
        for tick in 0u32..27_000 {
            inputs[7].buttons = tick as u16;
            inputs[7].axes = tick.rotate_left(17);
            journal
                .append(
                    tick,
                    &inputs,
                    &state(tick, if tick == 26_999 { 2 } else { 0 }),
                )
                .unwrap();
        }
        let (used, capacity) = journal.memory_bytes();
        let expected = 27_000 * journal_frame_bytes(8);
        assert_eq!(used, expected);
        assert!(capacity <= expected * 2);
        let sample = journal.range(26_999, 27_000).unwrap();
        assert_eq!(u32::from_le_bytes(sample[..4].try_into().unwrap()), 26_999);
        assert_eq!(sample[24], 2);
        assert_eq!(
            u16::from_le_bytes(sample[78..80].try_into().unwrap()),
            26_999
        );
        journal.finish(End::Finished).unwrap();
        let result = inspect(&journal.path).unwrap();
        assert_eq!(result.ticks, 27_000);
        assert_eq!(result.end, End::Finished);
        assert_eq!(result.header.initial_digest, 42);
        let bytes = fs::metadata(&journal.path).unwrap().len();
        assert_eq!(bytes, journal.record_offset + 27_000 * 90 + 10);
        eprintln!(
            "Eight-slot journal: {bytes} disk bytes, {used} cache bytes / {capacity} allocated"
        );
    }

    #[test]
    fn verifies_spilled_chunks_and_detects_truncation_and_corruption() {
        let directory = TestDirectory::new();
        let width = journal_frame_bytes(2);
        let mut journal = Journal::with_cache_limit(&directory.0, &header(2), width).unwrap();
        let inputs = [Input::default(); 2];
        for tick in 0..3 {
            let mut frame = state(tick, 0);
            if tick == 1 {
                frame.unsupported = Some("fixture".into());
            }
            journal.append(tick, &inputs, &frame).unwrap();
        }
        let data = journal.range(0, 3).unwrap();
        assert_eq!(data.len(), 3 * width);
        assert_eq!(journal.memory_bytes().0, width);
        assert_eq!(journal.range(2, 3).unwrap(), data[2 * width..]);
        journal.finish(End::Aborted).unwrap();
        let summary = inspect(&journal.path).unwrap();
        assert_eq!(summary.end, End::Aborted);
        assert_eq!(summary.first_unsupported_tick, Some(1));
        let complete = fs::read(&journal.path).unwrap();

        let partial = directory.0.join("partial.tm4j");
        fs::write(&partial, &complete[..MAGIC.len() + 2]).unwrap();
        assert!(inspect(&partial).is_err());
        let mut bad_header = complete.clone();
        bad_header[MAGIC.len() + 4] ^= 1;
        fs::write(&partial, bad_header).unwrap();
        assert!(inspect(&partial).is_err());

        fs::write(&partial, &complete[..complete.len() - 2]).unwrap();
        let result = inspect(&partial).unwrap();
        assert_eq!((result.ticks, result.end), (3, End::Incomplete));

        fs::write(&partial, &complete[..complete.len() - 12]).unwrap();
        let result = inspect(&partial).unwrap();
        assert_eq!((result.ticks, result.end), (2, End::Incomplete));

        let mut corrupt = complete;
        corrupt[journal.record_offset as usize + (width + 5) + 2] ^= 1;
        fs::write(&journal.path, corrupt).unwrap();
        assert!(inspect(&journal.path).is_err());
        assert!(journal.range(1, 2).is_err());
    }
}
