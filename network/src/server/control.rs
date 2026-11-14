use super::Match;
use bevy_ecs::prelude::*;
use lightyear::prelude::input::native::{ActionState, NativeBuffer};
use lightyear::prelude::*;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use tm4_network::{
    input::ControllerCommand,
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
    if !game.started && !game.room_only {
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
    // preserves the participant, accepted history and sequence watermark.
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

// Read every newly received native-buffer record before FixedPreUpdate advances
// or trims it. Sampling only ActionState would lose transitions after a stalled frame.
pub(super) fn accept_native_inputs(
    mut game: ResMut<Match>,
    connections: Query<(), With<Connected>>,
    controllers: Query<(
        Entity,
        &ControllerIdentity,
        &ControlledBy,
        &NativeBuffer<ControllerCommand>,
    )>,
) {
    if !game.started || game.ended || game.prediction.anchor.is_none() {
        return;
    }
    let earliest = game.tick;
    let health = game.health.clone();
    for (controller, identity, owner, buffer) in &controllers {
        let Some(slot) = game.participants.resolve(identity) else {
            continue;
        };
        let player = &mut game.controls[slot];
        if player.controller != Some(controller)
            || player.connection != Some(owner.owner)
            || !connections.contains(owner.owner)
        {
            continue;
        }
        let (Some(mut tick), Some((last, _))) = (buffer.start_tick, buffer.get_last_with_tick())
        else {
            continue;
        };
        for _ in 0..buffer.len() {
            if tick > last {
                break;
            }
            if let Some(action) = buffer.get(tick) {
                let command = action.0;
                if player.resume.is_none() && command.sequence > player.received_sequence {
                    player.received_sequence = command.sequence;
                    if command.epoch == 1 && player.receives_live() {
                        health.lock().unwrap().input(usize::from(identity.slot));
                        let queued = player.history.enqueue(
                            earliest,
                            command.sequence,
                            command.tick,
                            command.input,
                        );
                        if queued.is_err() {
                            health
                                .lock()
                                .unwrap()
                                .event("rustymetal4_input_rejected_total");
                        }
                    }
                }
            }
            tick += 1;
        }
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
