//! Bounded application health counters. Collection never calls the simulator.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tm4_network::{input::Rejection, protocol::MAX_PLAYERS};

pub type Shared = Arc<Mutex<Metrics>>;
const BOUNDS: [f64; 10] = [
    0.001,
    0.002,
    0.004,
    0.008,
    0.016,
    0.025,
    1.0 / 30.0,
    0.05,
    0.1,
    0.25,
];

#[derive(Default)]
struct Histogram {
    count: u64,
    sum: f64,
    buckets: [u64; 10],
}
impl Histogram {
    fn observe(&mut self, value: Duration) {
        let seconds = value.as_secs_f64();
        self.count += 1;
        self.sum += seconds;
        for (bound, count) in BOUNDS.iter().zip(&mut self.buckets) {
            if seconds <= *bound {
                *count += 1;
            }
        }
    }
    fn append(&self, rows: &mut Vec<Measurement>, name: &str) {
        rows.push(Measurement::counter(
            format!("{name}_count"),
            self.count as f64,
        ));
        rows.push(Measurement::counter(format!("{name}_sum"), self.sum));
        for (bound, count) in BOUNDS.iter().zip(self.buckets) {
            let mut row = Measurement::counter(format!("{name}_bucket"), count as f64);
            row.bucket = Some(bound.to_string());
            rows.push(row);
        }
        let mut row = Measurement::counter(format!("{name}_bucket"), self.count as f64);
        row.bucket = Some("+Inf".into());
        rows.push(row);
    }
}

#[derive(Default)]
struct Slot {
    received: u64,
    last_input: Option<Instant>,
    unacknowledged: usize,
    rejected: [u64; 4],
}

pub struct Metrics {
    started: Instant,
    boot: String,
    ticks: u64,
    last_tick: Option<Instant>,
    duration: Histogram,
    lateness: Histogram,
    events: BTreeMap<&'static str, u64>,
    slots: [Slot; MAX_PLAYERS],
}
impl Default for Metrics {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            boot: format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ),
            ticks: 0,
            last_tick: None,
            duration: Histogram::default(),
            lateness: Histogram::default(),
            events: [
                "rustymetal4_match_errors_total",
                "rustymetal4_simulation_errors_total",
                "rustymetal4_simulation_unsupported_total",
                "rustymetal4_input_rejected_total",
                "rustymetal4_checkpoint_capture_success_total",
                "rustymetal4_checkpoint_capture_errors_total",
                "rustymetal4_reconnections_accepted_total",
                "rustymetal4_journal_write_errors_total",
            ]
            .into_iter()
            .map(|name| (name, 0))
            .collect(),
            slots: std::array::from_fn(|_| Slot::default()),
        }
    }
}

