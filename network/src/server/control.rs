use super::{Match, STEP};
use bevy_ecs::prelude::*;
use lightyear::input::input_message::{ActionStateSequence, InputMessage, InputTarget};
use lightyear::prelude::input::native::NativeStateSequence;
use lightyear::prelude::input::native::{ActionState, NativeBuffer};
use lightyear::prelude::*;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use tm4_network::{
    input::{ControllerCommand, Input, Rejection, STALE_TICKS},
    protocol::{ControllerIdentity, MAX_PLAYERS, Message, Request, SessionChannel},
};

#[derive(Component)]
pub(super) struct Admission {
    pub(super) opened: Instant,
    pub(super) window: Instant,
    pub(super) messages: u32,
    pub(super) unacknowledged: HashSet<lightyear::transport::packet::message::MessageId>,
}

pub(super) fn send(
    links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    entity: Entity,
    message: &Message,
) {
    if let Ok((_, mut sender)) = links.get_mut(entity) {
        sender.send::<SessionChannel>(message.clone());
    }
}
pub(super) fn detach_connection(
    game: &mut Match,
    slot: usize,
    entity: Entity,
    commands: &mut Commands,
) -> bool {
    let control = &mut game.controls[slot];
    if !control.disconnect(entity) {
        return false;
    }
    if game.started && game.tick == 0 && game.prediction.anchor.is_none() {
        game.prediction = Default::default();
    }
    if !game.started && !game.room_only && game.continuation.is_none() {
        let binding = game.participants.binding(slot);
        game.replace_preparation(binding, commands)
            .expect("open lobby is mutable");
    }
    !game.started
}

pub(super) fn bind_controllers(
    game: &mut Match,
    owners: &Query<&ControlledBy>,
    commands: &mut Commands,
) {
    // Binding data and Lightyear ownership are independent. Replacing a link
    // preserves the participant and accepted history, but clears old native input.
    let Match {
        participants,
        controls,
        ..
    } = game;
    for (slot, player) in controls.iter_mut().enumerate() {
        let Some(owner) = player.connection else {
            continue;
        };
        if let Some(controller) = player.controller {
            if !owners
                .get(controller)
                .is_ok_and(|current| current.owner == owner)
            {
                commands.entity(controller).insert((
                    ControlledBy {
                        owner,
                        lifetime: Lifetime::Persistent,
                    },
                    NativeBuffer::<ControllerCommand>::default(),
                    ActionState::<ControllerCommand>::default(),
                ));
            }
        } else {
            player.controller = Some(
                commands
                    .spawn((
                        participants.binding(slot),
                        ActionState::<ControllerCommand>::default(),
                        Replicate::to_clients(NetworkTarget::All),
                        ControlledBy {
                            owner,
                            lifetime: Lifetime::Persistent,
                        },
                    ))
                    .id(),
            );
        }
    }
}
pub(super) fn reap_closed_links(
    mut commands: Commands,
    links: Query<(Entity, &Unlinked), With<LinkOf>>,
    controllers: Query<(Entity, &ControlledBy)>,
) {
    for (entity, closed) in &links {
        if !matches!(&closed.reason, UnlinkReason::Initial) {
            for (controller, owner) in &controllers {
                if owner.owner == entity && matches!(owner.lifetime, Lifetime::Persistent) {
                    // Required components outlive their filter unless explicitly removed.
                    commands
                        .entity(controller)
                        .remove::<(ControlledBy, ControlledSend)>();
                }
            }
            commands.entity(entity).try_despawn();
        }
    }
}

// Use actual Lightyear acknowledgements as well as reported game progress: a peer
// that sends progress while never acknowledging our reliable messages must not
// retain an unbounded resend history.
pub(super) fn bound_reliable_history(
    mut links: Query<(Entity, &Transport, &mut Admission)>,
    mut commands: Commands,
) {
    for (entity, transport, mut admission) in &mut links {
        let Some(channel) =
            transport.channel_send(lightyear::transport::channel::registry::ChannelKind::of::<
                SessionChannel,
            >())
        else {
            continue;
        };
        admission
            .unacknowledged
            .extend(channel.messages_sent().iter().copied());
        for id in channel.message_acks() {
            admission.unacknowledged.remove(id);
        }
        if admission.unacknowledged.len() > 128 {
            commands.trigger(Unlink {
                entity,
                reason: UnlinkReason::UserRequested(Some(
                    "Reliable message acknowledgement stalled".into(),
                )),
            });
        }
    }
}

pub(super) type ControllerInputs<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static ControllerIdentity,
        &'static ControlledBy,
        &'static ActionState<ControllerCommand>,
        &'static NativeBuffer<ControllerCommand>,
    ),
>;

