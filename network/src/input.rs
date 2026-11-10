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

/// Render/device samples are reduced at the native 30 Hz input boundary. A run
/// with unchanged buttons needs only its latest analog state; transitions remain
/// separate records, including a press and release received in the same update.
#[derive(Default)]
pub struct PendingInputs {
    pending: VecDeque<(ControllerCommand, bool)>,
    last_sequence: Option<u32>,
    buttons: u16,
}

impl PendingInputs {
    pub fn enqueue(&mut self, command: ControllerCommand) -> Result<Option<u32>, Rejection> {
        if self
            .last_sequence
            .is_some_and(|last| command.sequence <= last)
        {
            return Ok(Some(command.sequence));
        }
        if let Some((previous, edge)) = self.pending.back_mut()
            && previous.epoch == command.epoch
            && previous.input.buttons == command.input.buttons
            && (!*edge || previous.tick == command.tick)
        {
            let superseded = previous.sequence;
            // A later-tick held state must not replace an earlier button edge.
            // Once separate, that held state can absorb further analog samples.
            *previous = command;
            self.last_sequence = Some(command.sequence);
            return Ok(Some(superseded));
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(Rejection::Full);
        }
        let edge = self.buttons != command.input.buttons;
        self.buttons = command.input.buttons;
        self.last_sequence = Some(command.sequence);
        self.pending.push_back((command, edge));
        Ok(None)
    }

    pub fn pop(&mut self) -> Option<ControllerCommand> {
        self.pending.pop_front().map(|(command, _)| command)
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Rejection {
    Duplicate,
    Late,
    Future,
    Full,
}

#[derive(Default)]
pub struct InputHistory {
    pending: VecDeque<(u32, u32, Input)>,
    last_sequence: Option<u32>,
    last_tick: Option<u32>,
    current: Input,
    pub processed_sequence: Option<u32>,
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
            .map_or(intended, |(tick, _, _)| intended.max(tick + 1));
        if scheduled.saturating_sub(now) > FUTURE_WINDOW {
            return Err(Rejection::Future);
        }
        self.pending.push_back((scheduled, sequence, input));
        self.last_sequence = Some(sequence);
        Ok(scheduled)
    }

    pub fn sample(&mut self, tick: u32) -> Input {
        if self
            .pending
            .front()
            .is_some_and(|(target, _, _)| *target <= tick)
        {
            let (target, sequence, input) = self.pending.pop_front().unwrap();
            self.current = input;
            self.last_tick = Some(target);
            self.processed_sequence = Some(sequence);
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
        assert_eq!(h.processed_sequence, Some(2));
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

#[cfg(test)]
mod sampling_tests {
    use super::*;
    fn sample(sequence: u32, tick: u32, buttons: u16) -> ControllerCommand {
        ControllerCommand {
            epoch: 1,
            sequence,
            tick,
            input: Input {
                buttons,
                axes: sequence,
                analog: true,
            },
        }
    }

    #[test]
    fn high_rate_analog_keeps_latest_sample_without_backlog() {
        let mut pending = PendingInputs::default();
        for tick in 0..1800 {
            for offset in 1..=4 {
                let sequence = tick * 4 + offset;
                assert_eq!(
                    pending.enqueue(sample(sequence, tick, 0)),
                    Ok((offset > 1).then_some(sequence - 1))
                );
                assert_eq!(pending.len(), 1);
            }
            assert_eq!(pending.pop().unwrap().input.axes, tick * 4 + 4);
        }
        assert!(pending.is_empty());
    }

    #[test]
    fn analog_coalescing_preserves_batched_edges_and_their_target_ticks() {
        let mut pending = PendingInputs::default();
        pending.enqueue(sample(1, 10, 1)).unwrap();
        assert_eq!(pending.enqueue(sample(2, 10, 1)), Ok(Some(1)));
        pending.enqueue(sample(3, 11, 0)).unwrap();
        assert_eq!(pending.enqueue(sample(4, 11, 0)), Ok(Some(3)));
        assert_eq!(pending.enqueue(sample(1, 10, 1)), Ok(Some(1)));
        let press = pending.pop().unwrap();
        let release = pending.pop().unwrap();
        assert_eq!(
            (press.input.buttons, press.input.axes, press.tick),
            (1, 2, 10)
        );
        assert_eq!(
            (release.input.buttons, release.input.axes, release.tick),
            (0, 4, 11)
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn fresh_held_state_does_not_inherit_an_old_edges_tick() {
        let mut pending = PendingInputs::default();
        pending.enqueue(sample(1, 0, 1)).unwrap();
        assert_eq!(pending.enqueue(sample(2, 10, 1)), Ok(None));
        assert_eq!(pending.enqueue(sample(3, 11, 1)), Ok(Some(2)));
        let edge = pending.pop().unwrap();
        let held = pending.pop().unwrap();
        assert_eq!((edge.sequence, edge.tick), (1, 0));
        assert_eq!((held.sequence, held.tick), (3, 11));
        assert!(pending.is_empty());
    }

    #[test]
    fn excessive_button_edges_remain_explicitly_bounded() {
        let mut pending = PendingInputs::default();
        for sequence in 1..=60 {
            pending
                .enqueue(sample(sequence, 10, (sequence % 2) as u16))
                .unwrap();
        }
        assert_eq!(pending.enqueue(sample(61, 10, 1)), Err(Rejection::Full));
        assert_eq!(pending.enqueue(sample(62, 10, 0)), Ok(Some(60)));
        assert_eq!(pending.len(), 60);
    }
}
