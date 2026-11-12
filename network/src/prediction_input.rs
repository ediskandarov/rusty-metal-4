//! Local commands survive authoritative corrections to the separate accepted-input buffer.
use crate::input::{ControllerCommand, Input};
use crate::protocol::PREDICTION_DEPTH;
use lightyear::prelude::Tick;
use lightyear::prelude::input::native::NativeBuffer;
use std::collections::VecDeque;

#[derive(Default)]
pub(crate) struct LocalInputs {
    // These ticks were simulated during reconnect before local commands existed.
    // Keep the actual samples independently of Lightyear's disposable predictions.
    warmup: VecDeque<(u32, Input)>,
}

impl LocalInputs {
    pub(crate) fn remember_warmup(&mut self, tick: u32, input: Input) -> Result<(), String> {
        if self.warmup.len() == usize::from(PREDICTION_DEPTH) {
            return Err("Reconnect inputs exceeded the retained prediction window".into());
        }
        self.warmup.push_back((tick, input));
        Ok(())
    }

    pub(crate) fn discard_confirmed(&mut self, confirmed: u32) {
        // Confirmed counts completed steps; input tick N advances the world to N + 1.
        self.warmup.retain(|(tick, _)| *tick >= confirmed);
    }

    pub(crate) fn get(
        &self,
        commands: &NativeBuffer<ControllerCommand>,
        native_tick: Tick,
        epoch: u32,
        tick: u32,
    ) -> Result<Input, String> {
        if let Some((_, input)) = self.warmup.iter().find(|(saved, _)| *saved == tick) {
            return Ok(*input);
        }
        // ActionState can remain stale when Lightyear cannot restore an exact tick.
        // Require the sampled command itself, during both forward steps and replay.
        let command = commands.get(native_tick).ok_or_else(|| {
            format!(
                "The native local command history has a missing tick ({native_tick:?}, start {:?})",
                commands.start_tick
            )
        })?;
        if command.0.tick != tick || command.0.epoch != epoch {
            return Err("Lightyear lost the predicted local input for a fixed tick".into());
        }
        Ok(command.0.input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lightyear::input::input_message::ActionStateSequence;
    use lightyear::prelude::input::native::{ActionState, NativeStateSequence};
    use std::time::Duration;

    const STEP: Duration = Duration::from_nanos(33_333_333);
    const EPOCH: u32 = 7;
    const ANCHOR: u32 = 100;

    fn input(buttons: u16) -> Input {
        Input {
            buttons,
            ..Default::default()
        }
    }

    fn command(tick: u32, input: Input) -> ActionState<ControllerCommand> {
        ActionState(ControllerCommand {
            epoch: EPOCH,
            sequence: tick + 1,
            tick,
            input,
        })
    }

    fn correct(buffer: &mut NativeBuffer<Input>, tick: Tick, input: Input) {
        let mut authority = NativeBuffer::<Input>::default();
        authority.set(tick, ActionState(input));
        let message = NativeStateSequence::build_from_input_buffer(&authority, 1, tick).unwrap();
        assert_eq!(message.update_buffer(buffer, tick, STEP), Some(tick));
    }

    #[test]
    fn authoritative_mismatch_clips_predictions_but_preserves_local_command_edges() {
        let local = LocalInputs::default();
        let mut accepted = NativeBuffer::<Input>::default();
        let mut commands = NativeBuffer::<ControllerCommand>::default();
        accepted.last_remote_tick = Some(Tick(ANCHOR));
        // Hold, press, release: replay must preserve each distinct sampled command.
        for (tick, buttons) in [1, 2, 0].into_iter().enumerate() {
            let tick = tick as u32;
            let native = Tick(ANCHOR + tick + 1);
            accepted.set(native, ActionState(input(buttons)));
            commands.set(native, command(tick, input(buttons)));
        }
        correct(&mut accepted, Tick(ANCHOR + 1), input(0));
        assert_eq!(accepted.last_remote_tick, Some(Tick(ANCHOR + 1)));
        assert_eq!(accepted.get(Tick(ANCHOR + 1)), Some(&ActionState(input(0))));
        // This is the old replay branch's failure: the next tick is intentionally gone.
        assert!(accepted.get(Tick(ANCHOR + 2)).is_none());
        assert!(accepted.get(Tick(ANCHOR + 3)).is_none());
        for (tick, buttons) in [(1, 2), (2, 0)] {
            let native = Tick(ANCHOR + tick + 1);
            let replayed = local.get(&commands, native, EPOCH, tick).unwrap();
            assert_eq!(replayed, input(buttons));
            accepted.set(native, ActionState(replayed));
        }
        // Rebuilding predictions leaves the already accepted correction immutable.
        assert_eq!(accepted.get(Tick(ANCHOR + 1)), Some(&ActionState(input(0))));
        assert_eq!(accepted.last_remote_tick, Some(Tick(ANCHOR + 1)));
    }

    #[test]
    fn reconnect_samples_survive_a_later_correction_without_inventing_commands() {
        let mut local = LocalInputs::default();
        let mut accepted = NativeBuffer::<Input>::default();
        let mut commands = NativeBuffer::<ControllerCommand>::default();
        accepted.last_remote_tick = Some(Tick(ANCHOR));
        for tick in 0..u32::from(PREDICTION_DEPTH) {
            let native = Tick(ANCHOR + tick + 1);
            let sample = input((tick % 2) as u16);
            accepted.set(native, ActionState(sample));
            local.remember_warmup(tick, sample).unwrap();
            // The native buffer can contain pre-handoff default samples, not commands.
            commands.set(native, ActionState::default());
        }
        assert!(local.remember_warmup(99, input(3)).is_err());
        correct(&mut accepted, Tick(ANCHOR + 1), input(3));
        for tick in 1..u32::from(PREDICTION_DEPTH) {
            let native = Tick(ANCHOR + tick + 1);
            assert!(accepted.get(native).is_none());
            assert_eq!(
                local.get(&commands, native, EPOCH, tick).unwrap(),
                input((tick % 2) as u16)
            );
        }
        // The rollback floor is a completed world tick: its next input stays replayable.
        local.discard_confirmed(1);
        assert_eq!(local.warmup.front().map(|(tick, _)| *tick), Some(1));
        assert!(local.get(&commands, Tick(ANCHOR + 1), EPOCH, 0).is_err());
        assert_eq!(
            local.get(&commands, Tick(ANCHOR + 2), EPOCH, 1).unwrap(),
            input(1)
        );
        local.discard_confirmed(u32::from(PREDICTION_DEPTH));
        assert!(local.warmup.is_empty());
        // Once past warmup, a newly sampled command supplies both forward and replay input.
        let tick = u32::from(PREDICTION_DEPTH);
        let native = Tick(ANCHOR + tick + 1);
        commands.set(native, command(tick, input(4)));
        assert_eq!(local.get(&commands, native, EPOCH, tick).unwrap(), input(4));
    }

    #[test]
    fn missing_or_misaligned_local_commands_remain_errors() {
        let local = LocalInputs::default();
        let mut commands = NativeBuffer::<ControllerCommand>::default();
        let native = Tick(ANCHOR + 2);
        // A previous command must never stand in for a missing tick.
        commands.set(native - 1u32, command(0, input(1)));
        assert!(local.get(&commands, native, EPOCH, 1).is_err());
        commands.set(native, command(0, input(1)));
        assert!(local.get(&commands, native, EPOCH, 1).is_err());
        commands.set(native, command(1, input(1)));
        assert!(local.get(&commands, native, EPOCH + 1, 1).is_err());
    }
}
