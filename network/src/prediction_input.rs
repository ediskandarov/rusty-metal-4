//! Local commands survive authoritative corrections to the separate accepted-input buffer.
use crate::input::{ControllerCommand, FUTURE_WINDOW, Input};
use crate::protocol::PREDICTION_DEPTH;
use lightyear::input::input_buffer::INPUT_BUFFER_CAPACITY;
use lightyear::prelude::Tick;
use lightyear::prelude::input::native::{ActionState, NativeBuffer};
use std::collections::VecDeque;

/// Assign samples once to future native ticks. A change in input delay must not
/// rewrite an already queued press/release, or copy its tick/sequence into a gap.
#[derive(Default)]
pub(crate) struct CommandWriter {
    next_tick: u32,
    held: Input,
}

impl CommandWriter {
    pub(crate) fn new(head: u32) -> Self {
        Self {
            next_tick: head,
            held: Input::default(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn write(
        &mut self,
        buffer: &mut NativeBuffer<ControllerCommand>,
        anchor: Tick,
        current: Tick,
        delay: u16,
        epoch: u32,
        sequence: &mut u32,
        next_input: impl FnOnce() -> Input,
    ) -> Result<ActionState<ControllerCommand>, String> {
        if epoch == 0
            || u32::from(delay) > FUTURE_WINDOW
            || usize::from(delay) + usize::from(PREDICTION_DEPTH) + 1 > INPUT_BUFFER_CAPACITY
        {
            return Err("Input delay exceeds the retained command history".into());
        }
        let current_tick = current
            .0
            .checked_sub(anchor.0)
            .and_then(|tick| tick.checked_sub(1))
            .ok_or("Input sampling precedes the match timeline")?;
        let target = current_tick
            .checked_add(u32::from(delay))
            .ok_or("Input target tick overflow")?;
        let native = current
            .0
            .checked_add(u32::from(delay))
            .map(Tick)
            .ok_or("Native input tick overflow")?;
        if target < self.next_tick {
            let queued = buffer
                .get(native)
                .ok_or("A previously queued delayed command is missing")?;
            if queued.0.epoch != epoch
                || queued.0.tick != target
                || queued.0.sequence == 0
                || queued.0.sequence > *sequence
            {
                return Err("A previously queued delayed command is misaligned".into());
            }
            return Ok(queued.clone());
        }
        let gap = target - self.next_tick;
        if gap > FUTURE_WINDOW {
            return Err("Input scheduling exceeded the future window".into());
        }
        let next_tick = target.checked_add(1).ok_or("Input target tick overflow")?;
        sequence
            .checked_add(gap + 1)
            .ok_or("Input command sequence overflow")?;
        let first_native = native.0 - gap;
        if buffer
            .start_tick
            .is_some_and(|start| start.0 > first_native)
        {
            return Err("Input scheduling fell outside the retained command history".into());
        }

        // All bounds are checked before consuming an edge or changing history.
        let sampled = next_input();
        for tick in self.next_tick..=target {
            *sequence += 1;
            let input = if tick == target { sampled } else { self.held };
            buffer.set(
                Tick(first_native + (tick - self.next_tick)),
                ActionState(ControllerCommand {
                    epoch,
                    sequence: *sequence,
                    tick,
                    input,
                }),
            );
        }
        self.next_tick = next_tick;
        self.held = sampled;
        Ok(buffer.get(native).unwrap().clone())
    }
}

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

    fn sample(
        writer: &mut CommandWriter,
        buffer: &mut NativeBuffer<ControllerCommand>,
        sequence: &mut u32,
        tick: u32,
        delay: u16,
        buttons: u16,
    ) -> ActionState<ControllerCommand> {
        let native = Tick(ANCHOR + tick + 1);
        let command = writer
            .write(buffer, Tick(ANCHOR), native, delay, EPOCH, sequence, || {
                input(buttons)
            })
            .unwrap();
        // Lightyear buffers the returned ActionState again after WriteClientInputs.
        buffer.set(native + i32::from(delay), command.clone());
        command
    }

    #[test]
    fn delayed_commands_keep_edges_through_increasing_and_decreasing_delay() {
        let mut writer = CommandWriter::new(0);
        let mut buffer = NativeBuffer::default();
        let mut sequence = 0;
        assert_eq!(
            sample(&mut writer, &mut buffer, &mut sequence, 0, 2, 64)
                .0
                .tick,
            2
        );
        assert_eq!(
            sample(&mut writer, &mut buffer, &mut sequence, 1, 4, 0)
                .0
                .tick,
            5
        );
        assert_eq!(sequence, 6);
        for tick in 2..=4 {
            let native = Tick(ANCHOR + tick + 1);
            let queued = writer
                .write(
                    &mut buffer,
                    Tick(ANCHOR),
                    native,
                    1,
                    EPOCH,
                    &mut sequence,
                    || panic!("reducing input delay must not consume the next button edge"),
                )
                .unwrap();
            assert_eq!(queued.0.tick, tick + 1);
            buffer.set(native + 1, queued);
            assert_eq!(sequence, 6);
        }
        sample(&mut writer, &mut buffer, &mut sequence, 5, 1, 1);
        let expected = [0, 0, 64, 64, 64, 0, 1];
        let local = LocalInputs::default();
        for (tick, buttons) in expected.into_iter().enumerate() {
            let tick = tick as u32;
            let native = Tick(ANCHOR + tick + 1);
            let command = &buffer.get(native).unwrap().0;
            assert_eq!(command.sequence, tick + 1);
            assert_eq!(
                local.get(&buffer, native, EPOCH, tick).unwrap(),
                input(buttons)
            );
        }

        // Transport and the authoritative acceptance queue observe the same tick labels.
        let packet =
            NativeStateSequence::build_from_input_buffer(&buffer, 7, Tick(ANCHOR + 7)).unwrap();
        let mut received = NativeBuffer::<ControllerCommand>::default();
        packet.update_buffer(&mut received, Tick(ANCHOR + 7), STEP);
        let mut authority = crate::input::InputHistory::default();
        for tick in 0..7 {
            let command = &received.get(Tick(ANCHOR + tick + 1)).unwrap().0;
            assert_eq!(
                authority.enqueue(0, command.sequence, command.tick, command.input),
                Ok(tick)
            );
        }
        for (tick, buttons) in expected.into_iter().enumerate() {
            assert_eq!(authority.sample(tick as u32), input(buttons));
        }
    }

    #[test]
    fn delayed_commands_begin_at_the_resumed_head() {
        let mut writer = CommandWriter::new(30);
        let mut buffer = NativeBuffer::default();
        let mut sequence = 80;
        sample(&mut writer, &mut buffer, &mut sequence, 30, 2, 64);
        assert_eq!(buffer.start_tick, Some(Tick(ANCHOR + 31)));
        assert_eq!(buffer.get(Tick(ANCHOR + 31)).unwrap().0.input, input(0));
        assert_eq!(buffer.get(Tick(ANCHOR + 32)).unwrap().0.input, input(0));
        let target = &buffer.get(Tick(ANCHOR + 33)).unwrap().0;
        assert_eq!(
            (target.tick, target.sequence, target.input),
            (32, 83, input(64))
        );
    }

    #[test]
    fn delay_bounds_preserve_the_rollback_window() {
        let max_delay = (INPUT_BUFFER_CAPACITY - usize::from(PREDICTION_DEPTH) - 1)
            .min(FUTURE_WINDOW as usize) as u16;
        let mut writer = CommandWriter::new(0);
        let mut buffer = NativeBuffer::default();
        let mut sequence = 0;
        for tick in 0..=u32::from(PREDICTION_DEPTH) {
            sample(&mut writer, &mut buffer, &mut sequence, tick, 0, 64);
        }
        let current = u32::from(PREDICTION_DEPTH) + 1;
        sample(
            &mut writer,
            &mut buffer,
            &mut sequence,
            current,
            max_delay,
            0,
        );
        let local = LocalInputs::default();
        for tick in current - u32::from(PREDICTION_DEPTH)..=current {
            assert_eq!(
                local
                    .get(&buffer, Tick(ANCHOR + tick + 1), EPOCH, tick)
                    .unwrap(),
                input(64)
            );
        }
        let before_sequence = sequence;
        let before_end = buffer.end_tick();
        assert!(
            writer
                .write(
                    &mut buffer,
                    Tick(ANCHOR),
                    Tick(ANCHOR + current + 2),
                    max_delay + 1,
                    EPOCH,
                    &mut sequence,
                    || panic!("invalid delay consumed an input"),
                )
                .is_err()
        );
        assert_eq!(sequence, before_sequence);
        assert_eq!(buffer.end_tick(), before_end);
    }

    #[test]
    fn command_writer_rejects_missing_or_corrupted_existing_targets() {
        let mut writer = CommandWriter::new(0);
        let mut buffer = NativeBuffer::default();
        let mut sequence = 0;
        sample(&mut writer, &mut buffer, &mut sequence, 0, 2, 64);
        let native = Tick(ANCHOR + 2);
        buffer.set(
            native,
            ActionState(ControllerCommand {
                epoch: EPOCH + 1,
                ..buffer.get(native).unwrap().0
            }),
        );
        assert!(
            writer
                .write(
                    &mut buffer,
                    Tick(ANCHOR),
                    native,
                    0,
                    EPOCH,
                    &mut sequence,
                    || panic!("corrupted history consumed an input")
                )
                .is_err()
        );
        buffer.set_empty(native);
        assert!(
            writer
                .write(
                    &mut buffer,
                    Tick(ANCHOR),
                    native,
                    0,
                    EPOCH,
                    &mut sequence,
                    || panic!("missing history consumed an input")
                )
                .is_err()
        );
        assert_eq!(sequence, 3);
    }

    #[test]
    fn command_writer_overflow_is_atomic() {
        let mut writer = CommandWriter::new(0);
        let mut buffer = NativeBuffer::default();
        let mut sequence = u32::MAX - 1;
        assert!(
            writer
                .write(
                    &mut buffer,
                    Tick(ANCHOR),
                    Tick(ANCHOR + 1),
                    2,
                    EPOCH,
                    &mut sequence,
                    || panic!("sequence overflow consumed an input")
                )
                .is_err()
        );
        assert_eq!(sequence, u32::MAX - 1);
        assert!(buffer.is_empty());
        assert_eq!(writer.next_tick, 0);
        assert!(
            writer
                .write(
                    &mut buffer,
                    Tick(ANCHOR),
                    Tick(u32::MAX),
                    1,
                    EPOCH,
                    &mut sequence,
                    || panic!("tick overflow consumed an input")
                )
                .is_err()
        );
        assert!(buffer.is_empty());
        assert_eq!(writer.next_tick, 0);
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
