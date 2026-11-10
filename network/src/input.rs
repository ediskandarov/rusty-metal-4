//! Tick-addressed controller transitions. One record is consumed per simulation step.
//! Multiple changes aimed at one step are assigned consecutive steps, preserving the
//! game's edge semantics rather than OR-ing presses into an invented firing rate.
use bevy_ecs::entity::{EntityMapper, MapEntities};
use bevy_reflect::Reflect;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const FUTURE_WINDOW: u32 = 60;
pub const STALE_TICKS: u32 = 9;
const MAX_PENDING: usize = 60;

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize, Reflect)]
pub struct Input {
    pub buttons: u16,
    pub axes: u32,
    pub analog: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize, Reflect)]
pub struct ControllerCommand {
    pub epoch: u32,
    pub sequence: u32,
    pub tick: u32,
    pub input: Input,
}
impl MapEntities for ControllerCommand {
    fn map_entities<M: EntityMapper>(&mut self, _: &mut M) {}
}

impl MapEntities for Input {
    fn map_entities<M: EntityMapper>(&mut self, _: &mut M) {}
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rejection {
    Duplicate,
    Late,
    Future,
    Full,
}

#[derive(Default)]
pub struct InputHistory {
    pending: VecDeque<(u32, Input)>,
    last_sequence: Option<u32>,
    last_tick: Option<u32>,
    current: Input,
}

impl InputHistory {
    pub fn enqueue(
        &mut self,
        now: u32,
        sequence: u32,
        intended: u32,
        input: Input,
    ) -> Result<u32, Rejection> {
        if self.last_sequence.is_some_and(|last| sequence <= last) {
            return Err(Rejection::Duplicate);
        }
        if intended < now {
            return Err(Rejection::Late);
        }
        if intended.saturating_sub(now) > FUTURE_WINDOW {
            return Err(Rejection::Future);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(Rejection::Full);
        }
        let scheduled = self
            .pending
            .back()
            .map_or(intended, |(tick, _)| intended.max(tick + 1));
        if scheduled.saturating_sub(now) > FUTURE_WINDOW {
            return Err(Rejection::Future);
        }
        self.pending.push_back((scheduled, input));
        self.last_sequence = Some(sequence);
        Ok(scheduled)
    }

    pub fn sample(&mut self, tick: u32) -> Input {
        if self
            .pending
            .front()
            .is_some_and(|(target, _)| *target <= tick)
        {
            let (target, input) = self.pending.pop_front().unwrap();
            self.current = input;
            self.last_tick = Some(target);
        }
        if self
            .last_tick
            .is_none_or(|last| tick.saturating_sub(last) >= STALE_TICKS)
        {
            self.current = Input::default();
        }
        self.current
    }

    pub fn disconnect(&mut self) {
        self.pending.clear();
        self.current = Input::default();
        self.last_tick = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fire() -> Input {
        Input {
            buttons: 1,
            ..Default::default()
        }
    }
    #[test]
    fn batched_tap_survives_and_duplicate_does_not_repeat() {
        let mut h = InputHistory::default();
        assert_eq!(h.enqueue(0, 1, 2, fire()), Ok(2));
        assert_eq!(h.enqueue(0, 2, 2, Input::default()), Ok(3));
        assert_eq!(h.enqueue(0, 1, 2, fire()), Err(Rejection::Duplicate));
        assert_eq!(h.sample(1).buttons, 0);
        assert_eq!(h.sample(2).buttons, 1);
        assert_eq!(h.sample(3).buttons, 0);
    }
    #[test]
    fn stale_held_input_expires() {
        let mut h = InputHistory::default();
        h.enqueue(0, 1, 0, fire()).unwrap();
        assert_eq!(h.sample(0).buttons, 1);
        assert_eq!(h.sample(STALE_TICKS - 1).buttons, 1);
        assert_eq!(h.sample(STALE_TICKS).buttons, 0);
    }
    #[test]
    fn rejects_late_and_future_without_poisoning_sequence() {
        let mut h = InputHistory::default();
        assert_eq!(h.enqueue(10, 1, 9, fire()), Err(Rejection::Late));
        assert_eq!(h.enqueue(10, 1, 71, fire()), Err(Rejection::Future));
        assert_eq!(h.enqueue(10, 1, 10, fire()), Ok(10));
    }
    #[test]
    fn bounded_queue_and_disconnect_clear_future_controls() {
        let mut h = InputHistory::default();
        for i in 0..60 {
            h.enqueue(0, i, 0, fire()).unwrap();
        }
        assert_eq!(h.enqueue(0, 60, 0, fire()), Err(Rejection::Full));
        h.disconnect();
        assert_eq!(h.sample(0), Input::default());
        assert_eq!(h.sample(60), Input::default());
    }
}