/// Read the state already applied by Lightyear's FixedPreUpdate. No second queue,
/// tick assignment or command sequence exists on the authority.
pub(super) fn applied_inputs(
    game: &Match,
    tick: Tick,
    connections: &Query<(), With<Connected>>,
    controllers: &ControllerInputs,
) -> Vec<Input> {
    game.controls
        .iter()
        .enumerate()
        .map(|(slot, player)| {
            let Some(controller) = player.controller else {
                return Input::default();
            };
            let Ok((_, identity, owner, action, buffer)) = controllers.get(controller) else {
                return Input::default();
            };
            if !game.participants.human(slot)
                || game.participants.resolve(identity) != Some(slot)
                || player.connection != Some(owner.owner)
                || !connections.contains(owner.owner)
                || !player.receives_live()
                || game
                    .session
                    .as_ref()
                    .is_none_or(|session| session.epoch != action.0.epoch)
                || buffer
                    .last_remote_tick
                    .is_none_or(|last| tick - last >= STALE_TICKS as i32)
            {
                return Input::default();
            }
            action.0.input
        })
        .collect()
}

/// Keep only the still-unsimulated part of the native window. Decode compression
/// before trimming its prefix so a held button keeps its original meaning.
fn forward_inputs(
    states: &NativeStateSequence<ControllerCommand>,
    end: Tick,
    now: Tick,
    epoch: u32,
) -> Result<Option<NativeStateSequence<ControllerCommand>>, Rejection> {
    use lightyear::input::input_buffer::INPUT_BUFFER_CAPACITY;
    if end <= now {
        return Err(Rejection::Late);
    }
    if end - now > INPUT_BUFFER_CAPACITY as i32 || states.len() > INPUT_BUFFER_CAPACITY {
        return Err(Rejection::Future);
    }
    let mut decoded = NativeBuffer::default();
    states.clone().update_buffer(&mut decoded, end, STEP);
    let Some(start) = decoded.start_tick else {
        return Ok(None);
    };
    let start = start.max(now + 1);
    let mut future = NativeBuffer::default();
    for offset in 0..=(end - start).max(-1) {
        let tick = start + offset;
        match decoded.get(tick) {
            Some(action) if action.0.epoch == epoch => future.set(tick, action.clone()),
            Some(_) => return Err(Rejection::Epoch),
            // An absent sample must not refresh the hold timeout.
            None => return Ok(None),
        }
    }
    Ok(NativeStateSequence::build_from_input_buffer(
        &future,
        future.len(),
        end,
    ))
}

type NativeInputReceivers<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static mut MessageReceiver<InputMessage<NativeStateSequence<ControllerCommand>>>,
    ),
    With<Connected>,
>;

/// This runs in Lightyear's validation hook before its buffer is updated.
/// Match membership/epoch are admission rules, not an alternative scheduler.
pub(super) fn validate_inputs(
    game: Res<Match>,
    timeline: Res<LocalTimeline>,
    controllers: Query<(&ControllerIdentity, &ControlledBy)>,
    mut receivers: NativeInputReceivers,
) {
    let epoch = game.session.as_ref().map(|session| session.epoch);
    for (connection, mut receiver) in &mut receivers {
        receiver.retain_messages(|message| {
            message.inputs.retain_mut(|data| {
                let InputTarget::Entity(entity) = data.target else {
                    return false;
                };
                let Ok((identity, owner)) = controllers.get(entity) else {
                    return false;
                };
                let Some(slot) = game.participants.resolve(identity) else {
                    return false;
                };
                let player = &game.controls[slot];
                if !game.started
                    || game.ended
                    || game.prediction.anchor.is_none()
                    || !game.participants.human(slot)
                    || player.controller != Some(entity)
                    || owner.owner != connection
                    || player.connection != Some(connection)
                    || !player.receives_live()
                {
                    return false;
                }
                let Some(epoch) = epoch else {
                    return false;
                };
                match forward_inputs(&data.states, message.end_tick, timeline.tick(), epoch) {
                    Ok(Some(states)) => {
                        data.states = states;
                        game.health.lock().unwrap().input(slot);
                        true
                    }
                    Err(reason) => {
                        game.health.lock().unwrap().input_rejected(slot, reason);
                        false
                    }
                    Ok(None) => false,
                }
            });
            true
        });
    }
}