#[derive(Serialize)]
pub struct Measurement {
    name: String,
    kind: &'static str,
    value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    slot: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bucket: Option<String>,
}
impl Measurement {
    fn counter(name: impl Into<String>, value: f64) -> Self {
        Self {
            name: name.into(),
            kind: "counter",
            value,
            slot: None,
            bucket: None,
        }
    }
    fn gauge(name: impl Into<String>, value: f64) -> Self {
        Self {
            kind: "gauge",
            ..Self::counter(name, value)
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema: u8,
    boot: String,
    uptime_seconds: f64,
    phase: String,
    measurements: Vec<Measurement>,
}
impl Metrics {
    pub fn event(&mut self, name: &'static str) {
        *self.events.entry(name).or_default() += 1;
    }
    pub fn tick(&mut self, duration: Duration, lateness: Duration) {
        self.ticks += 1;
        self.last_tick = Some(Instant::now());
        self.duration.observe(duration);
        self.lateness.observe(lateness);
    }
    pub fn input(&mut self, slot: usize) {
        self.slots[slot].received += 1;
        self.slots[slot].last_input = Some(Instant::now());
    }
    pub fn input_rejected(&mut self, slot: usize, reason: Rejection) {
        let index = match reason {
            Rejection::Late => 0,
            Rejection::Future => 1,
            Rejection::Full => 2,
            Rejection::Duplicate => 3,
        };
        self.slots[slot].rejected[index] += 1;
        self.event("rustymetal4_input_rejected_total");
    }
    pub fn unacknowledged(&mut self, slot: usize, count: usize) {
        self.slots[slot].unacknowledged = count;
    }
    pub fn snapshot(&self, phase: &str, connected: usize) -> Snapshot {
        let mut rows = vec![
            Measurement::counter("rustymetal4_simulation_ticks_total", self.ticks as f64),
            Measurement::gauge("rustymetal4_players_connected", connected as f64),
            Measurement::gauge(
                "rustymetal4_server_ready",
                f64::from(matches!(phase, "ready" | "lobby" | "match" | "results")),
            ),
        ];
        if let Some(last) = self.last_tick {
            rows.push(Measurement::gauge(
                "rustymetal4_simulation_last_tick_age_seconds",
                last.elapsed().as_secs_f64(),
            ));
        }
        self.duration
            .append(&mut rows, "rustymetal4_simulation_tick_duration_seconds");
        self.lateness
            .append(&mut rows, "rustymetal4_simulation_tick_lateness_seconds");
        rows.extend(
            self.events
                .iter()
                .map(|(name, count)| Measurement::counter(*name, *count as f64)),
        );
        for (slot, value) in self.slots.iter().enumerate() {
            let mut input =
                Measurement::counter("rustymetal4_input_received_total", value.received as f64);
            input.slot = Some(slot);
            rows.push(input);
            for (name, count) in [
                "rustymetal4_input_rejected_late_total",
                "rustymetal4_input_rejected_future_total",
                "rustymetal4_input_rejected_full_total",
                "rustymetal4_input_rejected_duplicate_total",
            ]
            .into_iter()
            .zip(value.rejected)
            {
                let mut rejected = Measurement::counter(name, count as f64);
                rejected.slot = Some(slot);
                rows.push(rejected);
            }
            let mut pending = Measurement::gauge(
                "rustymetal4_network_unacknowledged_messages",
                value.unacknowledged as f64,
            );
            pending.slot = Some(slot);
            rows.push(pending);
            if let Some(last) = value.last_input {
                let mut age = Measurement::gauge(
                    "rustymetal4_input_last_received_age_seconds",
                    last.elapsed().as_secs_f64(),
                );
                age.slot = Some(slot);
                rows.push(age);
            }
        }
        Snapshot {
            schema: 1,
            boot: self.boot.clone(),
            uptime_seconds: self.started.elapsed().as_secs_f64(),
            phase: phase.into(),
            measurements: rows,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn histogram_buckets_are_cumulative_and_include_slow_ticks() {
        let mut h = Histogram::default();
        for ms in [2, 30, 500] {
            h.observe(Duration::from_millis(ms));
        }
        let mut rows = Vec::new();
        h.append(&mut rows, "tick");
        assert_eq!(h.count, 3);
        assert_eq!(h.buckets[6], 2);
        assert_eq!(rows.last().unwrap().value, 3.0);
        assert!((h.sum - 0.532).abs() < 1e-9);
    }
    #[test]
    fn input_rejections_preserve_total_and_distinguish_slot_and_reason() {
        let mut metrics = Metrics::default();
        metrics.input_rejected(0, Rejection::Late);
        metrics.input_rejected(3, Rejection::Late);
        metrics.input_rejected(3, Rejection::Late);
        metrics.input_rejected(3, Rejection::Future);
        metrics.input_rejected(7, Rejection::Full);
        metrics.input_rejected(7, Rejection::Duplicate);
        let snapshot = metrics.snapshot("match", 3);
        let value = |name, slot| {
            snapshot
                .measurements
                .iter()
                .find(|m| m.name == name && m.slot == slot)
                .unwrap()
                .value
        };
        assert_eq!(value("rustymetal4_input_rejected_total", None), 6.0);
        assert_eq!(value("rustymetal4_input_rejected_late_total", Some(0)), 1.0);
        assert_eq!(value("rustymetal4_input_rejected_late_total", Some(3)), 2.0);
        assert_eq!(
            value("rustymetal4_input_rejected_future_total", Some(3)),
            1.0
        );
        assert_eq!(value("rustymetal4_input_rejected_full_total", Some(7)), 1.0);
        assert_eq!(
            value("rustymetal4_input_rejected_duplicate_total", Some(7)),
            1.0
        );
        assert_eq!(value("rustymetal4_input_rejected_late_total", Some(7)), 0.0);
        let rejected: Vec<_> = snapshot
            .measurements
            .iter()
            .filter(|m| m.name.starts_with("rustymetal4_input_rejected_") && m.slot.is_some())
            .collect();
        assert_eq!(rejected.len(), MAX_PLAYERS * 4);
        assert_eq!(rejected.iter().map(|m| m.value).sum::<f64>(), 6.0);
        assert!(
            snapshot.measurements.len() <= 200,
            "Fits the health API bound"
        );
        assert!(
            !snapshot
                .measurements
                .iter()
                .any(|m| m.name == "rustymetal4_input_last_received_age_seconds")
        );
    }

    #[test]
    fn collection_is_read_only_and_has_no_fabricated_input_timestamp() {
        let mut metrics = Metrics::default();
        metrics.tick(Duration::from_millis(4), Duration::ZERO);
        metrics.input(3);
        let snapshot = metrics.snapshot("match", 2);
        assert_eq!(
            snapshot
                .measurements
                .iter()
                .filter(|m| m.name == "rustymetal4_input_last_received_age_seconds")
                .count(),
            1
        );
        assert_eq!(metrics.snapshot("match", 2).measurements[0].value, 1.0);
        assert_eq!(metrics.snapshot("setup", 0).boot, snapshot.boot);
    }
}