pub(super) fn receive_requests(
    game: &mut Match,
    links: &mut Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
    receivers: &mut Query<(Entity, &mut MessageReceiver<Request>, &mut Admission)>,
    link_states: &Query<Option<&Unlinked>, With<LinkOf>>,
    commands: &mut Commands,
) -> Vec<(Entity, Request)> {
    let mut lobby_changed = false;
    game.retired_connections
        .retain(|entity| links.contains(*entity));
    for slot in game.participants.all_slots().collect::<Vec<_>>() {
        if let Some(entity) = game.controls[slot]
            .connection
            .filter(|entity| !links.contains(*entity))
        {
            if game.started && game.participants.joining(slot) {
                let identity = game.participants.binding(slot);
                game.cancel_admission(identity, links, commands);
            } else {
                lobby_changed |= detach_connection(game, slot, entity, commands);
            }
        }
    }

    if lobby_changed {
        game.broadcast_lobby(links);
    }

    let mut requests = Vec::new();
    let active_links = link_states
        .iter()
        .filter(|closed| closed.is_none_or(|state| matches!(&state.reason, UnlinkReason::Initial)))
        .count();
    let now = Instant::now();
    for (entity, mut receiver, mut admission) in receivers {
        if now.duration_since(admission.window) >= Duration::from_secs(1) {
            admission.window = now;
            admission.messages = 0;
        }
        let known = game.controls.iter().any(|p| p.connection == Some(entity));
        let stalled = game
            .controls
            .iter()
            .enumerate()
            .find(|(_, p)| p.connection == Some(entity))
            .and_then(|(slot, p)| {
                if let Some(attempt) = &p.resume {
                    return attempt
                        .timeout(now)
                        .then_some("Snapshot reconnect stopped or expired. Retry this match.");
                }
                (!game.participants.joining(slot) && game.tick.saturating_sub(p.progress_tick) > 90)
                    .then_some("Client session progress timed out.")
            });
        let unidentified = !known && now.duration_since(admission.opened) > Duration::from_secs(10);
        let full = !known && active_links > MAX_PLAYERS + 5 && links.contains(entity);
        if let Some(reason) = full
            .then_some("Connection capacity reached.")
            .or(stalled)
            .or(unidentified.then_some("Unidentified connection timed out."))
        {
            eprintln!("{reason}");
            commands.trigger(Unlink {
                entity,
                reason: UnlinkReason::UserRequested(Some(reason.into())),
            });
            continue;
        }
        for request in receiver.receive() {
            admission.messages += 1;
            if admission.messages > 120 {
                commands.trigger(Unlink {
                    entity,
                    reason: UnlinkReason::UserRequested(Some(
                        "Session message rate exceeded".into(),
                    )),
                });
                break;
            }
            requests.push((entity, request));
        }
    }
    requests
}
#[cfg(test)]
mod tests {
    use super::*;
    use lightyear::input::input_buffer::INPUT_BUFFER_CAPACITY;

    fn sequence(epoch: u32, start: u32, buttons: &[u16]) -> NativeStateSequence<ControllerCommand> {
        let mut buffer = NativeBuffer::default();
        for (offset, &buttons) in buttons.iter().enumerate() {
            buffer.set(
                Tick(start + offset as u32),
                ActionState(ControllerCommand {
                    epoch,
                    input: Input {
                        buttons,
                        ..Default::default()
                    },
                }),
            );
        }
        NativeStateSequence::build_from_input_buffer(
            &buffer,
            buttons.len(),
            Tick(start + buttons.len() as u32 - 1),
        )
        .unwrap()
    }
    fn decode(
        states: NativeStateSequence<ControllerCommand>,
        end: u32,
    ) -> NativeBuffer<ControllerCommand> {
        let mut buffer = NativeBuffer::default();
        states.update_buffer(&mut buffer, Tick(end), STEP);
        buffer
    }

    #[test]
    fn validation_trims_played_ticks_without_rescheduling_a_late_tap() {
        let states = sequence(1, 100, &[0x40, 0, 0, 0x40]);
        let future = forward_inputs(&states, Tick(103), Tick(101), 1)
            .unwrap()
            .unwrap();
        let buffer = decode(future, 103);
        assert_eq!(buffer.start_tick, Some(Tick(102)));
        assert_eq!(buffer.get(Tick(102)).unwrap().0.input.buttons, 0);
        assert_eq!(buffer.get(Tick(103)).unwrap().0.input.buttons, 0x40);
        assert!(matches!(
            forward_inputs(&states, Tick(103), Tick(103), 1),
            Err(Rejection::Late)
        ));
        let held = forward_inputs(&sequence(1, 100, &[0x40; 4]), Tick(103), Tick(101), 1)
            .unwrap()
            .unwrap();
        assert_eq!(
            decode(held, 103).get(Tick(102)).unwrap().0.input.buttons,
            0x40
        );
    }

    #[test]
    fn validation_fences_epoch_and_bounds_native_history() {
        assert!(matches!(
            forward_inputs(&sequence(1, 101, &[0x40]), Tick(101), Tick(100), 2),
            Err(Rejection::Epoch)
        ));
        assert!(matches!(
            forward_inputs(&sequence(0, 101, &[0x40]), Tick(101), Tick(100), 2),
            Err(Rejection::Epoch)
        ));
        let end = 101 + INPUT_BUFFER_CAPACITY as u32;
        assert!(matches!(
            forward_inputs(&sequence(1, end, &[0x40]), Tick(end), Tick(100), 1),
            Err(Rejection::Future)
        ));
    }

    #[test]
    fn native_overlap_and_reordering_do_not_repeat_or_rewrite_accepted_samples() {
        let mut buffer = decode(sequence(1, 101, &[0x40, 0, 0x40]), 103);
        sequence(1, 101, &[0, 0x40]).update_buffer(&mut buffer, Tick(102), STEP);
        sequence(1, 101, &[0x40, 0, 0x40]).update_buffer(&mut buffer, Tick(103), STEP);
        assert_eq!(buffer.last_remote_tick, Some(Tick(103)));
        assert_eq!(buffer.get(Tick(101)).unwrap().0.input.buttons, 0x40);
        assert_eq!(buffer.get(Tick(102)).unwrap().0.input.buttons, 0);
        assert_eq!(buffer.get(Tick(103)).unwrap().0.input.buttons, 0x40);
        assert_eq!(buffer.len(), 3);
    }
}
